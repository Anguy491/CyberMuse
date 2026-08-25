$ErrorActionPreference = "Stop"

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$artifactRoot = Join-Path $repoRoot "artifacts\m4"
$uv = Join-Path $env:USERPROFILE ".cache\cybermuse-tools\uv-0.12.5\uv.exe"
$cargo = Join-Path $env:USERPROFILE ".cargo\bin\cargo.exe"
New-Item -ItemType Directory -Force -Path $artifactRoot | Out-Null

$results = [ordered]@{}
function Write-Utf8NoBom {
    param([string]$Path, [string]$Value)
    [System.IO.File]::WriteAllText($Path, $Value, [System.Text.UTF8Encoding]::new($false))
}
Push-Location (Join-Path $repoRoot "analyzer")
try {
    & $uv run pytest -m contract
    $results.pythonExitCode = $LASTEXITCODE
}
finally { Pop-Location }
if ($results.pythonExitCode -ne 0) { exit $results.pythonExitCode }

Push-Location $repoRoot
try {
    & $cargo test --workspace --all-features
    $results.rustExitCode = $LASTEXITCODE
    if ($results.rustExitCode -ne 0) { exit $results.rustExitCode }
    & pnpm test:contracts
    $results.typeScriptExitCode = $LASTEXITCODE
    if ($results.typeScriptExitCode -ne 0) { exit $results.typeScriptExitCode }
}
finally { Pop-Location }

$report = [ordered]@{
    schemaVersion = 1
    testCase = "TC-CON-001/TC-AN-001/TC-AN-002/TC-PATH-001"
    generatedAt = [DateTimeOffset]::UtcNow.ToString("o")
    status = "passed"
    sharedFixtureRoot = "fixtures/contracts/analyzer"
    languages = $results
}
Write-Utf8NoBom -Path (Join-Path $artifactRoot "analyzer-contracts.json") -Value ($report | ConvertTo-Json -Depth 4)
