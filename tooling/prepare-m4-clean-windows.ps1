param([string]$Destination = "")

$ErrorActionPreference = "Stop"
function Get-FileSha256 {
    param([string]$Path)
    $stream = [IO.File]::OpenRead($Path)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return (($algorithm.ComputeHash($stream) | ForEach-Object { $_.ToString("x2") }) -join "") }
    finally { $algorithm.Dispose(); $stream.Dispose() }
}
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$artifactRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot "artifacts\m4"))
$destinationRoot = if ($Destination) { [IO.Path]::GetFullPath($Destination) } else { Join-Path $artifactRoot "clean-windows-package" }
if (-not $destinationRoot.StartsWith($artifactRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Clean Windows package destination must stay within artifacts/m4"
}
$resourceSource = Join-Path $artifactRoot "tauri-resources"
$smokeScriptSource = Join-Path $PSScriptRoot "m4-clean-windows-smoke.ps1"
$modelRoot = Join-Path $env:LOCALAPPDATA "CyberMuse\models"
$modelFiles = @(
    [ordered]@{ relative = "spleeter-2stems\1.4.0\2stems.tar.gz"; sha256 = "f3a90b39dd2874269e8b05a48a86745df897b848c61f3958efc80a39152bd692" },
    [ordered]@{ relative = "swiftf0\0.1.2\swift_f0-0.1.2-py3-none-any.whl"; sha256 = "212715116025a490be70db0afda8fb27b1eadf267a3b18ed8df4866c1574e717" }
)
$smokeInput = Get-ChildItem -LiteralPath (Join-Path $artifactRoot "smoke") -Filter "*.wav" -File -Recurse | Where-Object {
    $_.Directory.Name -like "long-path-*" -and $_.Name -notin @("vocals.wav", "instrumental.wav")
} | Select-Object -First 1
$requiredSources = [ordered]@{
    resources = $resourceSource
    smokeScript = $smokeScriptSource
    smokeInput = $smokeInput.FullName
}
foreach ($label in $requiredSources.Keys) {
    $required = $requiredSources[$label]
    if (-not $required -or -not (Test-Path -LiteralPath $required)) { throw "M4 clean-host package source is missing: $label" }
}
foreach ($model in $modelFiles) {
    $source = Join-Path $modelRoot $model.relative
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Approved model artifact is missing" }
    if ((Get-FileSha256 -Path $source) -ne $model.sha256) {
        throw "Approved model artifact hash does not match"
    }
}

if (Test-Path -LiteralPath $destinationRoot) { Remove-Item -LiteralPath $destinationRoot -Recurse -Force }
New-Item -ItemType Directory -Path $destinationRoot | Out-Null
Copy-Item -LiteralPath $resourceSource -Destination (Join-Path $destinationRoot "resources") -Recurse
Copy-Item -LiteralPath $smokeScriptSource -Destination $destinationRoot
foreach ($model in $modelFiles) {
    $source = Join-Path $modelRoot $model.relative
    $relative = $model.relative
    $target = Join-Path (Join-Path $destinationRoot "models") $relative
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
    Copy-Item -LiteralPath $source -Destination $target
}
Copy-Item -LiteralPath $smokeInput.FullName -Destination (Join-Path $destinationRoot "smoke-input.wav")

$summary = [ordered]@{
    schemaVersion = 1
    purpose = "Transfer this directory to a clean Windows 11 x64 VM or host"
    command = ".\m4-clean-windows-smoke.ps1 -PackageRoot . -EvidencePath .\clean-windows-evidence.json"
    network = "Disable VM network after transfer; the smoke run must observe zero endpoints"
    generatedAt = [DateTimeOffset]::UtcNow.ToString("o")
}
[IO.File]::WriteAllText((Join-Path $destinationRoot "README.json"), ($summary | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false))

$manifestFiles = @(
    Get-ChildItem -LiteralPath $destinationRoot -File -Recurse | Sort-Object FullName | ForEach-Object {
        [ordered]@{
            relativePath = $_.FullName.Substring($destinationRoot.Length + 1).Replace("\", "/")
            bytes = $_.Length
            sha256 = (Get-FileSha256 -Path $_.FullName)
        }
    }
)
$manifest = [ordered]@{ schemaVersion = 1; files = $manifestFiles }
[IO.File]::WriteAllText((Join-Path $destinationRoot "package-manifest.json"), ($manifest | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
Write-Output $destinationRoot
