$ErrorActionPreference = 'Stop'
$script:Passed = 0
function Assert-Equal($Expected, $Actual, [string]$Name) {
    if ($Expected -ne $Actual) { throw "FAIL [$Name]: expected '$Expected', got '$Actual'" }
    $script:Passed++
}

$projectRoot = Split-Path $PSScriptRoot -Parent
$module = Import-Module (Join-Path $projectRoot 'ConnectionWatchdog.psm1') -Force -PassThru
Import-Module (Join-Path $projectRoot 'CodexProxyLauncher.psm1') -Force
$watchdogPath = Join-Path $projectRoot 'Watch-CodexConnection.ps1'
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($watchdogPath, [ref]$tokens, [ref]$parseErrors)
Assert-Equal 0 $parseErrors.Count 'watchdog syntax'
foreach ($name in @('Write-WatchdogLog', 'Get-CurrentSystemProxyUri', 'Test-WatchdogRootIdentity', 'Enter-WatchdogMutex')) {
    $definition = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
    if (-not $definition) { throw "FAIL: missing $name" }
    . ([scriptblock]::Create($definition.Extent.Text))
}

# 用主进程标识替身检查 PID 复用；不查询或结束真实进程。
$started = [datetime]'2026-10-01T10:00:00Z'
$exe = 'C:\fixture\ChatGPT.exe'
$root = [pscustomobject]@{ Path = $exe; StartTime = $started }
Assert-Equal $true (Test-WatchdogRootIdentity -Process $root -ExecutablePath $exe -StartedAt $started) 'selected root remains monitored'
$reused = [pscustomobject]@{ Path = $exe; StartTime = $started.AddSeconds(1) }
Assert-Equal $false (Test-WatchdogRootIdentity -Process $reused -ExecutablePath $exe -StartedAt $started) 'same path and reused PID are rejected'
$other = [pscustomobject]@{ Path = 'C:\fixture\unrelated.exe'; StartTime = $started }
Assert-Equal $false (Test-WatchdogRootIdentity -Process $other -ExecutablePath $exe -StartedAt $started) 'different executable is rejected'
Assert-Equal $false (Test-WatchdogRootIdentity -Process $null -ExecutablePath $exe -StartedAt $started) 'exited root is rejected'
$mutexAssignment = $ast.Find({
    param($node)
    $node -is [Management.Automation.Language.AssignmentStatementAst] -and
        $node.Left -is [Management.Automation.Language.VariableExpressionAst] -and
        $node.Left.VariablePath.UserPath -eq 'mutexName'
}, $true)
$RootProcessId = 100
$rootStartedAt = $started
. ([scriptblock]::Create($mutexAssignment.Extent.Text))
$firstMutexName = $mutexName
$rootStartedAt = $started.AddSeconds(1)
. ([scriptblock]::Create($mutexAssignment.Extent.Text))
Assert-Equal $false ($firstMutexName -eq $mutexName) 'reused root PID does not block the replacement watcher during recovery handoff'
$rootStartedAt = $started
. ([scriptblock]::Create($mutexAssignment.Extent.Text))
Assert-Equal $firstMutexName $mutexName 'duplicate watchers for the same root instance share one mutex'
$mutexFixture = [pscustomobject]@{ Mode = 'Busy' }
$mutexFixture | Add-Member -MemberType ScriptMethod -Name WaitOne -Value {
    param($Timeout)
    if ($this.Mode -eq 'Abandoned') { throw [Threading.AbandonedMutexException]::new() }
    $this.Mode -eq 'Available'
}
Assert-Equal $false (Enter-WatchdogMutex -Mutex $mutexFixture -CreatedNew $false) 'active watcher retains exclusive ownership'
$mutexFixture.Mode = 'Available'
Assert-Equal $true (Enter-WatchdogMutex -Mutex $mutexFixture -CreatedNew $false) 'unowned existing mutex can be acquired'
$mutexFixture.Mode = 'Abandoned'
Assert-Equal $true (Enter-WatchdogMutex -Mutex $mutexFixture -CreatedNew $false) 'abandoned mutex acquisition is accepted after old watcher exits'

$ProxyMode = 'Explicit'
$InitialProxyUri = 'http://127.0.0.1:9674'
Assert-Equal $InitialProxyUri (Get-CurrentSystemProxyUri) 'explicit proxy does not switch to registry proxy'

$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ("codex-watchdog-reliability-$([guid]::NewGuid().ToString('N'))")
[void](New-Item -ItemType Directory -Path $temporaryRoot)
try {
    $logPath = Join-Path $temporaryRoot 'connection-watchdog.log'
    $utf8NoBom = [Text.UTF8Encoding]::new($false)
    # Store 更新可能删除旧应用磁盘路径，但旧映像仍在运行；正式初始化必须能继续绑定它。
    $mainTry = @($ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.TryStatementAst] })[0]
    $initializationStatements = @()
    foreach ($statement in $mainTry.Body.Statements) {
        if ($statement -is [Management.Automation.Language.AssignmentStatementAst] -and
            $statement.Left -is [Management.Automation.Language.VariableExpressionAst] -and
            $statement.Left.VariablePath.UserPath -eq 'state') { break }
        $initializationStatements += $statement.Extent.Text
    }
    $initialize = [scriptblock]::Create($initializationStatements -join [Environment]::NewLine)
    $CodexExecutable = Join-Path $temporaryRoot 'deleted-app-package\ChatGPT.exe'
    $RootProcessId = 999991
    $PollSeconds = 3
    $VpnAssistCooldownSeconds = 600
    $createdNew = $false
    $mutex = $null
    function Get-Process {
        [CmdletBinding()]param([int]$Id)
        [pscustomobject]@{ Id = $Id; Path = $CodexExecutable; StartTime = $started }
    }
    try {
        . $initialize
        Assert-Equal $false (Test-Path -LiteralPath $CodexExecutable) 'old application package fixture is absent on disk'
        Assert-Equal $started $rootStartedAt 'initialization binds the still-live original process after its package is deleted'
    }
    finally {
        if ($null -ne $mutex) {
            try { $mutex.ReleaseMutex() } catch { }
            $mutex.Dispose()
        }
    }
    [IO.File]::WriteAllText($logPath, ('旧' * 400000), $utf8NoBom)
    Write-WatchdogLog '轮转后日志仍可写入。'
    Assert-Equal $true (Test-Path -LiteralPath "$logPath.1" -PathType Leaf) 'large watchdog log rotates once'
    Assert-Equal $true ((Get-Item -LiteralPath $logPath).Length -lt 1024) 'active log is bounded after rotation'
    Assert-Equal $true ((Get-Content -LiteralPath $logPath -Raw -Encoding utf8) -match '轮转后日志仍可写入') 'Chinese log survives rotation'
    $lockedLog = [IO.File]::Open($logPath, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    try {
        $WarningPreference = 'SilentlyContinue'
        Write-WatchdogLog '日志临时被占用时监视器仍应继续。'
        Assert-Equal $true $true 'temporary log lock must not terminate monitoring'
    }
    finally { $lockedLog.Dispose() }
}
finally {
    foreach ($file in @(Get-ChildItem -LiteralPath $temporaryRoot -File)) { Remove-Item -LiteralPath $file.FullName -Force }
    Remove-Item -LiteralPath $temporaryRoot
}

# 查询失败不能等同于“确认未连接”，否则会误触发重启。
$connection = & $module {
    function script:Get-NetTCPConnection { [CmdletBinding()]param($State) throw 'fixture TCP query unavailable' }
    Get-CodexProxyConnectionStatus -ProcessIds @(123) -ProxyUri 'http://127.0.0.1:7890'
}
Assert-Equal $false $connection.Known 'TCP query failure is unknown'
Assert-Equal $false $connection.Connected 'TCP query failure does not invent a connection'
$connection = & $module {
    function script:Get-NetTCPConnection { [CmdletBinding()]param($State) @() }
    Get-CodexProxyConnectionStatus -ProcessIds @(123) -ProxyUri 'http://127.0.0.1:7890'
}
Assert-Equal $true $connection.Known 'empty successful query is known'
Assert-Equal $false $connection.Connected 'empty successful query is disconnected'
$connection = & $module {
    function script:Get-NetTCPConnection {
        [CmdletBinding()]param($State)
        [pscustomobject]@{ OwningProcess = 123; RemotePort = 7890; RemoteAddress = '127.0.0.1' }
        [pscustomobject]@{ OwningProcess = 456; RemotePort = 7890; RemoteAddress = '127.0.0.1' }
    }
    Get-CodexProxyConnectionStatus -ProcessIds @(123) -ProxyUri 'http://127.0.0.1:7890'
}
Assert-Equal $true $connection.Known 'TCP connection query is known'
Assert-Equal $true $connection.Connected 'selected descendant TCP connection is detected'
$ipv6 = & $module {
    function script:Get-NetTCPConnection {
        [CmdletBinding()]param($State)
        [pscustomobject]@{ OwningProcess = 123; RemotePort = 7890; RemoteAddress = '::1' }
    }
    Get-CodexProxyConnectionStatus -ProcessIds @(123) -ProxyUri 'http://[::1]:7890'
}
Assert-Equal $true $ipv6.Known 'IPv6 loopback proxy is a supported query target'
Assert-Equal $true $ipv6.Connected 'IPv6 loopback proxy connection is detected'

Write-Host "Watchdog reliability tests passed. Assertions: $script:Passed"
