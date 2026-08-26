param(
    [string]$CacheRoot = (Join-Path $env:LOCALAPPDATA 'tauri')
)

$ErrorActionPreference = 'Stop'
$nsisUrl = 'https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.11/nsis-3.11.zip'
$nsisSha256 = 'c7d27f780ddb6cffb4730138cd1591e841f4b7edb155856901cdf5f214394fa1'
$utilsUrl = 'https://github.com/tauri-apps/nsis-tauri-utils/releases/download/nsis_tauri_utils-v0.5.3/nsis_tauri_utils.dll'
$utilsSha256 = '5ba143b5db4a87d32d6e7802e033330aae56cbceabe0d1e3ba41948385ad4709'
$destination = Join-Path $CacheRoot 'NSIS'
$manifestName = 'cybermuse-toolchain-manifest.json'
$requiredFiles = @(
    'makensis.exe',
    'Bin\makensis.exe',
    'Stubs\zlib-x86-unicode',
    'Plugins\x86-unicode\additional\nsis_tauri_utils.dll',
    'Include\MUI2.nsh',
    'Include\FileFunc.nsh',
    'Include\x64.nsh',
    'Include\nsDialogs.nsh',
    'Include\WinMessages.nsh',
    'Include\Win\COM.nsh',
    'Include\Win\Propkey.nsh',
    'Include\Win\RestartManager.nsh'
)

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

function Get-RelativePath([string]$BasePath, [string]$ChildPath) {
    $baseFullPath = [System.IO.Path]::GetFullPath($BasePath).TrimEnd('\') + '\'
    $childFullPath = [System.IO.Path]::GetFullPath($ChildPath)
    $baseUri = [System.Uri]::new($baseFullPath)
    $childUri = [System.Uri]::new($childFullPath)
    return [System.Uri]::UnescapeDataString($baseUri.MakeRelativeUri($childUri).ToString())
}

function Test-ReviewedCache {
    $manifestPath = Join-Path $destination $manifestName
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        return $false
    }
    $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
    if ($manifest.schemaVersion -ne 1 -or $manifest.nsisVersion -ne '3.11' -or $manifest.utilsVersion -ne '0.5.3') {
        return $false
    }
    foreach ($relativePath in $requiredFiles) {
        if (-not (Test-Path -LiteralPath (Join-Path $destination $relativePath) -PathType Leaf)) {
            return $false
        }
    }
    foreach ($file in $manifest.files) {
        $path = Join-Path $destination ([string]$file.relativePath)
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            return $false
        }
        $actual = Get-Sha256 $path
        if ($actual -ne [string]$file.sha256 -or (Get-Item -LiteralPath $path).Length -ne [long]$file.sizeBytes) {
            return $false
        }
    }
    $actualFiles = @(Get-ChildItem -LiteralPath $destination -File -Recurse | Where-Object Name -ne $manifestName)
    return $actualFiles.Count -eq @($manifest.files).Count
}

if (Test-ReviewedCache) {
    Write-Host 'M6 installer toolchain: PASS (reviewed NSIS 3.11 cache reused)'
    exit 0
}
if (Test-Path -LiteralPath $destination) {
    throw 'M6_NSIS_CACHE_UNREVIEWED: the existing NSIS cache is incomplete or differs from the reviewed manifest. Move it aside and rerun this command.'
}

$resolvedCacheRoot = [System.IO.Path]::GetFullPath($CacheRoot)
New-Item -ItemType Directory -Path $resolvedCacheRoot -Force | Out-Null
$stage = Join-Path $resolvedCacheRoot ('cybermuse-nsis-stage-' + [guid]::NewGuid().ToString('N'))
$resolvedStage = [System.IO.Path]::GetFullPath($stage)
if (-not $resolvedStage.StartsWith($resolvedCacheRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'M6_NSIS_STAGE_INVALID: staging path escaped the intended cache root.'
}
New-Item -ItemType Directory -Path $resolvedStage | Out-Null

try {
    $archive = Join-Path $resolvedStage 'nsis-3.11.zip'
    Invoke-WebRequest -UseBasicParsing -Uri $nsisUrl -OutFile $archive
    $archiveHash = Get-Sha256 $archive
    if ($archiveHash -ne $nsisSha256) {
        throw "M6_NSIS_HASH_MISMATCH: expected $nsisSha256, got $archiveHash"
    }
    Expand-Archive -LiteralPath $archive -DestinationPath $resolvedStage
    $prepared = Join-Path $resolvedStage 'nsis-3.11'
    if (-not (Test-Path -LiteralPath $prepared -PathType Container)) {
        throw 'M6_NSIS_ARCHIVE_INVALID: expected nsis-3.11 root is missing.'
    }
    $utilsTarget = Join-Path $prepared 'Plugins\x86-unicode\additional\nsis_tauri_utils.dll'
    New-Item -ItemType Directory -Path (Split-Path -Parent $utilsTarget) -Force | Out-Null
    Invoke-WebRequest -UseBasicParsing -Uri $utilsUrl -OutFile $utilsTarget
    $utilsHash = Get-Sha256 $utilsTarget
    if ($utilsHash -ne $utilsSha256) {
        throw "M6_NSIS_UTILS_HASH_MISMATCH: expected $utilsSha256, got $utilsHash"
    }
    foreach ($relativePath in $requiredFiles) {
        if (-not (Test-Path -LiteralPath (Join-Path $prepared $relativePath) -PathType Leaf)) {
            throw "M6_NSIS_REQUIRED_FILE_MISSING: $relativePath"
        }
    }
    $files = @(
        Get-ChildItem -LiteralPath $prepared -File -Recurse | ForEach-Object {
            [ordered]@{
                relativePath = Get-RelativePath $prepared $_.FullName
                sizeBytes = $_.Length
                sha256 = Get-Sha256 $_.FullName
            }
        }
    )
    $manifest = [ordered]@{
        schemaVersion = 1
        nsisVersion = '3.11'
        nsisArchiveSha256 = $nsisSha256
        utilsVersion = '0.5.3'
        utilsSha256 = $utilsSha256
        compressionRestriction = 'zlib'
        files = $files
    }
    [System.IO.File]::WriteAllText(
        (Join-Path $prepared $manifestName),
        (($manifest | ConvertTo-Json -Depth 5) + [Environment]::NewLine),
        [System.Text.UTF8Encoding]::new($false)
    )
    Move-Item -LiteralPath $prepared -Destination $destination
    Write-Host "M6 installer toolchain: PASS ($($files.Count) reviewed files)"
}
finally {
    if (Test-Path -LiteralPath $resolvedStage) {
        $verifiedStage = [System.IO.Path]::GetFullPath($resolvedStage)
        if ($verifiedStage.StartsWith($resolvedCacheRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
            Remove-Item -LiteralPath $verifiedStage -Recurse -Force
        }
    }
}
