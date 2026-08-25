param(
    [Parameter(Mandatory = $true)]
    [string]$PackageRoot,
    [Parameter(Mandatory = $true)]
    [string]$EvidencePath,
    [switch]$SkipDefender
)

$ErrorActionPreference = "Stop"
function Get-FileSha256 {
    param([string]$Path)
    $stream = [IO.File]::OpenRead($Path)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return (($algorithm.ComputeHash($stream) | ForEach-Object { $_.ToString("x2") }) -join "") }
    finally { $algorithm.Dispose(); $stream.Dispose() }
}
$package = [IO.Path]::GetFullPath($PackageRoot)
$packageManifestPath = Join-Path $package "package-manifest.json"
$analyzer = Join-Path $package "resources\analyzer\cybermuse-analyzer.exe"
$ffmpeg = Join-Path $package "resources\ffmpeg\ffmpeg.exe"
$ffprobe = Join-Path $package "resources\ffmpeg\ffprobe.exe"
$spleeterEngine = Join-Path $package "resources\spleeter-engine\cybermuse-spleeter-engine.exe"
$spleeterModel = Join-Path $package "models\spleeter-2stems\1.4.0\2stems.tar.gz"
$swiftModel = Join-Path $package "models\swiftf0\0.1.2\swift_f0-0.1.2-py3-none-any.whl"
$input = Join-Path $package "smoke-input.wav"
foreach ($path in @($analyzer, $ffmpeg, $ffprobe, $spleeterEngine, $spleeterModel, $swiftModel, $input)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Clean-host package is incomplete" }
}
$packageManifest = Get-Content -Raw -Encoding UTF8 -LiteralPath $packageManifestPath | ConvertFrom-Json
if ($packageManifest.schemaVersion -ne 1) { throw "Unsupported clean-host package manifest" }
foreach ($file in $packageManifest.files) {
    $candidate = [IO.Path]::GetFullPath((Join-Path $package ($file.relativePath.Replace("/", "\"))))
    if (-not $candidate.StartsWith($package + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Clean-host package manifest contains an unsafe path"
    }
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf) -or
        (Get-Item -LiteralPath $candidate).Length -ne $file.bytes -or
        (Get-FileSha256 -Path $candidate) -ne $file.sha256) {
        throw "Clean-host package integrity validation failed"
    }
}

$os = Get-CimInstance Win32_OperatingSystem
if ($os.Caption -notmatch "Windows 11" -or $os.OSArchitecture -notmatch "64") {
    throw "TC-BUILD-001 requires Windows 11 x64"
}
$prerequisites = [ordered]@{
    pythonOnPath = [bool](Get-Command python.exe -ErrorAction SilentlyContinue)
    cargoOnPath = [bool](Get-Command cargo.exe -ErrorAction SilentlyContinue)
    uvOnPath = [bool](Get-Command uv.exe -ErrorAction SilentlyContinue)
}
if ($prerequisites.pythonOnPath -or $prerequisites.cargoOnPath -or $prerequisites.uvOnPath) {
    throw "TC-BUILD-001 requires a clean host without CyberMuse development tools on PATH"
}

$defender = [ordered]@{ skipped = [bool]$SkipDefender; enabled = $null; signatureVersion = $null; packageThreatCount = $null }
if (-not $SkipDefender) {
    $status = Get-MpComputerStatus
    $defender.enabled = [bool]($status.AMServiceEnabled -and $status.AntivirusEnabled)
    $defender.signatureVersion = $status.AntivirusSignatureVersion
    if (-not $defender.enabled) { throw "Microsoft Defender is not enabled" }
    Start-MpScan -ScanType CustomScan -ScanPath $package
    $packageThreats = @(Get-MpThreatDetection -ErrorAction SilentlyContinue | Where-Object {
        @($_.Resources) -match [regex]::Escape($package)
    })
    $defender.packageThreatCount = $packageThreats.Count
    if ($packageThreats.Count -ne 0) { throw "Microsoft Defender reported a package threat" }
}

$workRoot = Join-Path $env:TEMP "CyberMuse-M4-Clean"
New-Item -ItemType Directory -Force -Path $workRoot | Out-Null
$jobId = [guid]::NewGuid().ToString()
$staging = Join-Path $workRoot $jobId
New-Item -ItemType Directory -Path $staging | Out-Null
$request = [ordered]@{
    schemaVersion = 1
    jobId = $jobId
    songId = (Get-FileSha256 -Path $input)
    requestedAnalysisId = "14165a8dcea69ceb1e5eb96f97273dc8"
    inputPath = $input
    stagingPath = $staging
    expectedDurationMs = 6000
    pipelineVersion = "m4-production-v1"
    roots = [ordered]@{ songRoot = $package; stagingRoot = $workRoot; modelRoot = (Join-Path $package "models"); toolRoot = (Join-Path $package "resources") }
    models = @(
        [ordered]@{ modelId = "spleeter-2stems"; version = "1.4.0"; engine = "tensorflow-cpu"; path = $spleeterModel; sha256 = "f3a90b39dd2874269e8b05a48a86745df897b848c61f3958efc80a39152bd692"; licenseExpression = "MIT" },
        [ordered]@{ modelId = "swiftf0"; version = "0.1.2"; engine = "onnxruntime-cpu"; path = $swiftModel; sha256 = "212715116025a490be70db0afda8fb27b1eadf267a3b18ed8df4866c1574e717"; licenseExpression = "MIT" }
    )
    tools = @(
        [ordered]@{ toolId = "ffmpeg"; version = "n9.0.1-6-g9d4ca21220"; path = $ffmpeg; sha256 = (Get-FileSha256 -Path $ffmpeg) },
        [ordered]@{ toolId = "ffprobe"; version = "n9.0.1-6-g9d4ca21220"; path = $ffprobe; sha256 = (Get-FileSha256 -Path $ffprobe) },
        [ordered]@{ toolId = "spleeter-engine"; version = "0.1.0"; path = $spleeterEngine; sha256 = (Get-FileSha256 -Path $spleeterEngine) }
    )
    config = [ordered]@{ sampleRateHz = 48000; pitchMinHz = 65.0; pitchMaxHz = 1046.5; confidenceThreshold = 0.45; maxInterpolatedGapMs = 50 }
}
$requestPath = Join-Path $staging "request.json"
[IO.File]::WriteAllText($requestPath, ($request | ConvertTo-Json -Depth 10), [Text.UTF8Encoding]::new($false))

$stdoutPath = Join-Path $staging "stdout.ndjson"
$stderrPath = Join-Path $staging "stderr.txt"
$start = [Diagnostics.ProcessStartInfo]::new()
$start.FileName = $analyzer
$start.WorkingDirectory = Split-Path -Parent $analyzer
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
$start.EnvironmentVariables.Clear()
$start.EnvironmentVariables["PATH"] = Split-Path -Parent $analyzer
$start.EnvironmentVariables["SYSTEMROOT"] = $env:SYSTEMROOT
$start.EnvironmentVariables["WINDIR"] = $env:WINDIR
$start.EnvironmentVariables["TEMP"] = $env:TEMP
$start.EnvironmentVariables["TMP"] = $env:TEMP
$start.Arguments = '"analyze" "--request" "' + $requestPath + '"'
$process = [Diagnostics.Process]::new()
$process.StartInfo = $start
[void]$process.Start()
$stdoutTask = $process.StandardOutput.ReadToEndAsync()
$stderrTask = $process.StandardError.ReadToEndAsync()
$observedNetwork = [Collections.Generic.HashSet[string]]::new()
do {
    $ids = [Collections.Generic.HashSet[int]]::new()
    [void]$ids.Add($process.Id)
    $changed = $true
    while ($changed) {
        $changed = $false
        foreach ($item in @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId)) {
            if ($ids.Contains([int]$item.ParentProcessId) -and $ids.Add([int]$item.ProcessId)) { $changed = $true }
        }
    }
    foreach ($connection in @(Get-NetTCPConnection -ErrorAction Stop)) {
        if ($ids.Contains([int]$connection.OwningProcess)) { [void]$observedNetwork.Add("tcp:$($connection.State)") }
    }
    foreach ($endpoint in @(Get-NetUDPEndpoint -ErrorAction Stop)) {
        if ($ids.Contains([int]$endpoint.OwningProcess)) { [void]$observedNetwork.Add("udp:endpoint") }
    }
    Start-Sleep -Milliseconds 100
} while (-not $process.HasExited)
$process.WaitForExit()
$stdout = $stdoutTask.GetAwaiter().GetResult()
$stderr = $stderrTask.GetAwaiter().GetResult()
[IO.File]::WriteAllText($stdoutPath, $stdout, [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText($stderrPath, $stderr, [Text.UTF8Encoding]::new($false))
$messages = @($stdout -split "`r?`n" | Where-Object { $_ } | ForEach-Object { $_ | ConvertFrom-Json })
$terminal = $messages | Select-Object -Last 1
$stderrBytes = [Text.Encoding]::UTF8.GetByteCount($stderr)
if ($process.ExitCode -ne 0 -or $terminal.type -ne "completed" -or $stderrBytes -ne 0 -or $observedNetwork.Count -ne 0) {
    throw "Clean-host packaged analysis failed"
}
$manifest = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $staging "analysis.json") | ConvertFrom-Json
$expectedArtifacts = @("instrumental.wav", "reference-track.json", "vocals.wav")
if ($manifest.artifacts.Count -ne $expectedArtifacts.Count -or
    @(Compare-Object -ReferenceObject $expectedArtifacts -DifferenceObject @($manifest.artifacts.relativePath)).Count -ne 0) {
    throw "Clean-host manifest artifact set is invalid"
}
foreach ($artifact in $manifest.artifacts) {
    $artifactPath = Join-Path $staging $artifact.relativePath
    if ((Get-FileSha256 -Path $artifactPath) -ne $artifact.sha256) {
        throw "Clean-host artifact hash validation failed"
    }
}

$evidence = [ordered]@{
    schemaVersion = 1
    testCase = "TC-BUILD-001/TC-NET-001"
    generatedAt = [DateTimeOffset]::UtcNow.ToString("o")
    status = "passed"
    cleanHostAttestation = "Run only on a Windows 11 x64 host/VM without CyberMuse development tools"
    os = [ordered]@{ caption = $os.Caption; version = $os.Version; build = $os.BuildNumber; architecture = $os.OSArchitecture }
    prerequisites = $prerequisites
    defender = $defender
    analyzerExitCode = $process.ExitCode
    terminalType = $terminal.type
    protocolLines = $messages.Count
    stderrBytes = $stderrBytes
    observedNetworkEndpoints = @($observedNetwork)
    analysisId = $manifest.analysisId
    artifactCount = $manifest.artifacts.Count
}
[IO.File]::WriteAllText([IO.Path]::GetFullPath($EvidencePath), ($evidence | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
Write-Output "M4 clean Windows packaged analyzer: PASS"
