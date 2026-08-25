$ErrorActionPreference = "Stop"

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$artifactRoot = Join-Path $repoRoot "artifacts\m4"
$uv = Join-Path $env:USERPROFILE ".cache\cybermuse-tools\uv-0.12.5\uv.exe"
$modelRoot = Join-Path $env:LOCALAPPDATA "CyberMuse\models"
$ffmpeg = Join-Path $artifactRoot "tauri-resources\ffmpeg\ffmpeg.exe"
$ffprobe = Join-Path $artifactRoot "tauri-resources\ffmpeg\ffprobe.exe"
$spleeter = Join-Path $artifactRoot "spleeter-engine-dist\cybermuse-spleeter-engine\cybermuse-spleeter-engine.exe"
foreach ($path in @($uv, $artifactRoot, $modelRoot, $ffmpeg, $ffprobe, $spleeter)) {
    if (-not (Test-Path -LiteralPath $path)) { throw "Required M4 quality input is missing" }
}

Push-Location (Join-Path $repoRoot "analyzer")
try {
    & $uv run python scripts/m4_quality_report.py --artifact-root $artifactRoot --model-root $modelRoot --ffmpeg $ffmpeg --ffprobe $ffprobe --spleeter-engine $spleeter
    exit $LASTEXITCODE
}
finally { Pop-Location }
