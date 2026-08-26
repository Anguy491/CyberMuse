param(
    [string]$InstallerPath = 'target/release/bundle/nsis/CyberMuse_0.1.0_x64-setup.exe',
    [string]$InstallPath = 'artifacts/m6/install-smoke',
    [string]$OutputPath = 'artifacts/m6/installer-smoke.json'
)

$ErrorActionPreference = 'Stop'
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$installer = [System.IO.Path]::GetFullPath((Join-Path $repoRoot $InstallerPath))
$installRoot = [System.IO.Path]::GetFullPath((Join-Path $repoRoot $InstallPath))
$output = [System.IO.Path]::GetFullPath((Join-Path $repoRoot $OutputPath))
$allowedRoot = [System.IO.Path]::GetFullPath((Join-Path $repoRoot 'artifacts\m6'))

if (-not $installRoot.StartsWith($allowedRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'M6_INSTALL_TARGET_INVALID: install target must be a child of artifacts/m6.'
}
if ($installRoot.Contains(' ')) {
    throw 'M6_INSTALL_TARGET_INVALID: NSIS silent /D smoke target must not contain spaces.'
}
if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
    throw "M6_INSTALLER_MISSING: $installer"
}
if (Test-Path -LiteralPath $installRoot) {
    throw "M6_INSTALL_TARGET_EXISTS: refusing to overwrite $installRoot"
}
if (Test-Path -LiteralPath $output) {
    throw "M6_EVIDENCE_EXISTS: refusing to overwrite $output"
}

function Get-Sha256([string]$Path) {
    $stream = [System.IO.File]::OpenRead($Path)
    try {
        $algorithm = [System.Security.Cryptography.SHA256]::Create()
        try {
            return ([System.BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
        }
        finally {
            $algorithm.Dispose()
        }
    }
    finally {
        $stream.Dispose()
    }
}

function Get-DirectorySnapshot([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
        return [ordered]@{ exists = $false; fileCount = 0; totalBytes = 0; metadataSha256 = $null }
    }
    $entries = @(
        Get-ChildItem -LiteralPath $Path -File -Recurse | Sort-Object FullName | ForEach-Object {
            $relative = $_.FullName.Substring($Path.Length).TrimStart('\').Replace('\', '/')
            "$relative|$($_.Length)|$($_.LastWriteTimeUtc.Ticks)"
        }
    )
    $text = [string]::Join("`n", $entries)
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($text)
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    try {
        $digest = ([System.BitConverter]::ToString($algorithm.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
    }
    finally {
        $algorithm.Dispose()
    }
    return [ordered]@{
        exists = $true
        fileCount = $entries.Count
        totalBytes = [long](Get-ChildItem -LiteralPath $Path -File -Recurse | Measure-Object Length -Sum).Sum
        metadataSha256 = $digest
    }
}

function Invoke-Installer([string]$Path) {
    $process = Start-Process -FilePath $installer -ArgumentList @('/S', "/D=$Path") -Wait -PassThru -WindowStyle Hidden
    if ($process.ExitCode -ne 0) {
        throw "M6_INSTALL_FAILED: NSIS exited $($process.ExitCode)"
    }
}

function Assert-InstalledPayload {
    $required = @(
        'THIRD_PARTY_NOTICES.txt',
        'cybermuse-0.1.0.spdx.json',
        'model-manifest.json',
        'runtime-manifest.json',
        'analyzer\cybermuse-analyzer.exe',
        'spleeter-engine\cybermuse-spleeter-engine.exe',
        'ffmpeg\ffmpeg.exe',
        'ffmpeg\ffprobe.exe',
        'uninstall.exe'
    )
    foreach ($relativePath in $required) {
        if (-not (Test-Path -LiteralPath (Join-Path $installRoot $relativePath) -PathType Leaf)) {
            throw "M6_INSTALLED_FILE_MISSING: $relativePath"
        }
    }
    $mainExecutables = @(Get-ChildItem -LiteralPath $installRoot -File -Filter '*.exe' | Where-Object Name -ne 'uninstall.exe')
    if ($mainExecutables.Count -ne 1) {
        throw "M6_MAIN_EXECUTABLE_INVALID: expected one main executable, got $($mainExecutables.Count)"
    }
    $supplyPairs = @(
        @('THIRD_PARTY_NOTICES.txt', 'artifacts\m6\THIRD_PARTY_NOTICES.txt'),
        @('cybermuse-0.1.0.spdx.json', 'artifacts\m6\cybermuse-0.1.0.spdx.json'),
        @('model-manifest.json', 'artifacts\m6\model-manifest.json')
    )
    foreach ($pair in $supplyPairs) {
        $installedHash = Get-Sha256 (Join-Path $installRoot $pair[0])
        $sourceHash = Get-Sha256 (Join-Path $repoRoot $pair[1])
        if ($installedHash -ne $sourceHash) {
            throw "M6_SUPPLY_ASSET_MISMATCH: $($pair[0])"
        }
    }
    $forbiddenExtensions = @('.wav', '.mp3', '.flac', '.log', '.key')
    $forbiddenFiles = @(
        Get-ChildItem -LiteralPath $installRoot -File -Recurse | Where-Object {
            $forbiddenExtensions -contains $_.Extension.ToLowerInvariant() -or $_.Name -match '^\.env($|\.)'
        }
    )
    if ($forbiddenFiles.Count -ne 0) {
        throw "M6_FORBIDDEN_PAYLOAD: $($forbiddenFiles[0].Name)"
    }
    $textFiles = @(Get-ChildItem -LiteralPath $installRoot -File -Recurse | Where-Object Extension -in @('.json', '.txt', '.js', '.css', '.html', '.md', '.toml', '.pem'))
    foreach ($file in $textFiles) {
        $text = [System.IO.File]::ReadAllText($file.FullName)
        if ($text.IndexOf($repoRoot, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -or
            $text.IndexOf($env:USERPROFILE, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -or
            $text.Contains('-----BEGIN PRIVATE KEY-----')) {
            throw "M6_SENSITIVE_TEXT_FOUND: $($file.Name)"
        }
    }
    $allFiles = @(Get-ChildItem -LiteralPath $installRoot -File -Recurse)
    return [ordered]@{
        mainExecutable = $mainExecutables[0].Name
        fileCount = $allFiles.Count
        totalBytes = [long]($allFiles | Measure-Object Length -Sum).Sum
        supplyAssetsByteIdentical = $true
        forbiddenPayloadCount = 0
        sensitiveTextScanPassed = $true
    }
}

$userDataRoots = [ordered]@{
    localCyberMuse = Join-Path $env:LOCALAPPDATA 'CyberMuse'
    localIdentifier = Join-Path $env:LOCALAPPDATA 'com.cybermuse.desktop'
    roamingIdentifier = Join-Path $env:APPDATA 'com.cybermuse.desktop'
}
$beforeUserData = [ordered]@{}
foreach ($entry in $userDataRoots.GetEnumerator()) {
    $beforeUserData[$entry.Key] = Get-DirectorySnapshot $entry.Value
}

Invoke-Installer $installRoot
$firstInstall = Assert-InstalledPayload
Invoke-Installer $installRoot
$sameVersionInstall = Assert-InstalledPayload
$uninstaller = Join-Path $installRoot 'uninstall.exe'
$uninstallProcess = Start-Process -FilePath $uninstaller -ArgumentList @('/S') -Wait -PassThru -WindowStyle Hidden
if ($uninstallProcess.ExitCode -ne 0) {
    throw "M6_UNINSTALL_FAILED: NSIS exited $($uninstallProcess.ExitCode)"
}
for ($attempt = 0; $attempt -lt 50 -and (Test-Path -LiteralPath $installRoot); $attempt++) {
    Start-Sleep -Milliseconds 200
}
if (Test-Path -LiteralPath $installRoot) {
    $leftovers = @(Get-ChildItem -LiteralPath $installRoot -Force -Recurse)
    if ($leftovers.Count -ne 0) {
        throw "M6_UNINSTALL_LEFTOVERS: $($leftovers.Count) entries remain"
    }
}

$afterUserData = [ordered]@{}
$userDataUnchanged = $true
foreach ($entry in $userDataRoots.GetEnumerator()) {
    $afterUserData[$entry.Key] = Get-DirectorySnapshot $entry.Value
    if (($beforeUserData[$entry.Key] | ConvertTo-Json -Compress) -ne ($afterUserData[$entry.Key] | ConvertTo-Json -Compress)) {
        $userDataUnchanged = $false
    }
}
if (-not $userDataUnchanged) {
    throw 'M6_USER_DATA_CHANGED: install/upgrade/uninstall smoke touched application data without launching the app.'
}

$report = [ordered]@{
    schemaVersion = 1
    testCase = 'TC-PLAT-001'
    generatedAt = [DateTimeOffset]::UtcNow.ToString('O')
    host = [ordered]@{
        os = [Environment]::OSVersion.VersionString
        architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
        cleanHost = $false
    }
    installer = [ordered]@{
        fileName = [System.IO.Path]::GetFileName($installer)
        sizeBytes = (Get-Item -LiteralPath $installer).Length
        sha256 = Get-Sha256 $installer
        signed = $false
        silentTarget = $installRoot.Substring($repoRoot.Length + 1).Replace('\', '/')
    }
    firstInstall = $firstInstall
    sameVersionReinstall = $sameVersionInstall
    uninstall = [ordered]@{ exitCode = 0; payloadRemoved = $true }
    existingUserDataUnchanged = $userDataUnchanged
    appLaunchPerformed = $false
    status = 'passed-development-host'
    remainingGate = 'Independent clean Windows 11 install, Defender scan, launch, offline practice and uninstall are still required.'
}
New-Item -ItemType Directory -Path (Split-Path -Parent $output) -Force | Out-Null
[System.IO.File]::WriteAllText(
    $output,
    (($report | ConvertTo-Json -Depth 8) + [Environment]::NewLine),
    [System.Text.UTF8Encoding]::new($false)
)
Write-Host "M6 installer smoke: PASS ($($firstInstall.fileCount) installed files, user data unchanged)"
