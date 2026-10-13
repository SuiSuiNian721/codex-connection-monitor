$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$launcherPath = Join-Path $projectRoot 'Start-CodexWithProxy.ps1'
$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($launcherPath, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw '启动器语法错误。' }
foreach ($name in @('Get-CodexStartupBackgroundRoot', 'Complete-CodexStartup', 'Confirm-CodexWindowReady')) {
    $definition = $ast.Find({ param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
    }, $true)
    if (-not $definition) { throw "窗口超时后仍需保留本次进程的监测，缺少实际处理函数：$name" }
    # 只加载实际辅助函数；不执行启动器 main，也不导入真实后台服务。
    . ([scriptblock]::Create($definition.Extent.Text))
}
function Assert-Condition { param([bool]$Condition, [string]$Message) if (-not $Condition) { throw $Message } }
$script:fixtureExecutable = 'C:\fixture\OpenAI.Codex\app\ChatGPT.exe'
$script:launchTime = [datetime]'2026-10-13T04:25:00Z'
function New-RootFixture {
    param([int]$Id = 101, [datetime]$StartTime = $script:launchTime.AddSeconds(1), [string]$Path = $script:fixtureExecutable)
    [pscustomobject]@{ Id = $Id; Path = $Path; StartTime = $StartTime; MainWindowHandle = 0 }
}
function New-CimFixture {
    param([object]$Process, [string]$CommandLine = '"C:\fixture\OpenAI.Codex\app\ChatGPT.exe" --proxy-server=http://127.0.0.1:23456')
    [pscustomobject]@{ ProcessId = $Process.Id; ExecutablePath = $Process.Path; CreationDate = $Process.StartTime; CommandLine = $CommandLine }
}
function Get-RunningCodexProcesses {
    param($ExecutablePath)
    if ($ExecutablePath -ne $script:fixtureExecutable) { throw '查询了测试外安装路径。' }
    $script:fixtureProcesses
}
function Get-CimInstance {
    param($ClassName, $Filter, $ErrorAction)
    if ($ClassName -ne 'Win32_Process' -or $Filter -notmatch '^ProcessId = (\d+)$') { throw '查询了测试外进程信息。' }
    $script:cimRows[[int]$Matches[1]]
}
function Register-CodexGenerationBinding {
    param($Configuration, $CodexProcess)
    $script:bound.Add($CodexProcess.Id)
}
function Start-ConnectionWatchdog {
    param($RootProcessId, $CodexExecutable, $ProxyUri, $ProxyMode, $RelayStatePath)
    if ($CodexExecutable -ne $script:fixtureExecutable -or $ProxyUri -ne 'http://127.0.0.1:23456') { throw '监测没有沿用本次启动入口。' }
    $script:watched.Add($RootProcessId)
}
function Write-LauncherLog { param($Message, $Level) $script:messages.Add($Message) }
function Start-Process { throw '此测试不允许启动系统进程。' }
function Stop-Process { throw '此测试不允许终止系统进程。' }
function Reset-Services {
    $script:bound = [Collections.Generic.List[int]]::new()
    $script:watched = [Collections.Generic.List[int]]::new()
    $script:messages = [Collections.Generic.List[string]]::new()
    $script:performanceStarts = 0
}
function Invoke-StartupFixture {
    param([string]$Status, [object]$WindowProcess, [switch]$Disabled)
    $result = [pscustomobject]@{ Status = $Status; Process = $WindowProcess; ProcessIds = @(101); ElapsedSeconds = 90 }
    $arguments = @{
        StartupWindow = $result; CodexExecutable = $script:fixtureExecutable
        LaunchStartedAt = $script:launchTime; InitialProcessId = 101
        GenerationConfiguration = if ($Disabled) { $null } else { [pscustomobject]@{ LaunchId = 'fixture' } }
        ProxyUri = 'http://127.0.0.1:23456'; ProxyMode = 'Explicit'; RelayStatePath = 'C:\fixture\service.json'
        NoWatchdog = $Disabled; NoPerformanceMonitor = $Disabled
        StartPerformanceMonitor = { $script:performanceStarts++; [pscustomobject]@{ ProcessId = 303 } }
    }
    Complete-CodexStartup @arguments
}
function Assert-StartupFails {
    param([string]$Status = 'TimedOut', [switch]$Disabled)
    $failed = $false
    try { $null = Invoke-StartupFixture -Status $Status -Disabled:$Disabled }
    catch {
        $failed = $true
        Assert-Condition ($_.Exception.Message -match '启动未完成') '必须明确返回窗口未就绪，不能被其他测试错误代替。'
    }
    Assert-Condition $failed '后台进程仍存在时误报了启动成功。'
}

$root = New-RootFixture
$script:fixtureProcesses = @($root)
$script:cimRows = @{ 101 = New-CimFixture $root }
Reset-Services
Assert-StartupFails
Assert-Condition ($script:bound.Count -eq 1 -and $script:bound[0] -eq 101) '等待超时丢失了本次 GUI 的实时采集绑定。'
Assert-Condition ($script:watched.Count -eq 1 -and $script:watched[0] -eq 101 -and $script:performanceStarts -eq 1) '等待超时丢失了后台连接或性能监测。'

# Ready 必须使用真正拥有窗口的进程，不能退回最初返回的 PID。
Reset-Services
$actualWindow = New-RootFixture -Id 202
$actualWindow.MainWindowHandle = 1234
$actual = Invoke-StartupFixture -Status Ready -WindowProcess $actualWindow
Assert-Condition ($actual.Id -eq 202 -and $script:bound[0] -eq 202 -and $script:watched[0] -eq 202 -and $script:performanceStarts -eq 1) 'Ready 未绑定实际窗口进程。'

foreach ($case in @('renderer', 'stale', 'wrong-path', 'reused-pid', 'missing-command', 'ambiguous', 'custom-profile', 'different-proxy', 'missing-proxy')) {
    $root = New-RootFixture
    $script:fixtureProcesses = @($root)
    $record = New-CimFixture $root
    switch ($case) {
        'renderer' { $record.CommandLine += ' --type=renderer' }
        'stale' { $root.StartTime = $script:launchTime.AddSeconds(-10); $record.CreationDate = $root.StartTime }
        'wrong-path' { $record.ExecutablePath = 'C:\other\ChatGPT.exe' }
        'reused-pid' { $record.CreationDate = $root.StartTime.AddSeconds(1) }
        'missing-command' { $record.CommandLine = $null }
        'custom-profile' { $record.CommandLine += ' --user-data-dir=C:\other-profile' }
        'different-proxy' { $record.CommandLine = '"C:\fixture\OpenAI.Codex\app\ChatGPT.exe" --proxy-server=http://127.0.0.1:9999' }
        'missing-proxy' { $record.CommandLine = '"C:\fixture\OpenAI.Codex\app\ChatGPT.exe"' }
        'ambiguous' { $second = New-RootFixture -Id 102; $script:fixtureProcesses += $second }
    }
    $script:cimRows = @{ 101 = $record }
    if ($case -eq 'ambiguous') { $script:cimRows[102] = New-CimFixture $second }
    Reset-Services
    Assert-StartupFails
    Assert-Condition ($script:bound.Count -eq 0 -and $script:watched.Count -eq 0 -and $script:performanceStarts -eq 0) "不确定的身份被绑定：$case"
    Assert-Condition (($script:messages -join "`n") -match '无法确认') "没有说明身份不可确认：$case"
}

# CIM 时间可能损失不足 1 ms 的精度；允许粒度差，不能接受实际 PID 复用。
$root = New-RootFixture
$script:fixtureProcesses = @($root)
$record = New-CimFixture $root
$record.CreationDate = $root.StartTime.AddTicks(-1)
$script:cimRows = @{ 101 = $record }
Reset-Services
Assert-StartupFails
Assert-Condition ($script:bound.Count -eq 1) 'CIM 微秒精度差导致真实进程被拒绝。'
Reset-Services
Assert-StartupFails -Status Exited
Assert-Condition ($script:bound.Count -eq 0 -and $script:watched.Count -eq 0 -and $script:performanceStarts -eq 0) '进程已退出仍建立了监测。'
Reset-Services
Assert-StartupFails -Disabled
Assert-Condition ($script:bound.Count -eq 0 -and $script:watched.Count -eq 0 -and $script:performanceStarts -eq 0) '禁用开关被超时恢复绕过。'
Write-Host 'Startup monitor timeout: retained monitoring, exact identity, actual ready root, disabled services and failed readiness passed; no application was launched.'
