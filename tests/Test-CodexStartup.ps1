$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$modulePath = Join-Path $projectRoot 'CodexStartup.psm1'
if (-not (Test-Path -LiteralPath $modulePath)) {
    throw '缺少窗口就绪检查：后台进程存在不能代表 Codex 已打开。'
}
Import-Module $modulePath -Force
function Assert-Condition {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}
function New-FixtureProcess {
    param([int]$Id, [long]$WindowHandle = 0, [bool]$Responding = $true)
    [pscustomobject]@{ Id = $Id; MainWindowHandle = $WindowHandle; Responding = $Responding; StartTime = [datetime]'2026-10-13' }
}

# 不访问系统进程；只向实际等待逻辑提供逐轮变化的进程快照。
$background = New-FixtureProcess 101
$result = Wait-CodexWindow -GetProcesses { $background } -TimeoutSeconds 0
Assert-Condition ($result.Status -eq 'TimedOut' -and $null -eq $result.Process) '只有后台进程时误报了启动成功。'
Assert-Condition ($result.ProcessIds.Count -eq 1 -and $result.ProcessIds[0] -eq 101) '超时结果丢失了仍在后台的 PID。'

$state = @{ Polls = 0; Progress = 0 }
$window = New-FixtureProcess 202 1234
$result = Wait-CodexWindow -TimeoutSeconds 2 -PollIntervalMilliseconds 1 -GetProcesses {
    $state.Polls++
    if ($state.Polls -lt 3) { $background } else { $background; $window }
} -OnProgress { param($progress) $state.Progress++ }
Assert-Condition ($state.Polls -eq 3 -and $result.Status -eq 'Ready' -and $result.Process.Id -eq 202) '没有等待窗口出现，或错把无窗口的初始 PID 绑定成主进程。'
Assert-Condition ($state.Progress -ge 1) '等待期间没有报告进度。'

$result = Wait-CodexWindow -GetProcesses { $window; $background } -TimeoutSeconds 0
Assert-Condition ($result.Status -eq 'Ready' -and $result.Process.Id -eq 202) '已有可用窗口被误判成启动失败。'
$unresponsive = New-FixtureProcess 303 2345 $false
$result = Wait-CodexWindow -GetProcesses { $unresponsive } -TimeoutSeconds 0
Assert-Condition ($result.Status -eq 'TimedOut') '未响应的窗口被误判成可用窗口。'
$result = Wait-CodexWindow -GetProcesses { } -TimeoutSeconds 0
Assert-Condition ($result.Status -eq 'Exited' -and $result.ProcessIds.Count -eq 0) '进程消失后仍报告启动成功。'

# 退出或权限变化会使窗口属性读取失败；应继续寻找真正可用的窗口。
$inaccessible = [pscustomobject]@{ Id = 404 }
$inaccessible | Add-Member -MemberType ScriptProperty -Name MainWindowHandle -Value { throw 'Process exited.' }
$result = Wait-CodexWindow -GetProcesses { $inaccessible; $window } -TimeoutSeconds 0
Assert-Condition ($result.Status -eq 'Ready' -and $result.Process.Id -eq 202) '一个退出的子进程阻断了主窗口检测。'

$state = @{ Polls = 0 }
$result = Wait-CodexWindow -TimeoutSeconds 2 -PollIntervalMilliseconds 1 -GetProcesses {
    $state.Polls++
    if ($state.Polls -eq 1) { $background }
    elseif ($state.Polls -ge 3) { $window }
}
Assert-Condition ($result.Status -eq 'Ready' -and $state.Polls -eq 3) '初始进程向主进程交接时的短暂空档被误判成退出。'

$state = @{ Activated = 0; Polls = 0 }
$result = Open-CodexExistingWindow -TimeoutSeconds 2 -PollIntervalMilliseconds 1 -GetProcesses {
    $state.Polls++
    if ($state.Activated -gt 0 -and $state.Polls -ge 3) { $window } else { $background }
} -RequestActivation { $state.Activated++ }
Assert-Condition ($result.Status -eq 'Ready' -and $state.Activated -eq 1 -and $state.Polls -eq 3) '没有唤起隐藏窗口并等待显示，或重复发送了激活请求。'
$state.Activated = 0
$result = Open-CodexExistingWindow -GetProcesses { $window } -RequestActivation { $state.Activated++ } -TimeoutSeconds 0
Assert-Condition ($result.Status -eq 'Ready' -and $state.Activated -eq 0) '已有可用窗口时仍启动了多余的进程。'
$result = Open-CodexExistingWindow -GetProcesses { $background } -RequestActivation { $state.Activated++ } -TimeoutSeconds 0
Assert-Condition ($result.Status -eq 'TimedOut' -and $state.Activated -eq 1) '激活请求已发送却没有窗口时误报了成功。'
$state.Activated = 0
$result = Open-CodexExistingWindow -GetProcesses { } -RequestActivation { $state.Activated++ } -TimeoutSeconds 0
Assert-Condition ($result.Status -eq 'Exited' -and $state.Activated -eq 0) '已退出的实例不应再被当作已有实例激活。'
Write-Host 'Startup readiness: background-only, delayed window, handoff, existing window, unresponsive window and exit checks passed.'
