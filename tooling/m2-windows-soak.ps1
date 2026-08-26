[CmdletBinding()]
param(
    [ValidateRange(1, 7200)]
    [int]$DurationSeconds = 1800,

    [ValidateRange(0, 2147483647)]
    [int]$TargetProcessId = 0,

    [string]$OutputPath = "artifacts/m2/windows-microphone-soak.json"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-Percentile {
    param(
        [Parameter(Mandatory)]
        [double[]]$Values,

        [Parameter(Mandatory)]
        [ValidateRange(0, 1)]
        [double]$Quantile
    )

    if ($Values.Count -eq 0) {
        return $null
    }

    $ordered = @($Values | Sort-Object)
    $index = [Math]::Min(
        $ordered.Count - 1,
        [Math]::Max(0, [Math]::Ceiling($Quantile * $ordered.Count) - 1)
    )
    return [Math]::Round([double]$ordered[$index], 3)
}

function Get-ProcessTreeIds {
    param(
        [Parameter(Mandatory)]
        [int]$RootProcessId
    )

    $processRows = @(Get-CimInstance -ClassName Win32_Process | Select-Object ProcessId, ParentProcessId)
    $ids = [System.Collections.Generic.HashSet[int]]::new()
    [void]$ids.Add($RootProcessId)
    $added = $true

    while ($added) {
        $added = $false
        foreach ($row in $processRows) {
            $parentId = [int]$row.ParentProcessId
            $processId = [int]$row.ProcessId
            if ($ids.Contains($parentId) -and $ids.Add($processId)) {
                $added = $true
            }
        }
    }

    return @($ids)
}

if ($TargetProcessId -eq 0) {
    $rootProcess = Get-Process -Name "cybermuse-desktop" -ErrorAction SilentlyContinue |
        Sort-Object StartTime -Descending |
        Select-Object -First 1
    if ($null -eq $rootProcess) {
        throw "M2_SOAK_PROCESS_NOT_FOUND: start the CyberMuse release build before running this collector."
    }
    $TargetProcessId = $rootProcess.Id
}

$resolvedOutputPath = if ([System.IO.Path]::IsPathRooted($OutputPath)) {
    [System.IO.Path]::GetFullPath($OutputPath)
} else {
    [System.IO.Path]::GetFullPath((Join-Path (Get-Location).Path $OutputPath))
}
if (Test-Path -LiteralPath $resolvedOutputPath) {
    throw "M2_SOAK_OUTPUT_EXISTS: choose a new OutputPath so existing evidence is not overwritten."
}

$outputDirectory = [System.IO.Path]::GetDirectoryName($resolvedOutputPath)
if (-not [string]::IsNullOrWhiteSpace($outputDirectory)) {
    [System.IO.Directory]::CreateDirectory($outputDirectory) | Out-Null
}

$logicalProcessors = [Math]::Max(
    1,
    [int](Get-CimInstance -ClassName Win32_ComputerSystem).NumberOfLogicalProcessors
)
$cpuName = (Get-CimInstance -ClassName Win32_Processor | Select-Object -First 1 -ExpandProperty Name).Trim()
$memoryMiB = [Math]::Round(
    [double](Get-CimInstance -ClassName Win32_ComputerSystem).TotalPhysicalMemory / 1MB
)

$previousCpuMs = @{}
$samples = [System.Collections.Generic.List[object]]::new()
$startedAt = [System.Diagnostics.Stopwatch]::StartNew()
$previousElapsedMs = 0.0

while ($startedAt.Elapsed.TotalSeconds -lt $DurationSeconds) {
    Start-Sleep -Milliseconds 1000
    $elapsedMs = $startedAt.Elapsed.TotalMilliseconds
    $intervalMs = [Math]::Max(1, $elapsedMs - $previousElapsedMs)
    $treeIds = @(Get-ProcessTreeIds -RootProcessId $TargetProcessId)
    $processes = @(
        foreach ($processId in $treeIds) {
            Get-Process -Id $processId -ErrorAction SilentlyContinue
        }
    )

    if (-not ($processes | Where-Object Id -EQ $TargetProcessId)) {
        throw "M2_SOAK_PROCESS_EXITED: CyberMuse exited before the requested duration completed."
    }

    $cpuDeltaMs = 0.0
    $currentCpuMs = @{}
    foreach ($process in $processes) {
        $totalCpuMs = $process.TotalProcessorTime.TotalMilliseconds
        $currentCpuMs[$process.Id] = $totalCpuMs
        if ($previousCpuMs.ContainsKey($process.Id)) {
            $cpuDeltaMs += [Math]::Max(0, $totalCpuMs - [double]$previousCpuMs[$process.Id])
        }
    }

    $workingSetMiB = [Math]::Round(
        [double](($processes | Measure-Object -Property WorkingSet64 -Sum).Sum) / 1MB,
        3
    )
    $totalCpuPercent = [Math]::Round(
        ($cpuDeltaMs / $intervalMs / $logicalProcessors) * 100,
        3
    )
    $handleCount = [int](($processes | Measure-Object -Property HandleCount -Sum).Sum)

    $samples.Add([ordered]@{
            elapsedMs      = [Math]::Round($elapsedMs)
            totalCpuPercent = $totalCpuPercent
            workingSetMiB  = $workingSetMiB
            handleCount    = $handleCount
            processCount   = $processes.Count
        })
    $previousCpuMs = $currentCpuMs
    $previousElapsedMs = $elapsedMs
}

$startedAt.Stop()
$cpuValues = [double[]]@($samples | ForEach-Object totalCpuPercent)
$workingSetValues = [double[]]@($samples | ForEach-Object workingSetMiB)
$handleValues = [double[]]@($samples | ForEach-Object handleCount)
$firstWorkingSet = if ($samples.Count -gt 0) { [double]$samples[0].workingSetMiB } else { 0 }
$lastWorkingSet = if ($samples.Count -gt 0) { [double]$samples[$samples.Count - 1].workingSetMiB } else { 0 }

$report = [ordered]@{
    schemaVersion = 1
    testIds       = @("TC-PERF-004", "NFR-006")
    generatedAt   = [DateTimeOffset]::UtcNow.ToString("O")
    buildType     = "release-windows-process-tree"
    environment   = [ordered]@{
        platform          = "Windows 11 x64"
        cpu               = $cpuName
        logicalProcessors = $logicalProcessors
        systemMemoryMiB   = $memoryMiB
    }
    measurement   = [ordered]@{
        requestedDurationSeconds = $DurationSeconds
        actualDurationMs         = [Math]::Round($startedAt.Elapsed.TotalMilliseconds)
        sampleCount              = $samples.Count
        totalCpuP95Percent       = Get-Percentile -Values $cpuValues -Quantile 0.95
        workingSetP95MiB         = Get-Percentile -Values $workingSetValues -Quantile 0.95
        workingSetGrowthMiB      = [Math]::Round($lastWorkingSet - $firstWorkingSet, 3)
        handleCountP95           = Get-Percentile -Values $handleValues -Quantile 0.95
        thresholdTotalCpuPercent = 25
        thresholdWorkingSetMiB   = 750
    }
    manualEvidence = [ordered]@{
        microphonePermissionPath = "record separately"
        inputDeviceCategories     = @()
        sampleRatesHz             = @()
        applicationUnderruns      = $null
        resourceCountsStart       = $null
        resourceCountsEnd         = $null
        notes                     = "Complete from the Audio Settings UI without recording device labels or serial numbers."
    }
    samples       = $samples
}

[System.IO.File]::WriteAllText(
    $resolvedOutputPath,
    ($report | ConvertTo-Json -Depth 8),
    [System.Text.UTF8Encoding]::new($false)
)

$report.measurement | Format-List
