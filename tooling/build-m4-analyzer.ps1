$ErrorActionPreference = "Stop"

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$artifactRoot = [System.IO.Path]::GetFullPath((Join-Path $repoRoot "artifacts\m4"))
$uv = Join-Path $env:USERPROFILE ".cache\cybermuse-tools\uv-0.12.5\uv.exe"
if (-not (Test-Path -LiteralPath $uv -PathType Leaf)) {
    throw "uv 0.12.5 is not installed in the approved tool cache"
}

function Get-Sha256 {
    param([string]$Path)
    $stream = [System.IO.File]::OpenRead($Path)
    try {
        $algorithm = [System.Security.Cryptography.SHA256]::Create()
        try {
            return ([System.BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
        }
        finally { $algorithm.Dispose() }
    }
    finally { $stream.Dispose() }
}

$analyzerRoot = Join-Path $repoRoot "analyzer"
$analyzerDist = Join-Path $artifactRoot "analyzer-dist"
$analyzerWork = Join-Path $artifactRoot "analyzer-build"
Push-Location $analyzerRoot
try {
    & $uv sync --frozen --all-groups
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & $uv run pyinstaller --noconfirm --clean --distpath $analyzerDist --workpath $analyzerWork "cybermuse-analyzer.spec"
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
finally {
    Pop-Location
}

$resourceRoot = [System.IO.Path]::GetFullPath((Join-Path $artifactRoot "tauri-resources"))
if (-not $resourceRoot.StartsWith($artifactRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to replace a resource directory outside artifacts/m4"
}
if (Test-Path -LiteralPath $resourceRoot) {
    Remove-Item -LiteralPath $resourceRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $resourceRoot | Out-Null

$analyzerSource = Join-Path $analyzerDist "cybermuse-analyzer"
if (-not (Test-Path -LiteralPath (Join-Path $analyzerSource "cybermuse-analyzer.exe") -PathType Leaf)) {
    throw "Packaged analyzer executable is missing"
}
Copy-Item -LiteralPath $analyzerSource -Destination (Join-Path $resourceRoot "analyzer") -Recurse

$ffmpegInstall = Join-Path $env:LOCALAPPDATA "CyberMuse\tools\ffmpeg-lgpl-shared\n9.0.1-6-g9d4ca21220\payload\ffmpeg-n9.0.1-6-g9d4ca21220-win64-lgpl-shared-9.0"
$ffmpegBin = Join-Path $ffmpegInstall "bin"
$ffmpegDestination = Join-Path $resourceRoot "ffmpeg"
New-Item -ItemType Directory -Path $ffmpegDestination | Out-Null
$ffmpegFiles = @(
    "ffmpeg.exe", "ffprobe.exe", "avcodec-63.dll", "avdevice-63.dll", "avfilter-12.dll",
    "avformat-63.dll", "avutil-61.dll", "swresample-7.dll", "swscale-10.dll"
)
foreach ($name in $ffmpegFiles) {
    $source = Join-Path $ffmpegBin $name
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Approved FFmpeg runtime is incomplete: $name" }
    Copy-Item -LiteralPath $source -Destination (Join-Path $ffmpegDestination $name)
}
Copy-Item -LiteralPath (Join-Path $ffmpegInstall "LICENSE.txt") -Destination (Join-Path $ffmpegDestination "LICENSE.txt")

$files = Get-ChildItem -LiteralPath $resourceRoot -Recurse -File | Sort-Object FullName
$manifestFiles = foreach ($file in $files) {
    [ordered]@{
        relativePath = $file.FullName.Substring($resourceRoot.Length + 1).Replace("\", "/")
        sizeBytes = $file.Length
        sha256 = Get-Sha256 -Path $file.FullName
    }
}
$manifest = [ordered]@{
    schemaVersion = 1
    generatedAt = [DateTimeOffset]::UtcNow.ToString("o")
    analyzerVersion = "0.1.0"
    ffmpegVersion = "n9.0.1-6-g9d4ca21220"
    files = @($manifestFiles)
}
$manifestJson = $manifest | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText(
    (Join-Path $resourceRoot "runtime-manifest.json"),
    $manifestJson,
    [System.Text.UTF8Encoding]::new($false)
)

& (Join-Path $resourceRoot "analyzer\cybermuse-analyzer.exe") --version --json
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
