function Wait-CodexWindow {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][scriptblock]$GetProcesses,
        [ValidateRange(0, 600)][double]$TimeoutSeconds = 90,
        [ValidateRange(1, 5000)][int]$PollIntervalMilliseconds = 500,
        [scriptblock]$OnProgress
    )

    $timer = [Diagnostics.Stopwatch]::StartNew()
    $lastProgressSeconds = -5
    do {
        $processes = @(& $GetProcesses)
        foreach ($candidate in ($processes | Sort-Object StartTime)) {
            try {
                # Process 会缓存窗口句柄；必须刷新后再检查。MainWindowHandle 排除隐藏窗口。
                if ($candidate.PSObject.Methods['Refresh']) { $candidate.Refresh() }
                if ($candidate.MainWindowHandle -ne 0 -and $candidate.Responding) {
                    return [pscustomobject]@{
                        Status = 'Ready'; Process = $candidate
                        ProcessIds = @($processes | ForEach-Object Id); ElapsedSeconds = [math]::Round($timer.Elapsed.TotalSeconds, 1)
                    }
                }
            }
            catch { } # 子进程可能正好退出；继续检查其他进程。
        }
        $elapsedSeconds = $timer.Elapsed.TotalSeconds
        if ($OnProgress -and $elapsedSeconds - $lastProgressSeconds -ge 5) {
            & $OnProgress ([pscustomobject]@{ ProcessIds = @($processes | ForEach-Object Id); ElapsedSeconds = [int]$elapsedSeconds }) | Out-Null
            $lastProgressSeconds = $elapsedSeconds
        }
        $remainingMilliseconds = ($TimeoutSeconds - $timer.Elapsed.TotalSeconds) * 1000
        if ($remainingMilliseconds -le 0) { break }
        Start-Sleep -Milliseconds ([int][math]::Min($PollIntervalMilliseconds, [math]::Ceiling($remainingMilliseconds)))
    } while ($true)

    [pscustomobject]@{
        Status = if ($processes.Count -gt 0) { 'TimedOut' } else { 'Exited' }
        Process = $null; ProcessIds = @($processes | ForEach-Object Id)
        ElapsedSeconds = [math]::Round($timer.Elapsed.TotalSeconds, 1)
    }
}

function Open-CodexExistingWindow {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][scriptblock]$GetProcesses,
        [Parameter(Mandatory = $true)][scriptblock]$RequestActivation,
        [ValidateRange(0, 600)][double]$TimeoutSeconds = 90,
        [ValidateRange(1, 5000)][int]$PollIntervalMilliseconds = 500,
        [scriptblock]$OnProgress
    )

    $current = Wait-CodexWindow -GetProcesses $GetProcesses -TimeoutSeconds 0
    if ($current.Status -ne 'TimedOut') { return $current }
    # 请求应用自己的单实例机制显示窗口；请求发送不等于窗口已经出现。
    & $RequestActivation | Out-Null
    Wait-CodexWindow -GetProcesses $GetProcesses -TimeoutSeconds $TimeoutSeconds `
        -PollIntervalMilliseconds $PollIntervalMilliseconds -OnProgress $OnProgress
}

Export-ModuleMember -Function Wait-CodexWindow, Open-CodexExistingWindow
