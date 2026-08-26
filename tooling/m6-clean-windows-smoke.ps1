[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$PackageRoot,

    [Parameter(Mandatory = $true)]
    [string]$EvidencePath,

    [ValidateRange(3, 60)]
    [int]$CaptureSeconds = 10,

    [switch]$DiagnosticHost,
    [switch]$SkipDefender
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-FileSha256([string]$Path) {
    $stream = [System.IO.File]::OpenRead($Path)
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    try {
        return ([System.BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
    }
    finally {
        $algorithm.Dispose()
        $stream.Dispose()
    }
}

function Get-ProcessTreeIds([int]$RootId) {
    $rows = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId)
    $ids = [System.Collections.Generic.HashSet[int]]::new()
    [void]$ids.Add($RootId)
    $changed = $true
    while ($changed) {
        $changed = $false
        foreach ($row in $rows) {
            if ($ids.Contains([int]$row.ParentProcessId) -and $ids.Add([int]$row.ProcessId)) {
                $changed = $true
            }
        }
    }
    return @($ids)
}

function Get-NonLogMetadataHash([string]$Root, [string]$EventsPath) {
    if (-not (Test-Path -LiteralPath $Root -PathType Container)) { return $null }
    $rows = @(
        Get-ChildItem -LiteralPath $Root -File -Recurse |
            Where-Object FullName -NE $EventsPath |
            Sort-Object FullName |
            ForEach-Object {
                $relative = $_.FullName.Substring($Root.Length).TrimStart("\").Replace("\", "/")
                "$relative|$($_.Length)|$($_.LastWriteTimeUtc.Ticks)"
            }
    )
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes([string]::Join("`n", $rows))
        return ([System.BitConverter]::ToString($algorithm.ComputeHash($bytes))).Replace("-", "").ToLowerInvariant()
    }
    finally {
        $algorithm.Dispose()
    }
}

function Assert-InstalledPayload([string]$InstallRoot, [string]$Package) {
    $required = @(
        "cybermuse-desktop.exe",
        "THIRD_PARTY_NOTICES.txt",
        "cybermuse-0.1.0.spdx.json",
        "model-manifest.json",
        "runtime-manifest.json",
        "analyzer\cybermuse-analyzer.exe",
        "spleeter-engine\cybermuse-spleeter-engine.exe",
        "ffmpeg\ffmpeg.exe",
        "ffmpeg\ffprobe.exe",
        "uninstall.exe"
    )
    foreach ($relative in $required) {
        if (-not (Test-Path -LiteralPath (Join-Path $InstallRoot $relative) -PathType Leaf)) {
            throw "M6_CLEAN_INSTALLED_FILE_MISSING: $relative"
        }
    }
    foreach ($name in @("THIRD_PARTY_NOTICES.txt", "cybermuse-0.1.0.spdx.json", "model-manifest.json")) {
        if ((Get-FileSha256 (Join-Path $InstallRoot $name)) -ne (Get-FileSha256 (Join-Path $Package $name))) {
            throw "M6_CLEAN_SUPPLY_ASSET_MISMATCH: $name"
        }
    }
    $forbidden = @(
        Get-ChildItem -LiteralPath $InstallRoot -File -Recurse |
            Where-Object {
                $_.Extension.ToLowerInvariant() -in @(".wav", ".mp3", ".flac", ".log", ".key") -or
                $_.Name -match "^\.env($|\.)"
            }
    )
    if ($forbidden.Count -ne 0) {
        throw "M6_CLEAN_FORBIDDEN_PAYLOAD: $($forbidden[0].Name)"
    }
    foreach ($file in @(Get-ChildItem -LiteralPath $InstallRoot -File -Recurse | Where-Object Extension -In @(".json", ".txt", ".js", ".css", ".html", ".md", ".toml", ".pem"))) {
        $text = [System.IO.File]::ReadAllText($file.FullName)
        if ($text -match "-----BEGIN PRIVATE KEY-----|[A-Za-z]:\\projects\\cyberMuse") {
            throw "M6_CLEAN_SENSITIVE_PAYLOAD_TEXT: $($file.Name)"
        }
    }
    $files = @(Get-ChildItem -LiteralPath $InstallRoot -File -Recurse)
    return [ordered]@{
        fileCount = $files.Count
        totalBytes = [long](($files | Measure-Object Length -Sum).Sum)
        supplyAssetsByteIdentical = $true
        forbiddenPayloadCount = 0
        sensitiveTextScanPassed = $true
    }
}

$package = [System.IO.Path]::GetFullPath($PackageRoot)
$evidence = if ([System.IO.Path]::IsPathRooted($EvidencePath)) {
    [System.IO.Path]::GetFullPath($EvidencePath)
} else {
    [System.IO.Path]::GetFullPath((Join-Path (Get-Location).Path $EvidencePath))
}
if (-not (Test-Path -LiteralPath $package -PathType Container)) {
    throw "M6_CLEAN_PACKAGE_MISSING"
}
if (Test-Path -LiteralPath $evidence) {
    throw "M6_CLEAN_EVIDENCE_EXISTS: refusing to overwrite $evidence"
}

$packageInfoPath = Join-Path $package "README.json"
$manifestPath = Join-Path $package "package-manifest.json"
if (-not (Test-Path -LiteralPath $packageInfoPath -PathType Leaf) -or -not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "M6_CLEAN_PACKAGE_METADATA_MISSING"
}
$packageInfo = Get-Content -LiteralPath $packageInfoPath -Raw -Encoding UTF8 | ConvertFrom-Json
$packageManifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($packageInfo.schemaVersion -ne 1 -or $packageManifest.schemaVersion -ne 1 -or
    [string]$packageInfo.sourceCommit -ne [string]$packageManifest.sourceCommit) {
    throw "M6_CLEAN_PACKAGE_METADATA_INVALID"
}
if (-not [bool]$packageInfo.gateEligible -and -not $DiagnosticHost) {
    throw "M6_CLEAN_PACKAGE_NOT_GATE_ELIGIBLE: rebuild and package a clean worktree."
}

$expectedFiles = @{}
foreach ($record in $packageManifest.files) {
    $relative = [string]$record.relativePath
    if ($expectedFiles.ContainsKey($relative)) {
        throw "M6_CLEAN_PACKAGE_DUPLICATE_PATH: $relative"
    }
    $candidate = [System.IO.Path]::GetFullPath((Join-Path $package $relative.Replace("/", "\")))
    if (-not $candidate.StartsWith($package + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "M6_CLEAN_PACKAGE_UNSAFE_PATH"
    }
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf) -or
        (Get-Item -LiteralPath $candidate).Length -ne [long]$record.sizeBytes -or
        (Get-FileSha256 $candidate) -ne [string]$record.sha256) {
        throw "M6_CLEAN_PACKAGE_INTEGRITY_FAILED: $relative"
    }
    $expectedFiles[$relative] = $true
}
$actualFiles = @(
    Get-ChildItem -LiteralPath $package -File -Recurse |
        Where-Object FullName -NE $manifestPath |
        ForEach-Object { $_.FullName.Substring($package.Length + 1).Replace("\", "/") }
)
if ($actualFiles.Count -ne $expectedFiles.Count -or @($actualFiles | Where-Object { -not $expectedFiles.ContainsKey($_) }).Count -ne 0) {
    throw "M6_CLEAN_PACKAGE_FILE_SET_MISMATCH"
}

$releaseManifest = Get-Content -LiteralPath (Join-Path $package "release-manifest.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$installer = Join-Path $package "CyberMuse_0.1.0_x64-setup.exe"
$installerRecord = @($releaseManifest.artifacts | Where-Object relativePath -Like "*/CyberMuse_0.1.0_x64-setup.exe") | Select-Object -First 1
if ($null -eq $installerRecord -or (Get-FileSha256 $installer) -ne [string]$packageInfo.installerSha256 -or
    [string]$packageInfo.installerSha256 -ne [string]$installerRecord.sha256) {
    throw "M6_CLEAN_INSTALLER_MANIFEST_MISMATCH"
}

$os = Get-CimInstance Win32_OperatingSystem
$isWindows11X64 = $os.Caption -match "Windows 11" -and $os.OSArchitecture -match "64"
$tools = [ordered]@{}
foreach ($tool in @("python.exe", "cargo.exe", "rustc.exe", "uv.exe", "node.exe", "pnpm.cmd")) {
    $tools[$tool] = [bool](Get-Command $tool -ErrorAction SilentlyContinue)
}
$developmentToolsOnPath = @($tools.GetEnumerator() | Where-Object Value).Count -ne 0
$defaultRoutes = @(
    Get-NetRoute -ErrorAction SilentlyContinue |
        Where-Object { $_.DestinationPrefix -in @("0.0.0.0/0", "::/0") -and $_.State -eq "Alive" }
)
$offline = $defaultRoutes.Count -eq 0
$appDataRoot = Join-Path $env:LOCALAPPDATA "CyberMuse"
$eventsPath = Join-Path $appDataRoot "logs\events.json"
$appDataExistedBefore = Test-Path -LiteralPath $appDataRoot -PathType Container
$nonLogHashBefore = Get-NonLogMetadataHash $appDataRoot $eventsPath
$eventsExistedBefore = Test-Path -LiteralPath $eventsPath -PathType Leaf
$eventsBytesBefore = if ($eventsExistedBefore) { [System.IO.File]::ReadAllBytes($eventsPath) } else { $null }

if (-not $DiagnosticHost) {
    if (-not $isWindows11X64) { throw "M6_CLEAN_HOST_OS_INVALID: Windows 11 x64 is required." }
    if ($developmentToolsOnPath) { throw "M6_CLEAN_HOST_DEV_TOOL_FOUND: runtime host PATH must not contain development tools." }
    if (-not $offline) { throw "M6_CLEAN_HOST_ONLINE: disconnect network adapters before the gate run." }
    if ($appDataExistedBefore) { throw "M6_CLEAN_HOST_APP_DATA_EXISTS: use a fresh Windows profile for the gate run." }
    if ($SkipDefender) { throw "M6_CLEAN_HOST_DEFENDER_REQUIRED: -SkipDefender is diagnostic only." }
}

$defender = [ordered]@{
    skipped = [bool]$SkipDefender
    enabled = $null
    signatureVersion = $null
    packageThreatCount = $null
    installedThreatCount = $null
}
if (-not $SkipDefender) {
    $defenderStatus = Get-MpComputerStatus
    $defender.enabled = [bool]($defenderStatus.AMServiceEnabled -and $defenderStatus.AntivirusEnabled)
    $defender.signatureVersion = [string]$defenderStatus.AntivirusSignatureVersion
    if (-not $defender.enabled) { throw "M6_CLEAN_DEFENDER_DISABLED" }
    Start-MpScan -ScanType CustomScan -ScanPath $package
    $packageThreats = @(Get-MpThreatDetection -ErrorAction SilentlyContinue | Where-Object { @($_.Resources) -match [regex]::Escape($package) })
    $defender.packageThreatCount = $packageThreats.Count
    if ($packageThreats.Count -ne 0) { throw "M6_CLEAN_DEFENDER_PACKAGE_THREAT" }
}

$publicDocuments = [Environment]::GetFolderPath("CommonDocuments")
$publicRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $publicDocuments))
$workRoot = [System.IO.Path]::GetFullPath((Join-Path $publicRoot ("CyberMuseM6-" + [guid]::NewGuid().ToString("N"))))
if (-not $workRoot.StartsWith(
        $publicRoot + [System.IO.Path]::DirectorySeparatorChar,
        [System.StringComparison]::OrdinalIgnoreCase
    )) {
    throw "M6_CLEAN_WORK_PATH_INVALID"
}
if ($workRoot.Contains(" ")) {
    throw "M6_CLEAN_WORK_PATH_HAS_SPACES: the standalone NSIS smoke requires a no-space Public profile path."
}
$installRoot = Join-Path $workRoot "install"
$analysisRoot = Join-Path $workRoot "analysis"
$uninstaller = Join-Path $installRoot "uninstall.exe"
$appProcess = $null
$installed = $false
$forcedTermination = $false
$appObservedClasses = [System.Collections.Generic.HashSet[string]]::new()
$appControlledExternal = [System.Collections.Generic.HashSet[string]]::new()
$webViewExternal = [System.Collections.Generic.HashSet[string]]::new()

try {
    [System.IO.Directory]::CreateDirectory($workRoot) | Out-Null
    $install = Start-Process -FilePath $installer -ArgumentList @("/S", "/D=$installRoot") -Wait -PassThru -WindowStyle Hidden
    if ($install.ExitCode -ne 0) { throw "M6_CLEAN_INSTALL_FAILED: $($install.ExitCode)" }
    $installed = $true
    $firstInstall = Assert-InstalledPayload $installRoot $package

    $reinstall = Start-Process -FilePath $installer -ArgumentList @("/S", "/D=$installRoot") -Wait -PassThru -WindowStyle Hidden
    if ($reinstall.ExitCode -ne 0) { throw "M6_CLEAN_REINSTALL_FAILED: $($reinstall.ExitCode)" }
    $sameVersionReinstall = Assert-InstalledPayload $installRoot $package

    if (-not $SkipDefender) {
        Start-MpScan -ScanType CustomScan -ScanPath $installRoot
        $installedThreats = @(Get-MpThreatDetection -ErrorAction SilentlyContinue | Where-Object { @($_.Resources) -match [regex]::Escape($installRoot) })
        $defender.installedThreatCount = $installedThreats.Count
        if ($installedThreats.Count -ne 0) { throw "M6_CLEAN_DEFENDER_INSTALLED_THREAT" }
    }

    $appStart = [System.Diagnostics.ProcessStartInfo]::new()
    $appStart.FileName = Join-Path $installRoot "cybermuse-desktop.exe"
    $appStart.WorkingDirectory = $installRoot
    $appStart.UseShellExecute = $false
    $appStart.CreateNoWindow = $true
    $appStart.EnvironmentVariables["PATH"] = Join-Path $env:SYSTEMROOT "System32"
    $appProcess = [System.Diagnostics.Process]::new()
    $appProcess.StartInfo = $appStart
    [void]$appProcess.Start()
    Start-Sleep -Seconds 2
    if ($appProcess.HasExited) { throw "M6_CLEAN_APP_EXITED: $($appProcess.ExitCode)" }
    $capture = [System.Diagnostics.Stopwatch]::StartNew()
    while ($capture.Elapsed.TotalSeconds -lt $CaptureSeconds) {
        $ids = @(Get-ProcessTreeIds $appProcess.Id)
        $names = @{}
        foreach ($id in $ids) {
            $owned = Get-Process -Id $id -ErrorAction SilentlyContinue
            if ($null -ne $owned) { $names[$id] = $owned.ProcessName.ToLowerInvariant() }
        }
        foreach ($connection in Get-NetTCPConnection -ErrorAction Stop) {
            $owner = [int]$connection.OwningProcess
            if (-not $names.ContainsKey($owner)) { continue }
            $name = [string]$names[$owner]
            $remote = [string]$connection.RemoteAddress
            $external = $remote -notin @("", "0.0.0.0", "::", "127.0.0.1", "::1", "*")
            [void]$appObservedClasses.Add("${name}:tcp:$($connection.State)")
            if ($external -and $name -eq "msedgewebview2") {
                [void]$webViewExternal.Add("msedgewebview2:tcp:$($connection.State)")
            }
            elseif ($external) {
                [void]$appControlledExternal.Add("${name}:tcp:$($connection.State)")
            }
        }
        foreach ($endpoint in Get-NetUDPEndpoint -ErrorAction Stop) {
            $owner = [int]$endpoint.OwningProcess
            if (-not $names.ContainsKey($owner)) { continue }
            $name = [string]$names[$owner]
            [void]$appObservedClasses.Add("${name}:udp:bound")
            if ($name -ne "msedgewebview2") { [void]$appControlledExternal.Add("${name}:udp:bound") }
        }
        Start-Sleep -Milliseconds 100
    }
    $capture.Stop()
    if ($appControlledExternal.Count -ne 0) { throw "M6_CLEAN_APP_NETWORK_VIOLATION" }
    [void]$appProcess.CloseMainWindow()
    if (-not $appProcess.WaitForExit(5000)) {
        $appProcess.Kill()
        $appProcess.WaitForExit()
        $forcedTermination = $true
    }

    if (-not (Test-Path -LiteralPath $eventsPath -PathType Leaf)) { throw "M6_CLEAN_DIAGNOSTIC_LOG_MISSING" }
    $eventsText = Get-Content -LiteralPath $eventsPath -Raw -Encoding UTF8
    $events = $eventsText | ConvertFrom-Json
    if ($events.schemaVersion -ne 1 -or @($events.events).Count -lt 1 -or
        $eventsText -match "[A-Za-z]:\\|audioBytes|pitchTrack|filePath|deviceId|deviceName|accountId|-----BEGIN PRIVATE KEY-----") {
        throw "M6_CLEAN_DIAGNOSTIC_LOG_REDACTION_FAILED"
    }

    [System.IO.Directory]::CreateDirectory($analysisRoot) | Out-Null
    $jobId = [guid]::NewGuid().ToString()
    $staging = Join-Path $analysisRoot $jobId
    [System.IO.Directory]::CreateDirectory($staging) | Out-Null
    $input = Join-Path $package "smoke-input.wav"
    $analyzer = Join-Path $installRoot "analyzer\cybermuse-analyzer.exe"
    $spleeterEngine = Join-Path $installRoot "spleeter-engine\cybermuse-spleeter-engine.exe"
    $ffmpeg = Join-Path $installRoot "ffmpeg\ffmpeg.exe"
    $ffprobe = Join-Path $installRoot "ffmpeg\ffprobe.exe"
    $spleeterModel = Join-Path $package "models\spleeter-2stems\1.4.0\2stems.tar.gz"
    $swiftModel = Join-Path $package "models\swiftf0\0.1.2\swift_f0-0.1.2-py3-none-any.whl"
    $request = [ordered]@{
        schemaVersion = 1
        jobId = $jobId
        songId = Get-FileSha256 $input
        requestedAnalysisId = "14165a8dcea69ceb1e5eb96f97273dc8"
        inputPath = $input
        stagingPath = $staging
        expectedDurationMs = 6000
        pipelineVersion = "m4-production-v1"
        roots = [ordered]@{ songRoot = $package; stagingRoot = $analysisRoot; modelRoot = (Join-Path $package "models"); toolRoot = $installRoot }
        models = @(
            [ordered]@{ modelId = "spleeter-2stems"; version = "1.4.0"; engine = "tensorflow-cpu"; path = $spleeterModel; sha256 = "f3a90b39dd2874269e8b05a48a86745df897b848c61f3958efc80a39152bd692"; licenseExpression = "MIT" },
            [ordered]@{ modelId = "swiftf0"; version = "0.1.2"; engine = "onnxruntime-cpu"; path = $swiftModel; sha256 = "212715116025a490be70db0afda8fb27b1eadf267a3b18ed8df4866c1574e717"; licenseExpression = "MIT" }
        )
        tools = @(
            [ordered]@{ toolId = "ffmpeg"; version = "n9.0.1-6-g9d4ca21220"; path = $ffmpeg; sha256 = Get-FileSha256 $ffmpeg },
            [ordered]@{ toolId = "ffprobe"; version = "n9.0.1-6-g9d4ca21220"; path = $ffprobe; sha256 = Get-FileSha256 $ffprobe },
            [ordered]@{ toolId = "spleeter-engine"; version = "0.1.0"; path = $spleeterEngine; sha256 = Get-FileSha256 $spleeterEngine }
        )
        config = [ordered]@{ sampleRateHz = 48000; pitchMinHz = 65.0; pitchMaxHz = 1046.5; confidenceThreshold = 0.45; maxInterpolatedGapMs = 50 }
    }
    $requestPath = Join-Path $staging "request.json"
    [System.IO.File]::WriteAllText($requestPath, ($request | ConvertTo-Json -Depth 10), [System.Text.UTF8Encoding]::new($false))

    $analyzerStart = [System.Diagnostics.ProcessStartInfo]::new()
    $analyzerStart.FileName = $analyzer
    $analyzerStart.WorkingDirectory = Split-Path -Parent $analyzer
    $analyzerStart.UseShellExecute = $false
    $analyzerStart.CreateNoWindow = $true
    $analyzerStart.RedirectStandardOutput = $true
    $analyzerStart.RedirectStandardError = $true
    $analyzerStart.EnvironmentVariables.Clear()
    $analyzerStart.EnvironmentVariables["PATH"] = Split-Path -Parent $analyzer
    foreach ($name in @("SYSTEMROOT", "WINDIR", "TEMP", "TMP")) {
        $analyzerStart.EnvironmentVariables[$name] = [Environment]::GetEnvironmentVariable($name)
    }
    $analyzerStart.Arguments = '"analyze" "--request" "' + $requestPath + '"'
    $analyzerProcess = [System.Diagnostics.Process]::new()
    $analyzerProcess.StartInfo = $analyzerStart
    [void]$analyzerProcess.Start()
    $stdoutTask = $analyzerProcess.StandardOutput.ReadToEndAsync()
    $stderrTask = $analyzerProcess.StandardError.ReadToEndAsync()
    $analyzerNetwork = [System.Collections.Generic.HashSet[string]]::new()
    $analyzerWatch = [System.Diagnostics.Stopwatch]::StartNew()
    while (-not $analyzerProcess.HasExited) {
        if ($analyzerWatch.Elapsed.TotalSeconds -gt 180) {
            $analyzerProcess.Kill()
            throw "M6_CLEAN_ANALYZER_TIMEOUT"
        }
        $ids = @(Get-ProcessTreeIds $analyzerProcess.Id)
        foreach ($connection in Get-NetTCPConnection -ErrorAction Stop) {
            if ($ids -contains [int]$connection.OwningProcess) { [void]$analyzerNetwork.Add("tcp:$($connection.State)") }
        }
        foreach ($endpoint in Get-NetUDPEndpoint -ErrorAction Stop) {
            if ($ids -contains [int]$endpoint.OwningProcess) { [void]$analyzerNetwork.Add("udp:bound") }
        }
        Start-Sleep -Milliseconds 100
    }
    $analyzerProcess.WaitForExit()
    $stdout = $stdoutTask.GetAwaiter().GetResult()
    $stderr = $stderrTask.GetAwaiter().GetResult()
    $messages = @($stdout -split "`r?`n" | Where-Object { $_ } | ForEach-Object { $_ | ConvertFrom-Json })
    $terminal = $messages | Select-Object -Last 1
    if ($analyzerProcess.ExitCode -ne 0 -or $terminal.type -ne "completed" -or
        [System.Text.Encoding]::UTF8.GetByteCount($stderr) -ne 0 -or $analyzerNetwork.Count -ne 0) {
        throw "M6_CLEAN_PACKAGED_ANALYSIS_FAILED"
    }
    $analysisManifest = Get-Content -LiteralPath (Join-Path $staging "analysis.json") -Raw -Encoding UTF8 | ConvertFrom-Json
    $expectedArtifacts = @("instrumental.wav", "reference-track.json", "vocals.wav")
    if ($analysisManifest.artifacts.Count -ne $expectedArtifacts.Count -or
        @(Compare-Object -ReferenceObject $expectedArtifacts -DifferenceObject @($analysisManifest.artifacts.relativePath)).Count -ne 0) {
        throw "M6_CLEAN_ANALYSIS_ARTIFACT_SET_INVALID"
    }
    foreach ($artifact in $analysisManifest.artifacts) {
        if ((Get-FileSha256 (Join-Path $staging $artifact.relativePath)) -ne [string]$artifact.sha256) {
            throw "M6_CLEAN_ANALYSIS_ARTIFACT_HASH_FAILED"
        }
    }

    $uninstall = Start-Process -FilePath $uninstaller -ArgumentList @("/S") -Wait -PassThru -WindowStyle Hidden
    if ($uninstall.ExitCode -ne 0) { throw "M6_CLEAN_UNINSTALL_FAILED: $($uninstall.ExitCode)" }
    for ($attempt = 0; $attempt -lt 50 -and (Test-Path -LiteralPath $installRoot); $attempt++) {
        Start-Sleep -Milliseconds 200
    }
    if (Test-Path -LiteralPath $installRoot) {
        $uninstallLeftovers = @(Get-ChildItem -LiteralPath $installRoot -Force -Recurse)
        if ($uninstallLeftovers.Count -ne 0) {
            $relativeLeftovers = @(
                $uninstallLeftovers |
                    Select-Object -First 25 |
                    ForEach-Object { $_.FullName.Substring($installRoot.Length + 1).Replace("\", "/") }
            )
            throw "M6_CLEAN_UNINSTALL_LEFTOVERS: $($uninstallLeftovers.Count) entries remain: $([string]::Join(', ', $relativeLeftovers))"
        }
    }
    $installed = $false

    $userDataPreserved = Test-Path -LiteralPath $eventsPath -PathType Leaf
    if (-not $userDataPreserved) { throw "M6_CLEAN_UNINSTALL_REMOVED_USER_DATA" }
    if ($DiagnosticHost -and (Get-NonLogMetadataHash $appDataRoot $eventsPath) -ne $nonLogHashBefore) {
        throw "M6_CLEAN_DIAGNOSTIC_HOST_USER_DATA_CHANGED"
    }

    $cleanHostGateSatisfied = -not $DiagnosticHost -and
        [bool]$packageInfo.gateEligible -and
        $isWindows11X64 -and
        -not $developmentToolsOnPath -and
        $offline -and
        -not $SkipDefender -and
        [bool]$defender.enabled -and
        $defender.packageThreatCount -eq 0 -and
        $defender.installedThreatCount -eq 0
    $report = [ordered]@{
        schemaVersion = 1
        testCases = @("TC-PLAT-001", "TC-BUILD-001", "TC-NET-001", "TC-DIA-002")
        generatedAt = [DateTimeOffset]::UtcNow.ToString("O")
        status = if ($cleanHostGateSatisfied) { "passed-clean-runtime-host" } else { "passed-diagnostic-host" }
        sourceCommit = [string]$packageInfo.sourceCommit
        packageGateEligible = [bool]$packageInfo.gateEligible
        cleanHostGateSatisfied = $cleanHostGateSatisfied
        host = [ordered]@{
            windows11X64 = $isWindows11X64
            osVersion = [string]$os.Version
            osBuild = [string]$os.BuildNumber
            developmentToolsOnPath = $tools
            offlineDefaultRoutes = $defaultRoutes.Count
        }
        defender = $defender
        installer = [ordered]@{
            sha256 = [string]$packageInfo.installerSha256
            signedStatus = [string](Get-AuthenticodeSignature -LiteralPath $installer).Status
            firstInstall = $firstInstall
            sameVersionReinstall = $sameVersionReinstall
            uninstallExitCode = $uninstall.ExitCode
            payloadRemoved = $true
            userDataPreserved = $userDataPreserved
        }
        app = [ordered]@{
            captureSeconds = $CaptureSeconds
            observedClasses = @($appObservedClasses | Sort-Object)
            appControlledExternalEndpointClasses = @($appControlledExternal | Sort-Object)
            systemWebView2ExternalEndpointClasses = @($webViewExternal | Sort-Object)
            diagnosticEventCount = @($events.events).Count
            diagnosticForbiddenMatches = 0
            forcedTermination = $forcedTermination
        }
        analyzer = [ordered]@{
            exitCode = $analyzerProcess.ExitCode
            terminalType = [string]$terminal.type
            protocolLines = $messages.Count
            networkEndpointClasses = @($analyzerNetwork)
            analysisId = [string]$analysisManifest.analysisId
            artifactCount = $analysisManifest.artifacts.Count
        }
        privacy = "No endpoint addresses, device identifiers, complete paths, or audio content are retained in this report."
        remainingGate = if ($cleanHostGateSatisfied) {
            "Clean build provenance, hardware calibration/soak, release E2E, and the user M6 decision remain separate gates."
        } else {
            "Diagnostic runs never satisfy the independent clean runtime host gate."
        }
    }
    [System.IO.Directory]::CreateDirectory((Split-Path -Parent $evidence)) | Out-Null
    [System.IO.File]::WriteAllText($evidence, ($report | ConvertTo-Json -Depth 10), [System.Text.UTF8Encoding]::new($false))
    Write-Host "M6 clean Windows runtime: PASS (cleanHostGateSatisfied=$cleanHostGateSatisfied)"
}
finally {
    if ($null -ne $appProcess -and -not $appProcess.HasExited) {
        [void]$appProcess.CloseMainWindow()
        if (-not $appProcess.WaitForExit(5000)) {
            $appProcess.Kill()
            $appProcess.WaitForExit()
        }
    }
    if ($installed -and (Test-Path -LiteralPath $uninstaller -PathType Leaf)) {
        $cleanup = Start-Process -FilePath $uninstaller -ArgumentList @("/S") -Wait -PassThru -WindowStyle Hidden
        if ($cleanup.ExitCode -ne 0) { throw "M6_CLEAN_CLEANUP_UNINSTALL_FAILED: $($cleanup.ExitCode)" }
        for ($attempt = 0; $attempt -lt 50 -and (Test-Path -LiteralPath $installRoot); $attempt++) {
            Start-Sleep -Milliseconds 200
        }
    }
    if (Test-Path -LiteralPath $workRoot -PathType Container) {
        Remove-Item -LiteralPath $workRoot -Recurse -Force
    }
    if ($DiagnosticHost) {
        if ($eventsExistedBefore) {
            [System.IO.Directory]::CreateDirectory((Split-Path -Parent $eventsPath)) | Out-Null
            [System.IO.File]::WriteAllBytes($eventsPath, $eventsBytesBefore)
        }
        elseif (Test-Path -LiteralPath $eventsPath -PathType Leaf) {
            Remove-Item -LiteralPath $eventsPath -Force
        }
    }
}
