$ErrorActionPreference = "Stop"

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$uv = Join-Path $env:USERPROFILE ".cache\cybermuse-tools\uv-0.12.5\uv.exe"
if (-not (Test-Path -LiteralPath $uv -PathType Leaf)) {
    throw "uv 0.12.5 is not installed in the approved tool cache"
}

Push-Location (Join-Path $repoRoot "analyzer")
try {
    & $uv sync --frozen --all-groups
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & $uv run ruff format --check .
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & $uv run ruff check .
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & $uv run mypy .
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & $uv run pytest
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
finally {
    Pop-Location
}
