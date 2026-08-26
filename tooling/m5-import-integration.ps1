$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
$ffmpegRoot = Join-Path $repoRoot 'artifacts\m4\tauri-resources\ffmpeg'
$ffmpeg = Join-Path $ffmpegRoot 'ffmpeg.exe'
$ffprobe = Join-Path $ffmpegRoot 'ffprobe.exe'
$artifactRoot = Join-Path $repoRoot 'artifacts\m5'
$runRoot = Join-Path $artifactRoot 'import-integration-work'
$reportPath = Join-Path $artifactRoot 'import-integration.json'

if (-not (Test-Path -LiteralPath $ffmpeg -PathType Leaf) -or -not (Test-Path -LiteralPath $ffprobe -PathType Leaf)) {
  throw 'M4 bundled FFmpeg tools are required. Run pnpm build:analyzer first.'
}

New-Item -ItemType Directory -Force -Path $artifactRoot | Out-Null
if (Test-Path -LiteralPath $runRoot) {
  $resolvedRun = (Resolve-Path -LiteralPath $runRoot).Path
  $resolvedArtifact = (Resolve-Path -LiteralPath $artifactRoot).Path
  if (-not $resolvedRun.StartsWith($resolvedArtifact, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Refusing to clean an integration path outside artifacts/m5.'
  }
  Remove-Item -LiteralPath $resolvedRun -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $runRoot | Out-Null

try {
  $output = & cargo run --quiet --manifest-path (Join-Path $repoRoot 'apps\desktop\src-tauri\Cargo.toml') --example m5_import_validation -- $ffmpeg $ffprobe $runRoot
  if ($LASTEXITCODE -ne 0) {
    throw "M5 import validation exited with $LASTEXITCODE."
  }
  $report = $output | Select-Object -Last 1 | ConvertFrom-Json
  if ($report.result -ne 'pass') {
    throw 'M5 import validation did not report pass.'
  }
  $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $reportPath -Encoding UTF8
  Write-Output ($report | ConvertTo-Json -Compress -Depth 8)
}
finally {
  if (Test-Path -LiteralPath $runRoot) {
    $resolvedRun = (Resolve-Path -LiteralPath $runRoot).Path
    $resolvedArtifact = (Resolve-Path -LiteralPath $artifactRoot).Path
    if ($resolvedRun.StartsWith($resolvedArtifact, [StringComparison]::OrdinalIgnoreCase)) {
      Remove-Item -LiteralPath $resolvedRun -Recurse -Force
    }
  }
}
