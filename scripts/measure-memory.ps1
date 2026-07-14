<#
.SYNOPSIS
Measures a complete Windows process tree by launching or safely attaching to its root.

.DESCRIPTION
Launch mode starts one root process, waits for warmup, samples private bytes and
working set, then writes the samples plus median and maximum values to JSON. Attach
mode requires both the root PID and exact process start time and never stops the
attached process. Launch cleanup only stops processes that descend from the verified
PID and process start time.

.EXAMPLE
.\scripts\measure-memory.ps1 -Executable 'C:\Apps\RemoteTerminal\RemoteTerminal.exe' `
    -WarmupSeconds 15 -SampleCount 10 -OutputJson '.\artifacts\memory-idle.json'

.EXAMPLE
.\scripts\measure-memory.ps1 -RootProcessId 1234 `
    -RootStartTimeUtc '2026-07-14T08:00:00.0000000Z' `
    -WarmupSeconds 15 -SampleCount 10 -OutputJson '.\artifacts\memory-attached.json'

.EXAMPLE
.\scripts\measure-memory.ps1 -SelfTest
#>
[CmdletBinding(DefaultParameterSetName = "Measure")]
param(
    [Parameter(Mandatory = $true, ParameterSetName = "Measure")]
    [ValidateNotNullOrEmpty()]
    [string]$Executable,

    [Parameter(ParameterSetName = "Measure")]
    [string[]]$ArgumentList = @(),

    [Parameter(Mandatory = $true, ParameterSetName = "Attach")]
    [ValidateRange(1, 2147483647)]
    [int]$RootProcessId,

    [Parameter(Mandatory = $true, ParameterSetName = "Attach")]
    [datetime]$RootStartTimeUtc,

    [Parameter(ParameterSetName = "Measure")]
    [Parameter(ParameterSetName = "Attach")]
    [ValidateRange(0, 3600)]
    [int]$WarmupSeconds = 10,

    [Parameter(ParameterSetName = "Measure")]
    [Parameter(ParameterSetName = "Attach")]
    [ValidateRange(1, 10000)]
    [int]$SampleCount = 5,

    [Parameter(ParameterSetName = "Measure")]
    [Parameter(ParameterSetName = "Attach")]
    [ValidateRange(50, 60000)]
    [int]$SampleIntervalMilliseconds = 1000,

    [Parameter(ParameterSetName = "Measure")]
    [Parameter(ParameterSetName = "Attach")]
    [ValidateRange(1, 86400)]
    [int]$TimeoutSeconds = 120,

    [Parameter(Mandatory = $true, ParameterSetName = "Measure")]
    [Parameter(Mandatory = $true, ParameterSetName = "Attach")]
    [ValidateNotNullOrEmpty()]
    [string]$OutputJson,

    [Parameter(Mandatory = $true, ParameterSetName = "SelfTest")]
    [switch]$SelfTest
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-Median {
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [long[]]$Values
    )

    if ($Values.Count -eq 0) {
        throw "Median requires at least one value."
    }

    $sorted = @($Values | Sort-Object)
    $middle = [Math]::Floor($sorted.Count / 2)
    if (($sorted.Count % 2) -eq 1) {
        return [double]$sorted[$middle]
    }

    return ([double]$sorted[$middle - 1] + [double]$sorted[$middle]) / 2
}

function Test-SameProcessStartTime {
    param(
        [Parameter(Mandatory = $true)]
        [datetime]$LeftUtc,

        [Parameter(Mandatory = $true)]
        [datetime]$RightUtc
    )

    return [Math]::Abs(($LeftUtc.ToUniversalTime() - $RightUtc.ToUniversalTime()).TotalMilliseconds) -lt 1
}

function Get-ProcessSnapshot {
    try {
        $records = [System.Collections.Generic.List[object]]::new()
        foreach ($process in @(Get-Process -ErrorAction Stop)) {
            $parent = $null
            try {
                $parent = $process.Parent
                $records.Add([pscustomobject]@{
                        ProcessId       = [int]$process.Id
                        ParentProcessId = if ($null -eq $parent) { 0 } else { [int]$parent.Id }
                        CreationTimeUtc = $process.StartTime.ToUniversalTime()
                    })
            }
            catch {
                # Protected system processes are irrelevant to the newly launched tree.
                continue
            }
            finally {
                if ($null -ne $parent) {
                    $parent.Dispose()
                }
                $process.Dispose()
            }
        }
        return @($records)
    }
    catch {
        throw "Unable to inspect the Windows process tree."
    }
}

function Get-ProcessTreeRecords {
    param(
        [Parameter(Mandatory = $true)]
        [object[]]$Records,

        [Parameter(Mandatory = $true)]
        [int[]]$SeedProcessIds,

        [Parameter(Mandatory = $true)]
        [datetime]$NotBeforeUtc
    )

    $recordsById = @{}
    $childrenByParent = @{}

    foreach ($record in $Records) {
        if ($record.CreationTimeUtc -lt $NotBeforeUtc) {
            continue
        }

        $recordsById[[int]$record.ProcessId] = $record
        $parentId = [int]$record.ParentProcessId
        if (-not $childrenByParent.ContainsKey($parentId)) {
            $childrenByParent[$parentId] = [System.Collections.Generic.List[object]]::new()
        }
        $childrenByParent[$parentId].Add($record)
    }

    $queue = [System.Collections.Generic.Queue[int]]::new()
    foreach ($seedProcessId in $SeedProcessIds) {
        $queue.Enqueue([int]$seedProcessId)
    }

    $visited = @{}
    $tree = [System.Collections.Generic.List[object]]::new()
    while ($queue.Count -gt 0) {
        $processId = $queue.Dequeue()
        if ($visited.ContainsKey($processId)) {
            continue
        }
        $visited[$processId] = $true

        if ($recordsById.ContainsKey($processId)) {
            $tree.Add($recordsById[$processId])
        }

        if ($childrenByParent.ContainsKey($processId)) {
            foreach ($child in $childrenByParent[$processId]) {
                $queue.Enqueue([int]$child.ProcessId)
            }
        }
    }

    return @($tree)
}

function Get-ProcessIdentity {
    param(
        [Parameter(Mandatory = $true)]
        [System.Diagnostics.Process]$Process
    )

    try {
        return [pscustomobject]@{
            ProcessId   = [int]$Process.Id
            StartTimeUtc = $Process.StartTime.ToUniversalTime()
        }
    }
    catch {
        throw "The launched process exited before its identity could be verified."
    }
}

function Get-MatchingProcess {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Identity
    )

    try {
        $process = Get-Process -Id ([int]$Identity.ProcessId) -ErrorAction Stop
        $startTimeUtc = $process.StartTime.ToUniversalTime()
        if (-not (Test-SameProcessStartTime -LeftUtc $startTimeUtc -RightUtc $Identity.StartTimeUtc)) {
            $process.Dispose()
            return $null
        }
        return $process
    }
    catch [Microsoft.PowerShell.Commands.ProcessCommandException] {
        return $null
    }
    catch [System.ArgumentException] {
        return $null
    }
    catch {
        throw "Unable to verify a process owned by the benchmark."
    }
}

function Assert-RootProcessRunning {
    param(
        [Parameter(Mandatory = $true)]
        [object]$RootIdentity
    )

    $process = Get-MatchingProcess -Identity $RootIdentity
    if ($null -eq $process) {
        throw "The launched process exited before the benchmark completed."
    }
    $process.Dispose()
}

function Assert-BenchmarkWithinTimeout {
    param(
        [Parameter(Mandatory = $true)]
        [System.Diagnostics.Stopwatch]$Stopwatch,

        [Parameter(Mandatory = $true)]
        [int]$TimeoutSeconds
    )

    if ($Stopwatch.Elapsed.TotalSeconds -ge $TimeoutSeconds) {
        throw "The benchmark timed out after $TimeoutSeconds seconds."
    }
}

function Wait-BenchmarkDelay {
    param(
        [Parameter(Mandatory = $true)]
        [int]$DelayMilliseconds,

        [Parameter(Mandatory = $true)]
        [object]$RootIdentity,

        [Parameter(Mandatory = $true)]
        [System.Diagnostics.Stopwatch]$Stopwatch,

        [Parameter(Mandatory = $true)]
        [int]$TimeoutSeconds
    )

    $delay = [System.Diagnostics.Stopwatch]::StartNew()
    while ($delay.ElapsedMilliseconds -lt $DelayMilliseconds) {
        Assert-RootProcessRunning -RootIdentity $RootIdentity
        Assert-BenchmarkWithinTimeout -Stopwatch $Stopwatch -TimeoutSeconds $TimeoutSeconds

        $remaining = $DelayMilliseconds - [int]$delay.ElapsedMilliseconds
        Start-Sleep -Milliseconds ([Math]::Min(100, [Math]::Max(1, $remaining)))
    }

    Assert-RootProcessRunning -RootIdentity $RootIdentity
    Assert-BenchmarkWithinTimeout -Stopwatch $Stopwatch -TimeoutSeconds $TimeoutSeconds
}

function Get-MemorySample {
    param(
        [Parameter(Mandatory = $true)]
        [int]$Index,

        [Parameter(Mandatory = $true)]
        [object]$RootIdentity,

        [Parameter(Mandatory = $true)]
        [datetime]$TreeNotBeforeUtc,

        [Parameter(Mandatory = $true)]
        [hashtable]$KnownIdentities
    )

    Assert-RootProcessRunning -RootIdentity $RootIdentity
    $snapshot = Get-ProcessSnapshot
    $tree = @(Get-ProcessTreeRecords -Records $snapshot -SeedProcessIds @([int]$RootIdentity.ProcessId) -NotBeforeUtc $TreeNotBeforeUtc)
    if (-not ($tree | Where-Object { $_.ProcessId -eq $RootIdentity.ProcessId })) {
        throw "The launched root process was not present in the process snapshot."
    }

    $privateMemoryBytes = [long]0
    $workingSetBytes = [long]0
    $processCount = 0

    foreach ($record in ($tree | Sort-Object ProcessId)) {
        try {
            $process = Get-Process -Id ([int]$record.ProcessId) -ErrorAction Stop
        }
        catch [Microsoft.PowerShell.Commands.ProcessCommandException] {
            if ($record.ProcessId -eq $RootIdentity.ProcessId) {
                throw "The launched process exited before the benchmark completed."
            }
            continue
        }

        try {
            $identity = Get-ProcessIdentity -Process $process
            if ($identity.StartTimeUtc -lt $TreeNotBeforeUtc) {
                continue
            }
            if (($record.ProcessId -eq $RootIdentity.ProcessId) -and
                -not (Test-SameProcessStartTime -LeftUtc $identity.StartTimeUtc -RightUtc $RootIdentity.StartTimeUtc)) {
                throw "The launched process PID was reused before the benchmark completed."
            }

            $process.Refresh()
            $privateMemoryBytes += [long]$process.PrivateMemorySize64
            $workingSetBytes += [long]$process.WorkingSet64
            $processCount += 1
            $KnownIdentities[[int]$identity.ProcessId] = $identity
        }
        finally {
            $process.Dispose()
        }
    }

    if ($processCount -eq 0) {
        throw "No live process remained in the launched process tree."
    }

    return [pscustomobject]@{
        index              = $Index
        capturedAtUtc      = (Get-Date).ToUniversalTime().ToString("o")
        processCount       = $processCount
        privateMemoryBytes = $privateMemoryBytes
        workingSetBytes    = $workingSetBytes
    }
}

function Get-TreeDepth {
    param(
        [Parameter(Mandatory = $true)]
        [int]$ProcessId,

        [Parameter(Mandatory = $true)]
        [hashtable]$ParentById
    )

    $depth = 0
    $currentId = $ProcessId
    $visited = @{}
    while ($ParentById.ContainsKey($currentId) -and -not $visited.ContainsKey($currentId)) {
        $visited[$currentId] = $true
        $parentId = [int]$ParentById[$currentId]
        if (-not $ParentById.ContainsKey($parentId)) {
            break
        }
        $depth += 1
        $currentId = $parentId
    }
    return $depth
}

function Stop-LaunchedProcessTree {
    param(
        [Parameter(Mandatory = $true)]
        [object]$RootIdentity,

        [Parameter(Mandatory = $true)]
        [hashtable]$KnownIdentities,

        [Parameter(Mandatory = $true)]
        [datetime]$TreeNotBeforeUtc
    )

    if (-not $KnownIdentities.ContainsKey([int]$RootIdentity.ProcessId)) {
        throw "The launched root process identity was not registered for cleanup."
    }
    $registeredRoot = $KnownIdentities[[int]$RootIdentity.ProcessId]
    if (-not (Test-SameProcessStartTime -LeftUtc $registeredRoot.StartTimeUtc -RightUtc $RootIdentity.StartTimeUtc)) {
        throw "The launched root process identity changed before cleanup."
    }

    $verifiedSeeds = [System.Collections.Generic.List[int]]::new()
    foreach ($identity in @($KnownIdentities.Values)) {
        $process = Get-MatchingProcess -Identity $identity
        if ($null -eq $process) {
            continue
        }
        try {
            $verifiedSeeds.Add([int]$identity.ProcessId)
        }
        finally {
            $process.Dispose()
        }
    }

    if ($verifiedSeeds.Count -eq 0) {
        return
    }

    $snapshot = Get-ProcessSnapshot
    $tree = @(Get-ProcessTreeRecords -Records $snapshot -SeedProcessIds @($verifiedSeeds) -NotBeforeUtc $TreeNotBeforeUtc)
    $identitiesToStop = @{}
    $parentById = @{}

    foreach ($record in $tree) {
        try {
            $process = Get-Process -Id ([int]$record.ProcessId) -ErrorAction Stop
        }
        catch [Microsoft.PowerShell.Commands.ProcessCommandException] {
            continue
        }

        try {
            $identity = Get-ProcessIdentity -Process $process
            if ($identity.StartTimeUtc -lt $TreeNotBeforeUtc) {
                continue
            }

            if ($KnownIdentities.ContainsKey([int]$identity.ProcessId)) {
                $knownIdentity = $KnownIdentities[[int]$identity.ProcessId]
                if (-not (Test-SameProcessStartTime -LeftUtc $identity.StartTimeUtc -RightUtc $knownIdentity.StartTimeUtc)) {
                    continue
                }
            }

            $identitiesToStop[[int]$identity.ProcessId] = $identity
            $parentById[[int]$identity.ProcessId] = [int]$record.ParentProcessId
        }
        finally {
            $process.Dispose()
        }
    }

    $orderedIdentities = @($identitiesToStop.Values | Sort-Object -Property @(
            @{ Expression = { Get-TreeDepth -ProcessId ([int]$_.ProcessId) -ParentById $parentById }; Descending = $true },
            @{ Expression = { [int]$_.ProcessId }; Descending = $true }
        ))

    foreach ($identity in $orderedIdentities) {
        $process = Get-MatchingProcess -Identity $identity
        if ($null -eq $process) {
            continue
        }
        try {
            Stop-Process -Id ([int]$identity.ProcessId) -Force -ErrorAction Stop
        }
        catch {
            throw "Unable to stop a process launched by the benchmark."
        }
        finally {
            $process.Dispose()
        }
    }

    $deadlineUtc = (Get-Date).ToUniversalTime().AddSeconds(5)
    do {
        $remaining = 0
        foreach ($identity in $orderedIdentities) {
            $process = Get-MatchingProcess -Identity $identity
            if ($null -ne $process) {
                $remaining += 1
                $process.Dispose()
            }
        }
        if ($remaining -eq 0) {
            return
        }
        Start-Sleep -Milliseconds 50
    } while ((Get-Date).ToUniversalTime() -lt $deadlineUtc)

    throw "Failed to stop $remaining process(es) launched by the benchmark."
}

function Assert-CommonMeasurementArguments {
    param(
        [Parameter(Mandatory = $true)]
        [int]$Warmup,

        [Parameter(Mandatory = $true)]
        [int]$Samples,

        [Parameter(Mandatory = $true)]
        [int]$IntervalMilliseconds,

        [Parameter(Mandatory = $true)]
        [int]$Timeout,

        [Parameter(Mandatory = $true)]
        [string]$OutputPath
    )

    if ([string]::IsNullOrWhiteSpace($OutputPath)) {
        throw "OutputJson is required."
    }
    if ($Warmup -lt 0 -or $Warmup -gt 3600) {
        throw "WarmupSeconds must be between 0 and 3600."
    }
    if ($Samples -lt 1 -or $Samples -gt 10000) {
        throw "SampleCount must be between 1 and 10000."
    }
    if ($IntervalMilliseconds -lt 50 -or $IntervalMilliseconds -gt 60000) {
        throw "SampleIntervalMilliseconds must be between 50 and 60000."
    }
    if ($Timeout -lt 1 -or $Timeout -gt 86400) {
        throw "TimeoutSeconds must be between 1 and 86400."
    }

    $resolvedOutput = [System.IO.Path]::GetFullPath($OutputPath)
    $outputDirectory = [System.IO.Path]::GetDirectoryName($resolvedOutput)
    if ([string]::IsNullOrWhiteSpace($outputDirectory) -or -not (Test-Path -LiteralPath $outputDirectory -PathType Container)) {
        throw "OutputJson parent directory must already exist."
    }
    if (Test-Path -LiteralPath $resolvedOutput -PathType Container) {
        throw "OutputJson must reference a file path."
    }

    return $resolvedOutput
}

function Assert-MeasurementArguments {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ExecutablePath,

        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [string[]]$Arguments,

        [Parameter(Mandatory = $true)]
        [int]$Warmup,

        [Parameter(Mandatory = $true)]
        [int]$Samples,

        [Parameter(Mandatory = $true)]
        [int]$IntervalMilliseconds,

        [Parameter(Mandatory = $true)]
        [int]$Timeout,

        [Parameter(Mandatory = $true)]
        [string]$OutputPath
    )

    if ([string]::IsNullOrWhiteSpace($ExecutablePath) -or -not (Test-Path -LiteralPath $ExecutablePath -PathType Leaf)) {
        throw "Executable must reference an existing file."
    }
    if ($Arguments | Where-Object { $null -eq $_ -or $_.Contains([char]0) }) {
        throw "ArgumentList contains an invalid value."
    }

    $resolvedExecutable = (Get-Item -LiteralPath $ExecutablePath -ErrorAction Stop).FullName
    $resolvedOutput = Assert-CommonMeasurementArguments -Warmup $Warmup -Samples $Samples -IntervalMilliseconds $IntervalMilliseconds -Timeout $Timeout -OutputPath $OutputPath
    if ([string]::Equals($resolvedExecutable, $resolvedOutput, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "OutputJson must not overwrite the executable."
    }

    return [pscustomobject]@{
        Executable = $resolvedExecutable
        OutputJson = $resolvedOutput
    }
}

function Assert-AttachmentArguments {
    param(
        [Parameter(Mandatory = $true)]
        [int]$ProcessId,

        [Parameter(Mandatory = $true)]
        [datetime]$StartTimeUtc,

        [Parameter(Mandatory = $true)]
        [int]$Warmup,

        [Parameter(Mandatory = $true)]
        [int]$Samples,

        [Parameter(Mandatory = $true)]
        [int]$IntervalMilliseconds,

        [Parameter(Mandatory = $true)]
        [int]$Timeout,

        [Parameter(Mandatory = $true)]
        [string]$OutputPath
    )

    if ($ProcessId -lt 1) {
        throw "RootProcessId must identify a live user process."
    }
    $resolvedOutput = Assert-CommonMeasurementArguments -Warmup $Warmup -Samples $Samples -IntervalMilliseconds $IntervalMilliseconds -Timeout $Timeout -OutputPath $OutputPath
    $rootIdentity = [pscustomobject]@{
        ProcessId    = $ProcessId
        StartTimeUtc = $StartTimeUtc.ToUniversalTime()
    }
    $process = Get-MatchingProcess -Identity $rootIdentity
    if ($null -eq $process) {
        throw "RootProcessId and RootStartTimeUtc do not identify the same live process."
    }
    try {
        $executableName = "$($process.ProcessName).exe"
    }
    finally {
        $process.Dispose()
    }

    return [pscustomobject]@{
        RootIdentity  = $rootIdentity
        ExecutableName = $executableName
        OutputJson    = $resolvedOutput
    }
}

function Invoke-MemoryBenchmark {
    [CmdletBinding(DefaultParameterSetName = "Launch")]
    param(
        [Parameter(Mandatory = $true, ParameterSetName = "Launch")]
        [string]$ExecutablePath,

        [Parameter(Mandatory = $true, ParameterSetName = "Launch")]
        [AllowEmptyCollection()]
        [string[]]$Arguments,

        [Parameter(Mandatory = $true, ParameterSetName = "Attach")]
        [object]$AttachedRootIdentity,

        [Parameter(Mandatory = $true, ParameterSetName = "Attach")]
        [string]$AttachedExecutableName,

        [Parameter(Mandatory = $true)]
        [int]$Warmup,

        [Parameter(Mandatory = $true)]
        [int]$Samples,

        [Parameter(Mandatory = $true)]
        [int]$IntervalMilliseconds,

        [Parameter(Mandatory = $true)]
        [int]$Timeout
    )

    $launchedProcess = $null
    $rootIdentity = $null
    $treeNotBeforeUtc = [datetime]::MinValue
    $knownIdentities = @{}
    $benchmarkFailure = $null
    $cleanupFailure = $null
    $result = $null
    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    $measurementMode = if ($PSCmdlet.ParameterSetName -eq "Attach") { "attach" } else { "launch" }
    $executableName = $null

    try {
        if ($measurementMode -eq "launch") {
            try {
                $startParameters = @{
                    FilePath = $ExecutablePath
                    PassThru = $true
                }
                if ($Arguments.Count -gt 0) {
                    $startParameters.ArgumentList = $Arguments
                }
                $launchedProcess = Start-Process @startParameters
            }
            catch {
                throw "Failed to start the benchmark executable."
            }

            $rootIdentity = Get-ProcessIdentity -Process $launchedProcess
            $executableName = [System.IO.Path]::GetFileName($ExecutablePath)
        }
        else {
            $rootIdentity = $AttachedRootIdentity
            $attachedProcess = Get-MatchingProcess -Identity $rootIdentity
            if ($null -eq $attachedProcess) {
                throw "The attached root process identity could not be verified."
            }
            $attachedProcess.Dispose()
            $executableName = $AttachedExecutableName
        }

        $treeNotBeforeUtc = $rootIdentity.StartTimeUtc.AddSeconds(-2)
        $knownIdentities[[int]$rootIdentity.ProcessId] = $rootIdentity

        if ($Warmup -gt 0) {
            Wait-BenchmarkDelay -DelayMilliseconds ($Warmup * 1000) -RootIdentity $rootIdentity -Stopwatch $stopwatch -TimeoutSeconds $Timeout
        }

        $memorySamples = [System.Collections.Generic.List[object]]::new()
        for ($index = 1; $index -le $Samples; $index += 1) {
            Assert-BenchmarkWithinTimeout -Stopwatch $stopwatch -TimeoutSeconds $Timeout
            $sample = Get-MemorySample -Index $index -RootIdentity $rootIdentity -TreeNotBeforeUtc $treeNotBeforeUtc -KnownIdentities $knownIdentities
            $memorySamples.Add($sample)

            if ($index -lt $Samples) {
                Wait-BenchmarkDelay -DelayMilliseconds $IntervalMilliseconds -RootIdentity $rootIdentity -Stopwatch $stopwatch -TimeoutSeconds $Timeout
            }
        }

        $privateValues = @($memorySamples | ForEach-Object { [long]$_.privateMemoryBytes })
        $workingSetValues = @($memorySamples | ForEach-Object { [long]$_.workingSetBytes })
        $result = [ordered]@{
            schemaVersion              = 2
            capturedAtUtc              = (Get-Date).ToUniversalTime().ToString("o")
            measurementMode            = $measurementMode
            executableName             = $executableName
            rootProcessId              = [int]$rootIdentity.ProcessId
            rootStartTimeUtc            = $rootIdentity.StartTimeUtc.ToUniversalTime().ToString("o")
            warmupSeconds              = $Warmup
            sampleCount                = $Samples
            sampleIntervalMilliseconds = $IntervalMilliseconds
            samples                    = @($memorySamples)
            summary                    = [ordered]@{
                privateMemoryBytes = [ordered]@{
                    median = Get-Median -Values $privateValues
                    max    = [long](($privateValues | Measure-Object -Maximum).Maximum)
                }
                workingSetBytes = [ordered]@{
                    median = Get-Median -Values $workingSetValues
                    max    = [long](($workingSetValues | Measure-Object -Maximum).Maximum)
                }
            }
        }
    }
    catch {
        $benchmarkFailure = $_.Exception.Message
    }
    finally {
        if ($measurementMode -eq "launch" -and $null -ne $rootIdentity) {
            try {
                Stop-LaunchedProcessTree -RootIdentity $rootIdentity -KnownIdentities $knownIdentities -TreeNotBeforeUtc $treeNotBeforeUtc
            }
            catch {
                $cleanupFailure = $_.Exception.Message
            }
        }
        if ($null -ne $launchedProcess) {
            $launchedProcess.Dispose()
        }
        $stopwatch.Stop()
    }

    if ($null -ne $benchmarkFailure -and $null -ne $cleanupFailure) {
        throw "$benchmarkFailure Cleanup also failed: $cleanupFailure"
    }
    if ($null -ne $benchmarkFailure) {
        throw $benchmarkFailure
    }
    if ($null -ne $cleanupFailure) {
        throw $cleanupFailure
    }
    return $result
}

function Write-JsonAtomically {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Value,

        [Parameter(Mandatory = $true)]
        [string]$OutputPath
    )

    $directory = [System.IO.Path]::GetDirectoryName($OutputPath)
    $temporaryPath = [System.IO.Path]::Combine($directory, ".measure-memory-$([guid]::NewGuid().ToString('N')).tmp")
    try {
        $json = $Value | ConvertTo-Json -Depth 8
        Set-Content -LiteralPath $temporaryPath -Value $json -Encoding utf8NoBOM -ErrorAction Stop
        Move-Item -LiteralPath $temporaryPath -Destination $OutputPath -Force -ErrorAction Stop
    }
    catch {
        throw "Failed to write the benchmark JSON output."
    }
    finally {
        if (Test-Path -LiteralPath $temporaryPath -PathType Leaf) {
            Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
        }
    }
}

function Assert-SelfTest {
    param(
        [Parameter(Mandatory = $true)]
        [bool]$Condition,

        [Parameter(Mandatory = $true)]
        [string]$Message
    )

    if (-not $Condition) {
        throw "Self-test failed: $Message"
    }
}

function Assert-SelfTestThrows {
    param(
        [Parameter(Mandatory = $true)]
        [scriptblock]$Action,

        [Parameter(Mandatory = $true)]
        [string]$ExpectedPattern
    )

    try {
        $null = & $Action
    }
    catch {
        if ($_.Exception.Message -match $ExpectedPattern) {
            return
        }
        throw "Self-test failed: error did not match the expected category."
    }
    throw "Self-test failed: expected an error."
}

function Invoke-SelfTest {
    Assert-SelfTest -Condition ((Get-Median -Values @(1, 3, 2)) -eq 2) -Message "odd median"
    Assert-SelfTest -Condition ((Get-Median -Values @(10, 20, 30, 40)) -eq 25) -Message "even median"
    Assert-SelfTestThrows -Action { Get-Median -Values @() } -ExpectedPattern "at least one"

    $now = (Get-Date).ToUniversalTime()
    $records = @(
        [pscustomobject]@{ ProcessId = 10; ParentProcessId = 1; CreationTimeUtc = $now },
        [pscustomobject]@{ ProcessId = 11; ParentProcessId = 10; CreationTimeUtc = $now },
        [pscustomobject]@{ ProcessId = 12; ParentProcessId = 11; CreationTimeUtc = $now },
        [pscustomobject]@{ ProcessId = 99; ParentProcessId = 1; CreationTimeUtc = $now },
        [pscustomobject]@{ ProcessId = 13; ParentProcessId = 10; CreationTimeUtc = $now.AddMinutes(-5) }
    )
    $treeIds = @(Get-ProcessTreeRecords -Records $records -SeedProcessIds @(10) -NotBeforeUtc $now.AddSeconds(-1) | ForEach-Object { $_.ProcessId })
    Assert-SelfTest -Condition (($treeIds -join ",") -eq "10,11,12") -Message "tree isolation"

    $pwshPath = Join-Path $PSHOME "pwsh.exe"
    $testOutput = Join-Path ([System.IO.Path]::GetTempPath()) "measure-memory-self-test.json"
    $validated = Assert-MeasurementArguments -ExecutablePath $pwshPath -Arguments @() -Warmup 0 -Samples 1 -IntervalMilliseconds 50 -Timeout 10 -OutputPath $testOutput
    Assert-SelfTest -Condition ($validated.Executable -eq $pwshPath) -Message "argument validation"
    Assert-SelfTestThrows -Action {
        Assert-MeasurementArguments -ExecutablePath $pwshPath -Arguments @() -Warmup 0 -Samples 0 -IntervalMilliseconds 50 -Timeout 10 -OutputPath $testOutput
    } -ExpectedPattern "SampleCount"

    $sleepCommand = [Convert]::ToBase64String(
        [Text.Encoding]::Unicode.GetBytes("Start-Sleep -Seconds 30")
    )
    $result = Invoke-MemoryBenchmark -ExecutablePath $pwshPath -Arguments @(
        "-NoLogo",
        "-NoProfile",
        "-EncodedCommand",
        $sleepCommand
    ) -Warmup 0 -Samples 2 -IntervalMilliseconds 100 -Timeout 10
    Assert-SelfTest -Condition ($result.samples.Count -eq 2) -Message "sample count"
    Assert-SelfTest -Condition ($result.measurementMode -eq "launch") -Message "launch measurement mode"
    Assert-SelfTest -Condition ($result.summary.privateMemoryBytes.median -gt 0) -Message "private memory aggregation"
    Assert-SelfTest -Condition ($result.summary.workingSetBytes.max -gt 0) -Message "working-set aggregation"

    Assert-SelfTestThrows -Action {
        Invoke-MemoryBenchmark -ExecutablePath $pwshPath -Arguments @(
            "-NoLogo",
            "-NoProfile",
            "-EncodedCommand",
            $sleepCommand
        ) -Warmup 2 -Samples 1 -IntervalMilliseconds 50 -Timeout 1
    } -ExpectedPattern "timed out"

    $attachedProcess = $null
    $attachedIdentity = $null
    $attachedKnownIdentities = @{}
    try {
        $attachedProcess = Start-Process -FilePath $pwshPath -ArgumentList @(
            "-NoLogo",
            "-NoProfile",
            "-EncodedCommand",
            $sleepCommand
        ) -PassThru
        $attachedIdentity = Get-ProcessIdentity -Process $attachedProcess
        $attachedKnownIdentities[[int]$attachedIdentity.ProcessId] = $attachedIdentity
        $validatedAttachment = Assert-AttachmentArguments -ProcessId $attachedIdentity.ProcessId -StartTimeUtc $attachedIdentity.StartTimeUtc -Warmup 0 -Samples 2 -IntervalMilliseconds 100 -Timeout 10 -OutputPath $testOutput
        $attachedResult = Invoke-MemoryBenchmark -AttachedRootIdentity $validatedAttachment.RootIdentity -AttachedExecutableName $validatedAttachment.ExecutableName -Warmup 0 -Samples 2 -IntervalMilliseconds 100 -Timeout 10
        Assert-SelfTest -Condition ($attachedResult.measurementMode -eq "attach") -Message "attach measurement mode"
        Assert-SelfTest -Condition ($attachedResult.samples.Count -eq 2) -Message "attach sample count"
        $stillRunning = Get-MatchingProcess -Identity $attachedIdentity
        Assert-SelfTest -Condition ($null -ne $stillRunning) -Message "attach mode never owns cleanup"
        if ($null -ne $stillRunning) {
            $stillRunning.Dispose()
        }
        Assert-SelfTestThrows -Action {
            Assert-AttachmentArguments -ProcessId $attachedIdentity.ProcessId -StartTimeUtc $attachedIdentity.StartTimeUtc.AddMinutes(-1) -Warmup 0 -Samples 1 -IntervalMilliseconds 50 -Timeout 10 -OutputPath $testOutput
        } -ExpectedPattern "same live process"
    }
    finally {
        if ($null -ne $attachedIdentity) {
            Stop-LaunchedProcessTree -RootIdentity $attachedIdentity -KnownIdentities $attachedKnownIdentities -TreeNotBeforeUtc $attachedIdentity.StartTimeUtc.AddSeconds(-2)
        }
        if ($null -ne $attachedProcess) {
            $attachedProcess.Dispose()
        }
    }

    $exitProcess = $null
    $exitIdentity = $null
    $exitKnownIdentities = @{}
    try {
        $exitProcess = Start-Process -FilePath $pwshPath -ArgumentList @(
            "-NoLogo",
            "-NoProfile",
            "-EncodedCommand",
            $sleepCommand
        ) -PassThru
        $exitIdentity = Get-ProcessIdentity -Process $exitProcess
        $exitKnownIdentities[[int]$exitIdentity.ProcessId] = $exitIdentity
        Stop-LaunchedProcessTree -RootIdentity $exitIdentity -KnownIdentities $exitKnownIdentities -TreeNotBeforeUtc $exitIdentity.StartTimeUtc.AddSeconds(-2)
        Assert-SelfTest -Condition $exitProcess.WaitForExit(5000) -Message "deterministic process exit"
        Assert-SelfTestThrows -Action {
            Assert-RootProcessRunning -RootIdentity $exitIdentity
        } -ExpectedPattern "exited"
    }
    finally {
        if ($null -ne $exitIdentity) {
            Stop-LaunchedProcessTree -RootIdentity $exitIdentity -KnownIdentities $exitKnownIdentities -TreeNotBeforeUtc $exitIdentity.StartTimeUtc.AddSeconds(-2)
        }
        if ($null -ne $exitProcess) {
            $exitProcess.Dispose()
        }
    }

    Write-Output "measure-memory self-test passed."
}

try {
    if ($SelfTest) {
        Invoke-SelfTest
        exit 0
    }

    if ($PSCmdlet.ParameterSetName -eq "Attach") {
        $validatedAttachment = Assert-AttachmentArguments -ProcessId $RootProcessId -StartTimeUtc $RootStartTimeUtc -Warmup $WarmupSeconds -Samples $SampleCount -IntervalMilliseconds $SampleIntervalMilliseconds -Timeout $TimeoutSeconds -OutputPath $OutputJson
        $measurement = Invoke-MemoryBenchmark -AttachedRootIdentity $validatedAttachment.RootIdentity -AttachedExecutableName $validatedAttachment.ExecutableName -Warmup $WarmupSeconds -Samples $SampleCount -IntervalMilliseconds $SampleIntervalMilliseconds -Timeout $TimeoutSeconds
        $resolvedOutput = $validatedAttachment.OutputJson
    }
    else {
        $validatedArguments = Assert-MeasurementArguments -ExecutablePath $Executable -Arguments $ArgumentList -Warmup $WarmupSeconds -Samples $SampleCount -IntervalMilliseconds $SampleIntervalMilliseconds -Timeout $TimeoutSeconds -OutputPath $OutputJson
        $measurement = Invoke-MemoryBenchmark -ExecutablePath $validatedArguments.Executable -Arguments $ArgumentList -Warmup $WarmupSeconds -Samples $SampleCount -IntervalMilliseconds $SampleIntervalMilliseconds -Timeout $TimeoutSeconds
        $resolvedOutput = $validatedArguments.OutputJson
    }
    Write-JsonAtomically -Value $measurement -OutputPath $resolvedOutput
    Write-Output "Memory benchmark completed successfully."
}
catch {
    [Console]::Error.WriteLine("measure-memory: $($_.Exception.Message)")
    exit 1
}
