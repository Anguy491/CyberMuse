param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$TauriArguments
)

$ErrorActionPreference = "Stop"
$cargoBin = Join-Path $env:USERPROFILE ".cargo\bin"
$cargo = Join-Path $cargoBin "cargo.exe"
if (-not (Test-Path -LiteralPath $cargo -PathType Leaf)) {
    throw "The locked Rust toolchain entry point is missing: $cargo"
}
$env:PATH = "$cargoBin;$env:PATH"
& pnpm --filter @cybermuse/desktop exec tauri @TauriArguments
exit $LASTEXITCODE
