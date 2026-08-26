param(
    [ValidateRange(3, 60)]
    [int]$CaptureSeconds = 10,
    [string]$InstallerPath = 'target/release/bundle/nsis/CyberMuse_0.1.0_x64-setup.exe',
    [string]$OutputPath = 'artifacts/m6/privacy-network.json'
)

$ErrorActionPreference = 'Stop'
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$artifactRoot = [System.IO.Path]::GetFullPath((Join-Path $repoRoot 'artifacts\m6'))
$installer = [System.IO.Path]::GetFullPath((Join-Path $repoRoot $InstallerPath))
$output = [System.IO.Path]::GetFullPath((Join-Path $repoRoot $OutputPath))
$installRoot = Join-Path $artifactRoot 'privacy-install'
$appDataRoot = Join-Path $env:LOCALAPPDATA 'CyberMuse'
$eventsPath = Join-Path $appDataRoot 'logs\events.json'

foreach ($path in @($installRoot, $output)) {
    $resolved = [System.IO.Path]::GetFullPath($path)
    if (-not $resolved.StartsWith($artifactRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'M6_PRIVACY_TARGET_INVALID: generated paths must stay under artifacts/m6.'
    }
    if (Test-Path -LiteralPath $resolved) {
        throw "M6_PRIVACY_TARGET_EXISTS: refusing to overwrite $resolved"
    }
}

function Get-UserDataMetadataHash {
    if (-not (Test-Path -LiteralPath $appDataRoot -PathType Container)) {
        return $null
    }
    $rows = @(
        Get-ChildItem -LiteralPath $appDataRoot -File -Recurse |
            Where-Object FullName -ne $eventsPath |
            Sort-Object FullName |
            ForEach-Object {
                $relative = $_.FullName.Substring($appDataRoot.Length).TrimStart('\').Replace('\', '/')
                "$relative|$($_.Length)|$($_.LastWriteTimeUtc.Ticks)"
            }
    )
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes([string]::Join("`n", $rows))
        return ([System.BitConverter]::ToString($algorithm.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
    }
    finally {
        $algorithm.Dispose()
    }
}

$appDataExistedBefore = Test-Path -LiteralPath $appDataRoot -PathType Container
$userDataMetadataBefore = Get-UserDataMetadataHash
$eventsExistedBefore = Test-Path -LiteralPath $eventsPath -PathType Leaf
$eventsBytesBefore = if ($eventsExistedBefore) { [System.IO.File]::ReadAllBytes($eventsPath) } else { $null }
if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
    throw 'M6_PRIVACY_INSTALLER_MISSING: build the M6 installer first.'
}
if (Get-Process -Name 'cybermuse-desktop' -ErrorAction SilentlyContinue) {
    throw 'M6_PRIVACY_APP_ALREADY_RUNNING: close CyberMuse before capture.'
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

function Assert-StaticNetworkBoundary {
    $webFiles = @(
        Get-ChildItem -LiteralPath (Join-Path $repoRoot 'apps\desktop\src') -File -Recurse |
            Where-Object { $_.Name -notmatch '\.test\.' -and $_.Extension -in @('.ts', '.tsx', '.js') }
    )
    $webViolations = @($webFiles | Select-String -Pattern '\b(fetch|WebSocket|EventSource|XMLHttpRequest|sendBeacon)\s*\(')
    if ($webViolations.Count -ne 0) {
        throw "M6_STATIC_NETWORK_VIOLATION: $($webViolations[0].Path)"
    }
    $rustFiles = @(
        Get-ChildItem -LiteralPath (Join-Path $repoRoot 'apps\desktop\src-tauri\src') -File -Filter '*.rs' |
            Where-Object Name -ne 'model_manager.rs'
    )
    $rustViolations = @($rustFiles | Select-String -Pattern '\b(ureq|reqwest|TcpStream|UdpSocket)\b')
    if ($rustViolations.Count -ne 0) {
        throw "M6_STATIC_NETWORK_VIOLATION: $($rustViolations[0].Path)"
    }
    $pythonFiles = @(
        Get-ChildItem -LiteralPath (Join-Path $repoRoot 'analyzer') -File -Filter '*.py' -Recurse |
            Where-Object { $_.FullName -notmatch '[\\/](\.venv|build|dist|tests?)[\\/]' }
    )
    $pythonViolations = @($pythonFiles | Select-String -Pattern '^\s*(from|import)\s+(httpx|requests|urllib|socket)\b')
    if ($pythonViolations.Count -ne 0) {
        throw "M6_STATIC_NETWORK_VIOLATION: $($pythonViolations[0].Path)"
    }
    $config = Get-Content -Raw -LiteralPath (Join-Path $repoRoot 'apps\desktop\src-tauri\tauri.conf.json') | ConvertFrom-Json
    if ([string]$config.app.security.csp -match 'connect-src[^;]*(https:|wss:)') {
        throw 'M6_CSP_NETWORK_VIOLATION: WebView connect-src permits external HTTPS/WSS.'
    }
    return [ordered]@{
        webNetworkApiMatches = 0
        rustNetworkAdaptersOutsideModelManager = 0
        analyzerNetworkImports = 0
        cspExternalConnectAllowed = $false
        approvedNetworkAdapter = 'apps/desktop/src-tauri/src/model_manager.rs, explicit model consent only'
    }
}

$process = $null
try {
$staticReview = Assert-StaticNetworkBoundary
$install = Start-Process -FilePath $installer -ArgumentList @('/S', "/D=$installRoot") -Wait -PassThru -WindowStyle Hidden
if ($install.ExitCode -ne 0) {
    throw "M6_PRIVACY_INSTALL_FAILED: $($install.ExitCode)"
}
$app = Join-Path $installRoot 'cybermuse-desktop.exe'
$uninstaller = Join-Path $installRoot 'uninstall.exe'
if (-not (Test-Path -LiteralPath $app -PathType Leaf) -or -not (Test-Path -LiteralPath $uninstaller -PathType Leaf)) {
    throw 'M6_PRIVACY_INSTALLED_PAYLOAD_INVALID'
}

$forcedTermination = $false
$observedClasses = [System.Collections.Generic.HashSet[string]]::new()
$appControlledExternal = [System.Collections.Generic.HashSet[string]]::new()
$webViewExternal = [System.Collections.Generic.HashSet[string]]::new()
try {
    $start = [System.Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $app
    $start.WorkingDirectory = $installRoot
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $start
    [void]$process.Start()
    Start-Sleep -Seconds 2
    if ($process.HasExited) {
        throw "M6_PRIVACY_APP_EXITED: $($process.ExitCode)"
    }
    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    while ($watch.Elapsed.TotalSeconds -lt $CaptureSeconds) {
        $ids = @(Get-ProcessTreeIds $process.Id)
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
            $external = $remote -notin @('', '0.0.0.0', '::', '127.0.0.1', '::1', '*')
            [void]$observedClasses.Add("${name}:tcp:$($connection.State)")
            if ($external -and $name -eq 'msedgewebview2') {
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
            [void]$observedClasses.Add("${name}:udp:bound")
            if ($name -ne 'msedgewebview2') {
                [void]$appControlledExternal.Add("${name}:udp:bound")
            }
        }
        Start-Sleep -Milliseconds 100
    }
    $watch.Stop()
}
finally {
    if ($null -ne $process -and -not $process.HasExited) {
        [void]$process.CloseMainWindow()
        if (-not $process.WaitForExit(5000)) {
            $process.Kill()
            $process.WaitForExit()
            $forcedTermination = $true
        }
    }
}

if ($appControlledExternal.Count -ne 0) {
    throw "M6_APP_NETWORK_VIOLATION: $([string]::Join(',', @($appControlledExternal)))"
}
if (-not (Test-Path -LiteralPath $eventsPath -PathType Leaf)) {
    throw 'M6_DIAGNOSTIC_LOG_MISSING: packaged startup did not create the versioned event log.'
}
$eventsText = Get-Content -Raw -LiteralPath $eventsPath
$events = $eventsText | ConvertFrom-Json
if ($events.schemaVersion -ne 1 -or @($events.events).Count -lt 1) {
    throw 'M6_DIAGNOSTIC_LOG_INVALID'
}
if ($eventsText -match '[A-Za-z]:\\|audioBytes|pitchTrack|filePath|deviceId|deviceName|accountId|-----BEGIN PRIVATE KEY-----') {
    throw 'M6_DIAGNOSTIC_LOG_REDACTION_FAILED'
}

if ($eventsExistedBefore) {
    [System.IO.File]::WriteAllBytes($eventsPath, $eventsBytesBefore)
}
else {
    Remove-Item -LiteralPath $eventsPath -Force
}
$userDataMetadataAfter = Get-UserDataMetadataHash
if ($userDataMetadataBefore -ne $userDataMetadataAfter) {
    throw 'M6_USER_DATA_CHANGED: packaged startup changed an existing non-log application file.'
}

$uninstall = Start-Process -FilePath $uninstaller -ArgumentList @('/S') -Wait -PassThru -WindowStyle Hidden
if ($uninstall.ExitCode -ne 0) {
    throw "M6_PRIVACY_UNINSTALL_FAILED: $($uninstall.ExitCode)"
}
for ($attempt = 0; $attempt -lt 50 -and (Test-Path -LiteralPath $installRoot); $attempt++) {
    Start-Sleep -Milliseconds 200
}
if (Test-Path -LiteralPath $installRoot) {
    throw 'M6_PRIVACY_UNINSTALL_LEFTOVERS'
}

$report = [ordered]@{
    schemaVersion = 1
    testCases = @('TC-PRIV-001', 'TC-NET-001', 'TC-DIA-002')
    generatedAt = [DateTimeOffset]::UtcNow.ToString('O')
    status = 'passed-development-host'
    capture = [ordered]@{
        durationSeconds = $CaptureSeconds
        intervalMs = 100
        processTree = 'CyberMuse root plus descendants'
        retainedEndpointData = 'process class, protocol and state only; no addresses or device identifiers'
        observedClasses = @($observedClasses | Sort-Object)
        appControlledExternalEndpointClasses = @($appControlledExternal)
        systemWebView2ExternalEndpointClasses = @($webViewExternal | Sort-Object)
        platformBoundary = 'System WebView2 mandatory diagnostics are governed by Windows settings and tracked by RISK-018.'
    }
    staticReview = $staticReview
    diagnostics = [ordered]@{
        schemaVersion = $events.schemaVersion
        eventCount = @($events.events).Count
        forbiddenFieldOrPathMatches = 0
        retentionPolicy = '14 days / 200 events, Rust automated tests'
    }
    isolation = [ordered]@{
        appDataExistedBefore = $appDataExistedBefore
        existingNonLogFilesUnchanged = $true
        diagnosticLogRestoredAfterCapture = $true
        appForcedTermination = $forcedTermination
    }
    remainingGate = 'Repeat the packaged offline workflow and capture on the independent clean Windows 11 host.'
}
New-Item -ItemType Directory -Path (Split-Path -Parent $output) -Force | Out-Null
[System.IO.File]::WriteAllText(
    $output,
    (($report | ConvertTo-Json -Depth 8) + [Environment]::NewLine),
    [System.Text.UTF8Encoding]::new($false)
)

Write-Host "M6 privacy/network: PASS (app endpoints 0, WebView2 classes $($webViewExternal.Count), logs redacted)"
}
finally {
    if ($null -ne $process -and -not $process.HasExited) {
        [void]$process.CloseMainWindow()
        if (-not $process.WaitForExit(5000)) {
            $process.Kill()
            $process.WaitForExit()
        }
    }

    if ($eventsExistedBefore) {
        [System.IO.Directory]::CreateDirectory((Split-Path -Parent $eventsPath)) | Out-Null
        [System.IO.File]::WriteAllBytes($eventsPath, $eventsBytesBefore)
    }
    elseif (Test-Path -LiteralPath $eventsPath -PathType Leaf) {
        Remove-Item -LiteralPath $eventsPath -Force
    }

    if (Test-Path -LiteralPath $installRoot -PathType Container) {
        $cleanupUninstaller = Join-Path $installRoot 'uninstall.exe'
        if (Test-Path -LiteralPath $cleanupUninstaller -PathType Leaf) {
            $cleanup = Start-Process -FilePath $cleanupUninstaller -ArgumentList @('/S') -Wait -PassThru -WindowStyle Hidden
            if ($cleanup.ExitCode -ne 0) {
                throw "M6_PRIVACY_CLEANUP_UNINSTALL_FAILED: $($cleanup.ExitCode)"
            }
            for ($attempt = 0; $attempt -lt 50 -and (Test-Path -LiteralPath $installRoot); $attempt++) {
                Start-Sleep -Milliseconds 200
            }
        }
        if (Test-Path -LiteralPath $installRoot -PathType Container) {
            Remove-Item -LiteralPath $installRoot -Recurse -Force
        }
    }
}
