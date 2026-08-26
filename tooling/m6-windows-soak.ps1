[CmdletBinding()]
param(
    [ValidateRange(1, 7200)]
    [int]$DurationSeconds = 1800,

    [ValidateRange(0, 2147483647)]
    [int]$TargetProcessId = 0,

    [string]$OutputPath = "artifacts/m6/windows-practice-soak.json",

    [ValidateSet("built-in", "usb", "bluetooth", "virtual", "not-recorded")]
    [string]$InputDeviceCategory = "not-recorded",

    [ValidateSet(0, 44100, 48000)]
    [int]$SampleRateHz = 0,

    [ValidateRange(0, 100000)]
    [int]$ObservedLoopCount = 0,

    [ValidateRange(-1, 100000)]
    [int]$ApplicationUnderruns = -1,

    [ValidateRange(-1, 100000)]
    [int]$ResourceCountsStart = -1,

    [ValidateRange(-1, 100000)]
    [int]$ResourceCountsEnd = -1,

    [switch]$DiagnosticRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$collector = Join-Path $PSScriptRoot "m2-windows-soak.ps1"
$resolvedOutput = if ([System.IO.Path]::IsPathRooted($OutputPath)) {
    [System.IO.Path]::GetFullPath($OutputPath)
} else {
    [System.IO.Path]::GetFullPath((Join-Path $repoRoot $OutputPath))
}

if (-not $resolvedOutput.StartsWith(
        (Join-Path $repoRoot "artifacts\m6") + [System.IO.Path]::DirectorySeparatorChar,
        [System.StringComparison]::OrdinalIgnoreCase
    )) {
    throw "M6_SOAK_OUTPUT_OUTSIDE_ARTIFACT_ROOT: OutputPath must stay under artifacts/m6."
}

if (-not $DiagnosticRun) {
    if ($DurationSeconds -lt 1800) {
        throw "M6_SOAK_DURATION_TOO_SHORT: gate evidence requires at least 1800 seconds."
    }
    if ($InputDeviceCategory -eq "not-recorded" -or $SampleRateHz -eq 0) {
        throw "M6_SOAK_DEVICE_EVIDENCE_MISSING: record only the anonymous device category and sample rate."
    }
    if ($ObservedLoopCount -lt 25) {
        throw "M6_SOAK_LOOP_COUNT_TOO_LOW: gate evidence requires at least 25 observed loops."
    }
    if ($ApplicationUnderruns -lt 0 -or $ResourceCountsStart -lt 0 -or $ResourceCountsEnd -lt 0) {
        throw "M6_SOAK_RUNTIME_EVIDENCE_MISSING: record underrun and resource counts from the Practice technical panel."
    }
}

& $collector `
    -DurationSeconds $DurationSeconds `
    -TargetProcessId $TargetProcessId `
    -OutputPath $resolvedOutput

$report = Get-Content -LiteralPath $resolvedOutput -Raw -Encoding UTF8 | ConvertFrom-Json
$cpuPass = [double]$report.measurement.totalCpuP95Percent -le [double]$report.measurement.thresholdTotalCpuPercent
$memoryPass = [double]$report.measurement.workingSetP95MiB -le [double]$report.measurement.thresholdWorkingSetMiB
$resourcePass = $ResourceCountsStart -ge 0 -and $ResourceCountsEnd -le $ResourceCountsStart
$gatePassed = -not $DiagnosticRun -and
    $cpuPass -and
    $memoryPass -and
    $ObservedLoopCount -ge 25 -and
    $ApplicationUnderruns -eq 0 -and
    $resourcePass

$report.testIds = @("TC-SOAK-001", "TC-SOAK-002", "TC-PERF-004")
$report.buildType = if ($DiagnosticRun) { "diagnostic-process-tree" } else { "m6-release-candidate-process-tree" }
$report.manualEvidence = [ordered]@{
    inputDeviceCategory = $InputDeviceCategory
    sampleRateHz = $SampleRateHz
    observedLoopCount = $ObservedLoopCount
    applicationUnderruns = if ($ApplicationUnderruns -lt 0) { $null } else { $ApplicationUnderruns }
    resourceCountsStart = if ($ResourceCountsStart -lt 0) { $null } else { $ResourceCountsStart }
    resourceCountsEnd = if ($ResourceCountsEnd -lt 0) { $null } else { $ResourceCountsEnd }
    privacy = "No device label, serial number, audio content, or endpoint address is recorded."
}
$validation = [ordered]@{
    diagnosticRun = [bool]$DiagnosticRun
    cpuPass = $cpuPass
    memoryPass = $memoryPass
    loopCountPass = $ObservedLoopCount -ge 25
    underrunPass = $ApplicationUnderruns -eq 0
    resourceCountPass = $resourcePass
    gatePassed = $gatePassed
}
$report | Add-Member -NotePropertyName validation -NotePropertyValue $validation

[System.IO.File]::WriteAllText(
    $resolvedOutput,
    ($report | ConvertTo-Json -Depth 8),
    [System.Text.UTF8Encoding]::new($false)
)

$report.validation | Format-List

if (-not $DiagnosticRun -and -not $gatePassed) {
    throw "M6_SOAK_GATE_FAILED: inspect the persisted anonymous report for the failed threshold."
}
