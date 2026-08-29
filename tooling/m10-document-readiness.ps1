$ErrorActionPreference = "Stop"

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$failures = [System.Collections.Generic.List[string]]::new()

function Require-Pattern {
    param(
        [Parameter(Mandatory = $true)][string]$RelativePath,
        [Parameter(Mandatory = $true)][string]$Pattern,
        [Parameter(Mandatory = $true)][string]$Description
    )

    $path = Join-Path $repositoryRoot $RelativePath
    if (-not (Test-Path -LiteralPath $path)) {
        $failures.Add("$RelativePath missing $Description")
        return
    }
    $content = Get-Content -LiteralPath $path -Raw
    if ($content -notmatch $Pattern) {
        $failures.Add("$RelativePath missing $Description")
    }
}

Require-Pattern 'docs/product/functional-requirements.md' '(?m)^### FR-029 —' 'FR-029'
Require-Pattern 'docs/product/functional-requirements.md' '80–120 ms' 'calibration tick window'
Require-Pattern 'docs/product/non-functional-requirements.md' '(?m)^### NFR-023 —' 'NFR-023'
Require-Pattern 'docs/delivery/milestone-specs.md' '(?m)^## M10 — Pitch UI, Relaxed Feedback and Guarded Navigation Closeout$' 'M10 milestone'
Require-Pattern 'docs/delivery/milestone-specs.md' 'M9 已确认通过' 'M9 gate approval'
Require-Pattern 'docs/delivery/risk-register.md' '(?m)^\| RISK-027 \|' 'RISK-027'
Require-Pattern 'docs/quality/test-strategy.md' '(?m)^## M10 UI 与导航收尾验证$' 'M10 validation section'
Require-Pattern 'docs/quality/test-strategy.md' 'TC-FBK-002' 'readable feedback timing validation'
Require-Pattern 'docs/product/non-functional-requirements.md' '300 ms' 'readable feedback update interval'
Require-Pattern 'docs/product/non-functional-requirements.md' '600 ms' 'unvoiced feedback hold'
Require-Pattern 'docs/quality/requirements-traceability.md' '(?m)^\| FR-029 \|' 'FR-029 traceability'
Require-Pattern 'docs/delivery/evidence/m10-ux-closeout.md' '(?m)^# M10 UI 与导航收尾证据$' 'M10 evidence'
Require-Pattern 'docs/README.md' 'm10-ux-closeout\.md' 'M10 evidence link'

if ($failures.Count -gt 0) {
    foreach ($failure in $failures) {
        Write-Error $failure
    }
    exit 1
}

Write-Output "M10 documentation readiness passed: gate, FR/NFR, risk, traceability, validation and evidence are aligned."
