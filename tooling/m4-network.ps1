$ErrorActionPreference = "Stop"

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$artifactRoot = Join-Path $repoRoot "artifacts\m4"
$analyzer = Join-Path $artifactRoot "analyzer-dist\cybermuse-analyzer\cybermuse-analyzer.exe"
$ffmpeg = Join-Path $artifactRoot "smoke-tools\ffmpeg-bin\ffmpeg.exe"
$ffprobe = Join-Path $artifactRoot "smoke-tools\ffmpeg-bin\ffprobe.exe"
$modelRoot = Join-Path $env:LOCALAPPDATA "CyberMuse\models"
$uv = Join-Path $env:USERPROFILE ".cache\cybermuse-tools\uv-0.12.5\uv.exe"
$cargo = Join-Path $env:USERPROFILE ".cargo\bin\cargo.exe"
foreach ($path in @($analyzer, $ffmpeg, $ffprobe, $uv, $cargo)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Required M4 network input is missing" }
}
if (-not (Test-Path -LiteralPath $modelRoot -PathType Container)) { throw "Required M4 model root is missing" }

Push-Location (Join-Path $repoRoot "analyzer")
try {
    $requestOutput = & $uv run python scripts/create_m4_smoke_request.py `
        --artifact-root $artifactRoot --model-root $modelRoot `
        --ffmpeg $ffmpeg --ffprobe $ffprobe
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    $smokeRequest = $requestOutput | Select-Object -Last 1
}
finally { Pop-Location }
if (-not (Test-Path -LiteralPath $smokeRequest -PathType Leaf)) { throw "Generated M4 smoke request is missing" }

$networkRoot = [System.IO.Path]::GetFullPath((Join-Path $artifactRoot "network-work"))
New-Item -ItemType Directory -Force -Path $networkRoot | Out-Null

function Write-Utf8NoBom {
    param([string]$Path, [string]$Value)
    [System.IO.File]::WriteAllText($Path, $Value, [System.Text.UTF8Encoding]::new($false))
}

function New-NetworkRequest {
    param([bool]$MissingModel)
    $value = Get-Content -LiteralPath $smokeRequest -Raw -Encoding UTF8 | ConvertFrom-Json
    $jobId = [guid]::NewGuid().ToString()
    $staging = Join-Path $networkRoot $jobId
    New-Item -ItemType Directory -Path $staging | Out-Null
    $value.jobId = $jobId
    $value.stagingPath = $staging
    $value.roots.stagingRoot = $networkRoot
    if ($MissingModel) {
        $swift = $value.models | Where-Object modelId -eq "swiftf0"
        $swift.path = Join-Path (Split-Path -Parent $swift.path) "missing-network-test.whl"
    }
    $requestPath = Join-Path $staging "request.json"
    Write-Utf8NoBom -Path $requestPath -Value ($value | ConvertTo-Json -Depth 10)
    return $requestPath
}

function Get-ProcessTreeIds {
    param([int]$RootId)
    $all = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId)
    $ids = [System.Collections.Generic.HashSet[int]]::new()
    [void]$ids.Add($RootId)
    $changed = $true
    while ($changed) {
        $changed = $false
        foreach ($process in $all) {
            if ($ids.Contains([int]$process.ParentProcessId) -and $ids.Add([int]$process.ProcessId)) {
                $changed = $true
            }
        }
    }
    return @($ids)
}

function Invoke-CapturedAnalyzer {
    param([string]$Label, [string[]]$Arguments, [int]$ExpectedExitCode)
    $stdout = Join-Path $networkRoot "$Label.stdout"
    $stderr = Join-Path $networkRoot "$Label.stderr"
    $start = [System.Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $analyzer
    $start.WorkingDirectory = Split-Path -Parent $analyzer
    $start.UseShellExecute = $false
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.CreateNoWindow = $true
    $start.Environment.Clear()
    $start.Environment["PATH"] = Split-Path -Parent $analyzer
    $start.Environment["SYSTEMROOT"] = $env:SYSTEMROOT
    $start.Environment["WINDIR"] = $env:WINDIR
    $start.Environment["TEMP"] = $env:TEMP
    $start.Environment["TMP"] = $env:TEMP
    foreach ($argument in $Arguments) {
        if ($argument.Contains('"')) { throw "Unexpected quote in analyzer test argument" }
    }
    # Windows PowerShell 5.1 does not expose ProcessStartInfo.ArgumentList.
    # These arguments are internally generated paths/flags; quoting every one
    # preserves Unicode and spaces without invoking a command shell.
    $start.Arguments = ($Arguments | ForEach-Object { '"' + $_ + '"' }) -join ' '
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $start
    [void]$process.Start()
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $observed = [System.Collections.Generic.HashSet[string]]::new()
    do {
        $ids = Get-ProcessTreeIds -RootId $process.Id
        try {
            foreach ($connection in Get-NetTCPConnection -ErrorAction Stop) {
                if ($ids -contains [int]$connection.OwningProcess) {
                    [void]$observed.Add("tcp:$($connection.State)")
                }
            }
            foreach ($endpoint in Get-NetUDPEndpoint -ErrorAction Stop) {
                if ($ids -contains [int]$endpoint.OwningProcess) {
                    [void]$observed.Add("udp:endpoint")
                }
            }
        }
        catch {
            throw "Windows network table capture is unavailable"
        }
        Start-Sleep -Milliseconds 100
    } while (-not $process.HasExited)
    $process.WaitForExit()
    $stdoutText = $stdoutTask.GetAwaiter().GetResult()
    $stderrText = $stderrTask.GetAwaiter().GetResult()
    Write-Utf8NoBom -Path $stdout -Value $stdoutText
    Write-Utf8NoBom -Path $stderr -Value $stderrText
    if ($process.ExitCode -ne $ExpectedExitCode) {
        throw "$Label returned $($process.ExitCode), expected $ExpectedExitCode"
    }
    if ($observed.Count -ne 0) { throw "$Label opened a network endpoint" }
    return [ordered]@{
        label = $Label
        exitCode = $process.ExitCode
        stdoutBytes = ([Text.Encoding]::UTF8.GetByteCount($stdoutText))
        stderrBytes = ([Text.Encoding]::UTF8.GetByteCount($stderrText))
        observedNetworkEndpoints = @($observed)
    }
}

Push-Location $repoRoot
try {
    & $cargo test --locked --workspace --all-features model_manager::tests -- --nocapture
    $modelTestExit = $LASTEXITCODE
}
finally { Pop-Location }
if ($modelTestExit -ne 0) { exit $modelTestExit }

$versionResult = Invoke-CapturedAnalyzer -Label "version" -Arguments @("--version", "--json") -ExpectedExitCode 0
$missingRequest = New-NetworkRequest -MissingModel $true
$missingResult = Invoke-CapturedAnalyzer -Label "model-missing" -Arguments @("analyze", "--request", $missingRequest) -ExpectedExitCode 3
$installedRequest = New-NetworkRequest -MissingModel $false
$installedResult = Invoke-CapturedAnalyzer -Label "installed-analysis" -Arguments @("analyze", "--request", $installedRequest) -ExpectedExitCode 0

$missingMessages = @(Get-Content -LiteralPath (Join-Path $networkRoot "model-missing.stdout") -Encoding UTF8 | ForEach-Object { $_ | ConvertFrom-Json })
if ($missingMessages[-1].type -ne "failed" -or $missingMessages[-1].error.code -ne "ANALYZER_MODEL_MISSING") {
    throw "Missing-model analyzer error was not stable"
}
$installedMessages = @(Get-Content -LiteralPath (Join-Path $networkRoot "installed-analysis.stdout") -Encoding UTF8 | ForEach-Object { $_ | ConvertFrom-Json })
if ($installedMessages[-1].type -ne "completed") { throw "Installed offline analysis did not complete" }

$report = [ordered]@{
    schemaVersion = 1
    testCase = "TC-NET-001/TC-MOD-001"
    generatedAt = [DateTimeOffset]::UtcNow.ToString("o")
    status = "passed"
    capture = "Windows Get-NetTCPConnection/Get-NetUDPEndpoint, 100 ms polling, root plus descendants"
    privacy = "Endpoint state only; no addresses, paths, audio, or identifiers retained"
    realHostsContactedByTests = $false
    modelInstallerLocalServerTestsExitCode = $modelTestExit
    cases = @($versionResult, $missingResult, $installedResult)
}
Write-Utf8NoBom -Path (Join-Path $artifactRoot "model-install-network.json") -Value ($report | ConvertTo-Json -Depth 6)
Write-Output "M4 network boundary: PASS"
