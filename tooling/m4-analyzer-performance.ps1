param(
    [ValidateRange(1, 5)]
    [int]$MeasuredRuns = 3,
    [switch]$FinalizeCheckpoint
)

$ErrorActionPreference = 'Stop'
function Write-Utf8NoBom {
    param([string]$Path, [string]$Value)
    [System.IO.File]::WriteAllText($Path, $Value, [System.Text.UTF8Encoding]::new($false))
}
function Get-FileSha256 {
    param([string]$Path)
    $stream = [IO.File]::OpenRead($Path)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        return (($algorithm.ComputeHash($stream) | ForEach-Object { $_.ToString('x2') }) -join '')
    }
    finally {
        $algorithm.Dispose()
        $stream.Dispose()
    }
}
$workspace = Split-Path -Parent $PSScriptRoot
$artifactRoot = Join-Path $workspace 'artifacts\m4'
$uv = Join-Path $env:USERPROFILE '.cache\cybermuse-tools\uv-0.12.5\uv.exe'
$analyzer = Join-Path $artifactRoot 'analyzer-dist\cybermuse-analyzer\cybermuse-analyzer.exe'
$spleeter = Join-Path $artifactRoot 'spleeter-engine-dist\cybermuse-spleeter-engine\cybermuse-spleeter-engine.exe'
$ffmpeg = Join-Path $artifactRoot 'smoke-tools\ffmpeg-bin\ffmpeg.exe'
$ffprobe = Join-Path $artifactRoot 'smoke-tools\ffmpeg-bin\ffprobe.exe'
$modelRoot = Join-Path $env:LOCALAPPDATA 'CyberMuse\models'

foreach ($path in @($uv, $analyzer, $spleeter, $ffmpeg, $ffprobe, $modelRoot)) {
    if (-not (Test-Path -LiteralPath $path)) {
        throw "Required M4 artifact is missing: $path"
    }
}

$stagingParent = [IO.Path]::GetFullPath((Join-Path $artifactRoot 'performance-work\staging'))
if (Test-Path -LiteralPath $stagingParent) {
    if (Get-Process -Name cybermuse-analyzer, cybermuse-spleeter-engine -ErrorAction SilentlyContinue) {
        throw 'Refusing to clean performance staging while an analyzer process is active'
    }
    foreach ($directory in Get-ChildItem -LiteralPath $stagingParent -Directory) {
        $resolved = [IO.Path]::GetFullPath($directory.FullName)
        $isChild = $resolved.StartsWith(
            $stagingParent + [IO.Path]::DirectorySeparatorChar,
            [StringComparison]::OrdinalIgnoreCase
        )
        if (-not $isChild -or $directory.Name -notmatch '^[a-f0-9-]{36}$') {
            throw 'Refusing to remove an unexpected performance staging directory'
        }
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}

function Get-Percentile {
    param([double[]]$Values, [double]$Percentile)
    if ($Values.Count -eq 0) { return 0.0 }
    $sorted = $Values | Sort-Object
    $position = ($sorted.Count - 1) * $Percentile
    $lower = [math]::Floor($position)
    $upper = [math]::Ceiling($position)
    if ($lower -eq $upper) { return [double]$sorted[$lower] }
    return [double]$sorted[$lower] + ($position - $lower) * ([double]$sorted[$upper] - [double]$sorted[$lower])
}

function New-PerformanceRequest {
    param([int]$DurationSeconds)
    $arguments = @(
        'run', '--project', 'analyzer', 'python', 'analyzer/scripts/create_m4_performance_request.py',
        '--artifact-root', $artifactRoot,
        '--model-root', $modelRoot,
        '--ffmpeg', $ffmpeg,
        '--ffprobe', $ffprobe,
        '--spleeter-engine', $spleeter,
        '--duration-seconds', $DurationSeconds
    )
    $request = & $uv @arguments
    if ($LASTEXITCODE -ne 0) { throw "Request generation failed for $DurationSeconds seconds" }
    return ($request | Select-Object -Last 1).Trim()
}

function Get-DirectoryBytes {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return [long]0 }
    return [long]((Get-ChildItem -LiteralPath $Path -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum)
}

function Invoke-AnalyzerMeasurement {
    param([int]$DurationSeconds, [int]$RunIndex, [bool]$Warmup)
    $requestPath = New-PerformanceRequest -DurationSeconds $DurationSeconds
    $stagingPath = Split-Path -Parent $requestPath
    $stdoutPath = Join-Path $stagingPath 'process.stdout.ndjson'
    $stderrPath = Join-Path $stagingPath 'process.stderr.txt'
    $startUtc = [datetime]::UtcNow.AddSeconds(-1)
    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $analyzer
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    if ($requestPath.Contains('"')) { throw 'Unexpected quote in analyzer request path' }
    $startInfo.Arguments = '"analyze" "--request" "' + $requestPath + '"'
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    $timer = [System.Diagnostics.Stopwatch]::StartNew()
    if (-not $process.Start()) { throw 'Packaged analyzer did not start' }
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $cpuByPid = @{}
    $cpuSamples = [System.Collections.Generic.List[double]]::new()
    $memorySamples = [System.Collections.Generic.List[double]]::new()
    $diskPeak = [long]0
    $lastSampleMs = [double]0
    $lastCpuMs = [double]0
    $logicalProcessors = [Environment]::ProcessorCount
    $names = @('cybermuse-analyzer', 'cybermuse-spleeter-engine', 'ffmpeg', 'ffprobe')
    while (-not $process.HasExited) {
        Start-Sleep -Milliseconds 200
        $current = @(Get-Process -Name $names -ErrorAction SilentlyContinue | Where-Object {
            try { $_.StartTime.ToUniversalTime() -ge $startUtc } catch { $false }
        })
        $workingSet = [double]0
        foreach ($item in $current) {
            $cpuByPid[$item.Id] = $item.TotalProcessorTime.TotalMilliseconds
            $workingSet += $item.WorkingSet64
        }
        $cpuTotal = [double](($cpuByPid.Values | Measure-Object -Sum).Sum)
        $elapsedDelta = [math]::Max(1.0, $timer.Elapsed.TotalMilliseconds - $lastSampleMs)
        $cpuDelta = [math]::Max(0.0, $cpuTotal - $lastCpuMs)
        $cpuSamples.Add(100.0 * $cpuDelta / ($elapsedDelta * $logicalProcessors))
        $memorySamples.Add($workingSet)
        $lastSampleMs = $timer.Elapsed.TotalMilliseconds
        $lastCpuMs = $cpuTotal
        $diskPeak = [math]::Max($diskPeak, (Get-DirectoryBytes -Path $stagingPath))
    }
    $process.WaitForExit()
    $stdout = $stdoutTask.GetAwaiter().GetResult()
    $stderr = $stderrTask.GetAwaiter().GetResult()
    $timer.Stop()
    [IO.File]::WriteAllText($stdoutPath, $stdout, [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText($stderrPath, $stderr, [Text.UTF8Encoding]::new($false))
    if ($process.ExitCode -ne 0) {
        throw "Analyzer run failed: duration=$DurationSeconds run=$RunIndex exit=$($process.ExitCode)"
    }
    $terminal = ($stdout -split "`r?`n" | Where-Object { $_ } | Select-Object -Last 1 | ConvertFrom-Json)
    if ($terminal.type -ne 'completed') { throw 'Analyzer did not emit completed terminal' }
    $finalBytes = [long]((Get-ChildItem -LiteralPath $stagingPath -File | Where-Object { $_.Name -in @('analysis.json', 'reference-track.json', 'vocals.wav', 'instrumental.wav') } | Measure-Object Length -Sum).Sum)
    $result = [ordered]@{
        durationSeconds = $DurationSeconds
        runIndex = $RunIndex
        warmup = $Warmup
        wallTimeMs = [math]::Round($timer.Elapsed.TotalMilliseconds, 3)
        realtimeFactor = [math]::Round($timer.Elapsed.TotalSeconds / $DurationSeconds, 6)
        cpuPercentP50 = [math]::Round((Get-Percentile -Values $cpuSamples.ToArray() -Percentile 0.50), 3)
        cpuPercentP95 = [math]::Round((Get-Percentile -Values $cpuSamples.ToArray() -Percentile 0.95), 3)
        workingSetBytesP50 = [long](Get-Percentile -Values $memorySamples.ToArray() -Percentile 0.50)
        workingSetBytesP95 = [long](Get-Percentile -Values $memorySamples.ToArray() -Percentile 0.95)
        workingSetBytesPeak = [long](($memorySamples | Measure-Object -Maximum).Maximum)
        stagingBytesPeak = $diskPeak
        temporaryBytesPeak = [long][math]::Max(0, $diskPeak - $finalBytes)
        finalArtifactBytes = $finalBytes
        stderrBytes = [Text.Encoding]::UTF8.GetByteCount($stderr)
        stdoutLines = @($stdout -split "`r?`n" | Where-Object { $_ }).Count
    }
    $resolvedStaging = [IO.Path]::GetFullPath($stagingPath)
    $expectedParent = [IO.Path]::GetFullPath((Join-Path $artifactRoot 'performance-work\staging'))
    if (-not $resolvedStaging.StartsWith($expectedParent + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Refusing to remove unexpected performance staging path'
    }
    Remove-Item -LiteralPath $resolvedStaging -Recurse -Force
    return [pscustomobject]$result
}

$coldStartMeasurements = @()
foreach ($index in 1..5) {
    $coldTimer = [Diagnostics.Stopwatch]::StartNew()
    $versionOutput = & $analyzer --version --json 2>$null
    $coldTimer.Stop()
    if ($LASTEXITCODE -ne 0 -or -not ($versionOutput | Select-Object -Last 1 | ConvertFrom-Json).protocolMajor) {
        throw 'Packaged analyzer cold start/version probe failed'
    }
    $coldStartMeasurements += $coldTimer.Elapsed.TotalMilliseconds
}
$coldStart = [ordered]@{
    runs = $coldStartMeasurements.Count
    wallTimeMsP50 = [math]::Round((Get-Percentile -Values $coldStartMeasurements -Percentile 0.50), 3)
    wallTimeMsP95 = [math]::Round((Get-Percentile -Values $coldStartMeasurements -Percentile 0.95), 3)
}

$runs = [System.Collections.Generic.List[object]]::new()
$warmup = Invoke-AnalyzerMeasurement -DurationSeconds 30 -RunIndex 0 -Warmup $true
if ($FinalizeCheckpoint) {
    $checkpointPath = Join-Path $artifactRoot 'analyzer-performance-checkpoint.json'
    $checkpoint = Get-Content -Raw -Encoding UTF8 -LiteralPath $checkpointPath | ConvertFrom-Json
    if ($checkpoint.schemaVersion -ne 1 -or @($checkpoint.completedRuns).Count -ne (3 * $MeasuredRuns)) {
        throw 'M4 performance checkpoint is incomplete or unsupported'
    }
    foreach ($run in $checkpoint.completedRuns) { $runs.Add($run) }
    foreach ($duration in @(180, 300, 600)) {
        if (@($runs | Where-Object durationSeconds -eq $duration).Count -ne $MeasuredRuns) {
            throw 'M4 performance checkpoint duration distribution is invalid'
        }
    }
    Write-Host 'M4 analyzer performance: finalizing complete checkpoint'
}
else {
    foreach ($duration in @(180, 300, 600)) {
        for ($index = 1; $index -le $MeasuredRuns; $index++) {
            Write-Host "M4 analyzer performance: $duration seconds, run $index/$MeasuredRuns"
            $runs.Add((Invoke-AnalyzerMeasurement -DurationSeconds $duration -RunIndex $index -Warmup $false))
            Write-Utf8NoBom -Path (Join-Path $artifactRoot 'analyzer-performance-checkpoint.json') -Value (([ordered]@{
                schemaVersion = 1
                completedRuns = $runs
            }) | ConvertTo-Json -Depth 6)
        }
    }
}

$summaries = foreach ($duration in @(180, 300, 600)) {
    $group = @($runs | Where-Object durationSeconds -eq $duration)
    [ordered]@{
        durationSeconds = $duration
        runs = $group.Count
        wallTimeMsP50 = [math]::Round((Get-Percentile -Values @($group.wallTimeMs) -Percentile 0.50), 3)
        wallTimeMsP95 = [math]::Round((Get-Percentile -Values @($group.wallTimeMs) -Percentile 0.95), 3)
        realtimeFactorP50 = [math]::Round((Get-Percentile -Values @($group.realtimeFactor) -Percentile 0.50), 6)
        realtimeFactorP95 = [math]::Round((Get-Percentile -Values @($group.realtimeFactor) -Percentile 0.95), 6)
        workingSetBytesP95 = [long](Get-Percentile -Values @($group.workingSetBytesP95) -Percentile 0.95)
        workingSetBytesPeak = [long](($group.workingSetBytesPeak | Measure-Object -Maximum).Maximum)
        temporaryBytesPeak = [long](($group.temporaryBytesPeak | Measure-Object -Maximum).Maximum)
        finalArtifactBytes = [long](($group.finalArtifactBytes | Measure-Object -Maximum).Maximum)
    }
}

$thresholds = [ordered]@{
    coldStartWallTimeMsP95Maximum = 3000
    realtimeFactorP95Maximum = 0.35
    workingSetBytesPeakMaximum = 1879048192
    temporaryBytesPeakMaximum = 1181116006
    combinedSidecarBundleBytesMaximum = 1342177280
    stderrBytesMaximum = 0
}
$analyzerBundleBytes = Get-DirectoryBytes -Path (Split-Path -Parent $analyzer)
$spleeterBundleBytes = Get-DirectoryBytes -Path (Split-Path -Parent $spleeter)
$violations = [System.Collections.Generic.List[string]]::new()
if ($coldStart.wallTimeMsP95 -gt $thresholds.coldStartWallTimeMsP95Maximum) {
    $violations.Add('Packaged analyzer cold start exceeded the accepted P95 budget')
}
foreach ($summary in $summaries) {
    if ($summary.realtimeFactorP95 -gt $thresholds.realtimeFactorP95Maximum) {
        $violations.Add("Analyzer realtime factor exceeded the accepted P95 budget for $($summary.durationSeconds) seconds")
    }
    if ($summary.workingSetBytesPeak -gt $thresholds.workingSetBytesPeakMaximum) {
        $violations.Add("Analyzer peak working set exceeded the accepted budget for $($summary.durationSeconds) seconds")
    }
    if ($summary.temporaryBytesPeak -gt $thresholds.temporaryBytesPeakMaximum) {
        $violations.Add("Analyzer temporary disk exceeded the accepted budget for $($summary.durationSeconds) seconds")
    }
}
if (@($runs | Where-Object stderrBytes -gt $thresholds.stderrBytesMaximum).Count -ne 0) {
    $violations.Add('Analyzer wrote unexpected stderr during a measured run')
}
if (($analyzerBundleBytes + $spleeterBundleBytes) -gt $thresholds.combinedSidecarBundleBytesMaximum) {
    $violations.Add('Combined sidecar bundles exceeded the accepted distribution budget')
}

$computer = Get-CimInstance Win32_ComputerSystem
$processor = Get-CimInstance Win32_Processor | Select-Object -First 1
$operatingSystem = Get-CimInstance Win32_OperatingSystem
$report = [ordered]@{
    schemaVersion = 1
    testCase = 'TC-ANPERF-001'
    cpuOnly = $true
    status = if ($violations.Count -eq 0) { 'passed' } else { 'failed' }
    violations = $violations
    thresholds = $thresholds
    coldStart = $coldStart
    warmup = $warmup
    measuredRunsPerDuration = $MeasuredRuns
    runs = $runs
    summaries = $summaries
    environment = [ordered]@{
        os = $operatingSystem.Caption
        osBuild = $operatingSystem.BuildNumber
        cpu = $processor.Name.Trim()
        logicalProcessors = [Environment]::ProcessorCount
        ramBytes = [long]$computer.TotalPhysicalMemory
        python = '3.12.14 packaged by PyInstaller 6.15.0'
        analyzerBuild = 'onedir release-candidate'
    }
    package = [ordered]@{
        analyzerExeBytes = (Get-Item -LiteralPath $analyzer).Length
        analyzerBundleBytes = $analyzerBundleBytes
        analyzerSha256 = Get-FileSha256 -Path $analyzer
        spleeterBundleBytes = $spleeterBundleBytes
        spleeterExeSha256 = Get-FileSha256 -Path $spleeter
    }
    models = @(
        [ordered]@{ modelId = 'spleeter-2stems'; version = '1.4.0'; sha256 = 'f3a90b39dd2874269e8b05a48a86745df897b848c61f3958efc80a39152bd692' },
        [ordered]@{ modelId = 'swiftf0'; version = '0.1.2'; sha256 = '212715116025a490be70db0afda8fb27b1eadf267a3b18ed8df4866c1574e717' }
    )
    ffmpeg = 'n9.0.1-6-g9d4ca21220 win64 LGPL shared'
}
Write-Utf8NoBom -Path (Join-Path $artifactRoot 'analyzer-performance.json') -Value ($report | ConvertTo-Json -Depth 8)
if ($violations.Count -ne 0) {
    throw ($violations -join '; ')
}
Write-Host 'M4 analyzer performance: PASS'
