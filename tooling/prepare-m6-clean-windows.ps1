[CmdletBinding()]
param(
    [string]$Destination = "",
    [switch]$AllowDirtyDiagnostic
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

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$artifactRoot = [System.IO.Path]::GetFullPath((Join-Path $repoRoot "artifacts\m6"))
$destinationRoot = if ([string]::IsNullOrWhiteSpace($Destination)) {
    Join-Path $artifactRoot "clean-windows-package"
}
elseif ([System.IO.Path]::IsPathRooted($Destination)) {
    [System.IO.Path]::GetFullPath($Destination)
}
else {
    [System.IO.Path]::GetFullPath((Join-Path $repoRoot $Destination))
}
if (-not $destinationRoot.StartsWith(
        $artifactRoot + [System.IO.Path]::DirectorySeparatorChar,
        [System.StringComparison]::OrdinalIgnoreCase
    )) {
    throw "M6_CLEAN_PACKAGE_TARGET_INVALID: destination must stay under artifacts/m6."
}
if (Test-Path -LiteralPath $destinationRoot) {
    throw "M6_CLEAN_PACKAGE_TARGET_EXISTS: refusing to overwrite $destinationRoot"
}

$releaseManifestPath = Join-Path $artifactRoot "release-manifest.json"
if (-not (Test-Path -LiteralPath $releaseManifestPath -PathType Leaf)) {
    throw "M6_CLEAN_RELEASE_MANIFEST_MISSING: run pnpm build:m6 first."
}
$releaseManifest = Get-Content -LiteralPath $releaseManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($releaseManifest.schemaVersion -ne 1 -or $releaseManifest.applicationVersion -ne "0.1.0") {
    throw "M6_CLEAN_RELEASE_MANIFEST_INVALID"
}
if ([bool]$releaseManifest.dirtyWorktree -and -not $AllowDirtyDiagnostic) {
    throw "M6_CLEAN_RELEASE_DIRTY: rebuild from a clean worktree, or use -AllowDirtyDiagnostic for a non-gate package."
}

$installerRecord = @($releaseManifest.artifacts | Where-Object relativePath -Like "*/CyberMuse_0.1.0_x64-setup.exe") | Select-Object -First 1
if ($null -eq $installerRecord) {
    throw "M6_CLEAN_INSTALLER_RECORD_MISSING"
}
$installer = [System.IO.Path]::GetFullPath((Join-Path $repoRoot ([string]$installerRecord.relativePath).Replace("/", "\")))
if (-not (Test-Path -LiteralPath $installer -PathType Leaf) -or
    (Get-Item -LiteralPath $installer).Length -ne [long]$installerRecord.sizeBytes -or
    (Get-FileSha256 $installer) -ne [string]$installerRecord.sha256) {
    throw "M6_CLEAN_INSTALLER_INTEGRITY_FAILED"
}

$modelRoot = Join-Path $env:LOCALAPPDATA "CyberMuse\models"
$models = @(
    [ordered]@{
        relativePath = "spleeter-2stems/1.4.0/2stems.tar.gz"
        sha256 = "f3a90b39dd2874269e8b05a48a86745df897b848c61f3958efc80a39152bd692"
    },
    [ordered]@{
        relativePath = "swiftf0/0.1.2/swift_f0-0.1.2-py3-none-any.whl"
        sha256 = "212715116025a490be70db0afda8fb27b1eadf267a3b18ed8df4866c1574e717"
    }
)
foreach ($model in $models) {
    $source = Join-Path $modelRoot ([string]$model.relativePath).Replace("/", "\")
    if (-not (Test-Path -LiteralPath $source -PathType Leaf) -or (Get-FileSha256 $source) -ne $model.sha256) {
        throw "M6_CLEAN_MODEL_INTEGRITY_FAILED: $($model.relativePath)"
    }
}

$smokeInput = Get-ChildItem -LiteralPath (Join-Path $repoRoot "artifacts\m4\smoke") -Filter "*.wav" -File -Recurse |
    Where-Object { $_.Directory.Name -like "long-path-*" -and $_.Name -notin @("vocals.wav", "instrumental.wav") } |
    Select-Object -First 1
if ($null -eq $smokeInput) {
    throw "M6_CLEAN_SMOKE_INPUT_MISSING: run the M4 integration fixture preparation first."
}

$copySources = [ordered]@{
    "CyberMuse_0.1.0_x64-setup.exe" = $installer
    "release-manifest.json" = $releaseManifestPath
    "cybermuse-0.1.0.spdx.json" = (Join-Path $artifactRoot "cybermuse-0.1.0.spdx.json")
    "THIRD_PARTY_NOTICES.txt" = (Join-Path $artifactRoot "THIRD_PARTY_NOTICES.txt")
    "model-manifest.json" = (Join-Path $artifactRoot "model-manifest.json")
    "m6-clean-windows-smoke.ps1" = (Join-Path $PSScriptRoot "m6-clean-windows-smoke.ps1")
}
foreach ($entry in $copySources.GetEnumerator()) {
    if (-not (Test-Path -LiteralPath $entry.Value -PathType Leaf)) {
        throw "M6_CLEAN_PACKAGE_SOURCE_MISSING: $($entry.Key)"
    }
}

[System.IO.Directory]::CreateDirectory($destinationRoot) | Out-Null
try {
    foreach ($entry in $copySources.GetEnumerator()) {
        Copy-Item -LiteralPath $entry.Value -Destination (Join-Path $destinationRoot $entry.Key)
    }
    Copy-Item -LiteralPath $smokeInput.FullName -Destination (Join-Path $destinationRoot "smoke-input.wav")
    foreach ($model in $models) {
        $source = Join-Path $modelRoot ([string]$model.relativePath).Replace("/", "\")
        $target = Join-Path (Join-Path $destinationRoot "models") ([string]$model.relativePath).Replace("/", "\")
        [System.IO.Directory]::CreateDirectory((Split-Path -Parent $target)) | Out-Null
        Copy-Item -LiteralPath $source -Destination $target
    }

    $gateEligible = -not [bool]$releaseManifest.dirtyWorktree -and -not $AllowDirtyDiagnostic
    $packageInfo = [ordered]@{
        schemaVersion = 1
        purpose = "Transfer this entire directory to an independent Windows 11 x64 runtime host."
        command = ".\m6-clean-windows-smoke.ps1 -PackageRoot . -EvidencePath .\m6-clean-windows-evidence.json"
        network = "Disconnect all network adapters before the gate run; the script never changes adapter state."
        sourceCommit = [string]$releaseManifest.commit
        applicationVersion = [string]$releaseManifest.applicationVersion
        installerSha256 = [string]$installerRecord.sha256
        sourceWorktreeDirty = [bool]$releaseManifest.dirtyWorktree
        gateEligible = $gateEligible
        generatedAt = [DateTimeOffset]::UtcNow.ToString("O")
    }
    [System.IO.File]::WriteAllText(
        (Join-Path $destinationRoot "README.json"),
        ($packageInfo | ConvertTo-Json -Depth 5),
        [System.Text.UTF8Encoding]::new($false)
    )

    $files = @(
        Get-ChildItem -LiteralPath $destinationRoot -File -Recurse |
            Sort-Object FullName |
            ForEach-Object {
                [ordered]@{
                    relativePath = $_.FullName.Substring($destinationRoot.Length + 1).Replace("\", "/")
                    sizeBytes = $_.Length
                    sha256 = Get-FileSha256 $_.FullName
                }
            }
    )
    $manifest = [ordered]@{
        schemaVersion = 1
        sourceCommit = [string]$releaseManifest.commit
        gateEligible = $gateEligible
        files = $files
    }
    [System.IO.File]::WriteAllText(
        (Join-Path $destinationRoot "package-manifest.json"),
        ($manifest | ConvertTo-Json -Depth 6),
        [System.Text.UTF8Encoding]::new($false)
    )
}
catch {
    if (Test-Path -LiteralPath $destinationRoot) {
        Remove-Item -LiteralPath $destinationRoot -Recurse -Force
    }
    throw
}

Write-Host "M6 clean Windows package: PASS ($($files.Count) files, gateEligible=$gateEligible)"
Write-Output $destinationRoot
