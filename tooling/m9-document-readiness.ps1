[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$failures = [System.Collections.Generic.List[string]]::new()

function Read-RepoFile {
    param([Parameter(Mandatory = $true)][string]$RelativePath)

    $path = [System.IO.Path]::GetFullPath((Join-Path $repoRoot $RelativePath))
    if (-not $path.StartsWith($repoRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Path escaped repository root: $RelativePath"
    }
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        $failures.Add("Missing required file: $RelativePath")
        return ""
    }
    return Get-Content -LiteralPath $path -Raw
}

function Require-Pattern {
    param(
        [Parameter(Mandatory = $true)][string]$RelativePath,
        [Parameter(Mandatory = $true)][string]$Pattern,
        [Parameter(Mandatory = $true)][string]$Description
    )

    $content = Read-RepoFile -RelativePath $RelativePath
    if ($content -notmatch $Pattern) {
        $failures.Add("$RelativePath missing $Description")
    }
}

Require-Pattern 'docs/product/functional-requirements.md' '(?m)^### FR-028 —' 'FR-028'
Require-Pattern 'docs/product/non-functional-requirements.md' '(?m)^### NFR-024 —' 'NFR-024'
Require-Pattern 'docs/architecture/decisions.md' '(?m)^## ADR-024 —' 'ADR-024'
Require-Pattern 'docs/architecture/decisions.md' '(?s)## ADR-024 —.*?- 状态：Proposed' 'ADR-024 Proposed status'
Require-Pattern 'docs/delivery/risk-register.md' '(?m)^\| RISK-026 \|' 'RISK-026'
Require-Pattern 'docs/delivery/milestone-specs.md' '(?m)^## M9 — Original Vocal Guide Mix$' 'M9 milestone'
Require-Pattern 'docs/quality/test-strategy.md' '(?m)^## M9 原唱辅助验证$' 'TC-VOC validation section'
Require-Pattern 'docs/quality/requirements-traceability.md' '(?m)^\| FR-028 \|' 'FR-028 traceability'
Require-Pattern 'docs/quality/requirements-traceability.md' '(?m)^\| NFR-024 \|' 'NFR-024 traceability'
Require-Pattern 'docs/architecture/data-model.md' 'vocalsResourceUrl: string' 'PracticeAssets.vocalsResourceUrl'
Require-Pattern 'docs/architecture/api-contracts.md' 'vocalsResourceUrl: string' 'PracticeAssets API field'
Require-Pattern 'docs/delivery/evidence/m9-original-vocal-guide.md' '状态 \| 产品实现与自动门禁通过；Windows 人工矩阵开放' 'implemented M9 evidence status'
Require-Pattern 'docs/README.md' 'm9-original-vocal-guide\.md' 'M9 evidence link'
Require-Pattern 'docs/delivery/evidence/m8-pitch-lane-v2.md' '用户于 2026-08-29 明确批准 M8 人工门禁' 'M8 gate approval evidence'

if ($failures.Count -gt 0) {
    foreach ($failure in $failures) {
        Write-Error $failure
    }
    exit 1
}

Write-Output "M9 documentation readiness passed: FR-028, NFR-024, ADR-024, RISK-026, contracts, traceability, milestone, validation matrix, and gate evidence are aligned."
