[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][int]$RootProcessId,
    [Parameter(Mandatory = $true)][string]$CodexExecutable,
    [Parameter(Mandatory = $true)][string]$InitialProxyUri,
    [string]$RelayStatePath,
    [ValidateSet('System', 'Explicit')][string]$ProxyMode = 'System',
    [int]$OutageSeconds = 180,
    [int]$RecoverySeconds = 15,
    [int]$PollSeconds = 3,
    [int]$VpnAssistCooldownSeconds = 600,
    [switch]$NoVpnAssist
)

$ErrorActionPreference = 'Stop'
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$logPath = Join-Path $scriptRoot 'connection-watchdog.log'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

Import-Module (Join-Path $scriptRoot 'CodexProxyLauncher.psm1') -Force
Import-Module (Join-Path $scriptRoot 'ConnectionWatchdog.psm1') -Force
Import-Module (Join-Path $scriptRoot 'VpnRecoveryGate.psm1') -Force

function Write-WatchdogLog {
    param([string]$Message, [string]$Level = 'INFO')

    $line = '{0} [{1}] {2}{3}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message, [Environment]::NewLine
    try {
        if ([IO.File]::Exists($logPath) -and (Get-Item -LiteralPath $logPath).Length -ge 1MB) {
            [IO.File]::Move($logPath, "$logPath.1", $true)
        }
        [IO.File]::AppendAllText($logPath, $line, $utf8NoBom)
    }
    catch {
        Write-Warning "无法写入连接监视日志，监视继续：$($_.Exception.Message)"
    }
}

function Get-CurrentSystemProxyUri {
    if ($ProxyMode -eq 'Explicit') { return $InitialProxyUri }
    try {
        $settings = Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
        if ([int]$settings.ProxyEnable -ne 1) { return $null }
        ConvertTo-ProxyUri -ProxyServer ([string]$settings.ProxyServer)
    }
    catch {
        return $null
    }
}

function Test-WatchdogRootIdentity {
    param($Process, [string]$ExecutablePath, [datetime]$StartedAt)

    if ($null -eq $Process) { return $false }
    try {
        $Process.StartTime -eq $StartedAt -and
            [IO.Path]::GetFullPath([string]$Process.Path) -ieq [IO.Path]::GetFullPath($ExecutablePath)
    }
    catch { return $false }
}

function Enter-WatchdogMutex {
    param($Mutex, [bool]$CreatedNew)

    if ($CreatedNew) { return $true }
    try { return $Mutex.WaitOne(0) }
    catch {
        $exception = $_.Exception
        while ($null -ne $exception) {
            if ($exception -is [Threading.AbandonedMutexException]) { return $true }
            $exception = $exception.InnerException
        }
        throw
    }
}

function Get-LiveProcessSnapshot {
    @(Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object Name, ProcessId, ParentProcessId, CommandLine, ExecutablePath)
}

$createdNew = $false
$mutex = $null

try {
    if ($PollSeconds -lt 1) { throw 'PollSeconds must be at least 1.' }
    if ($VpnAssistCooldownSeconds -lt 1) { throw 'VpnAssistCooldownSeconds must be at least 1.' }
    if ($RelayStatePath) {
        try { Import-Module (Join-Path $scriptRoot 'CodexProxyRelay.psm1') -Force }
        catch { Write-WatchdogLog '无法加载 relay 状态读取器；继续观察固定客户端入口，暂停 VPN 辅助。' 'WARN' }
    }

    $rootProcess = Get-Process -Id $RootProcessId -ErrorAction SilentlyContinue
    if (-not $rootProcess) {
        Write-WatchdogLog 'GPT 主进程已在监视器初始化前退出。'
        exit 0
    }
    $rootStartedAt = $rootProcess.StartTime
    if (-not (Test-WatchdogRootIdentity -Process $rootProcess -ExecutablePath $CodexExecutable -StartedAt $rootStartedAt)) {
        throw '主进程路径与启动目标不一致，拒绝监视可能已复用的 PID。'
    }
    $mutexName = "Local\CodexProxyWatchdog-$RootProcessId-$($rootStartedAt.ToUniversalTime().Ticks)"
    $mutex = New-Object Threading.Mutex($true, $mutexName, [ref]$createdNew)
    if (-not (Enter-WatchdogMutex -Mutex $mutex -CreatedNew $createdNew)) { exit 0 }

    $state = New-ConnectionWatchState -InitialProxyUri $InitialProxyUri -Now (Get-Date)
    $lastInternetProbeAt = [datetime]::MinValue
    $lastProbedProxyUri = $null
    $lastInternetHealthy = $false
    $lastInternetResult = $null
    $lastDiagnosticKey = $null
    $lastDiagnosticAt = [datetime]::MinValue
    $unknownConnectionLogged = $false
    $lastSnapshotFailureAt = [datetime]::MinValue
    $lastNaturalWaitLoggedAt = [datetime]::MinValue
    $lastVpnAssistAt = [datetime]::MinValue
    $vpnFailureSince = $null
    $lastVpnFailureProxy = ''
    $lastSystemProxyKey = $null
    $lastRelayRouteKey = $null

    $initialEndpoint = ([uri]$InitialProxyUri).GetLeftPart([UriPartial]::Authority) -replace '://[^/@]+@', '://'
    Write-WatchdogLog "监视器已启动。RootPID=$RootProcessId ClientProxy=$initialEndpoint Mode=$ProxyMode Relay=$([bool]$RelayStatePath)"
    Write-WatchdogLog '探测策略 v2：超时 8 秒；正常或持续故障时每 30 秒探测。HTTP 响应仅证明传输可达，不验证登录、模型或上下文压缩接口。'
    Write-WatchdogLog '监视器仅记录网络状态并等待客户端自然恢复，不关闭或重新启动 GPT。'
    if (-not $NoVpnAssist) {
        Write-WatchdogLog "长期传输故障辅助已启用：阈值 $OutageSeconds 秒，冷却 $VpnAssistCooldownSeconds 秒；仅接入已有 OpenAI 专用自动策略，不改共享节点、不重载 VPN。"
    }

    while ($true) {
        $rootProcess = Get-Process -Id $RootProcessId -ErrorAction SilentlyContinue
        $rootAlive = Test-WatchdogRootIdentity -Process $rootProcess -ExecutablePath $CodexExecutable -StartedAt $rootStartedAt
        $now = Get-Date
        if (-not $rootAlive) { break }

        # 进程的代理参数不会随着注册表变化；固定入口始终来自本次启动参数。
        $proxyUri = $InitialProxyUri
        if ($ProxyMode -eq 'System') {
            $systemProxyUri = Get-CurrentSystemProxyUri
            $systemProxyKey = [string]$systemProxyUri
            if (-not $RelayStatePath -and $systemProxyUri -ine $proxyUri -and $systemProxyKey -cne $lastSystemProxyKey) {
                $systemEndpoint = if ($systemProxyUri) { ([uri]$systemProxyUri).GetLeftPart([UriPartial]::Authority) -replace '://[^/@]+@', '://' } else { '(none)' }
                $clientEndpoint = ([uri]$proxyUri).GetLeftPart([UriPartial]::Authority) -replace '://[^/@]+@', '://'
                Write-WatchdogLog "系统代理与当前客户端入口不一致：ClientProxy=$clientEndpoint SystemProxy=$systemEndpoint。此旧会话未使用 relay，需正常退出并重新打开 GPT 才会应用新入口；继续检查当前客户端入口。" 'WARN'
            }
            $lastSystemProxyKey = $systemProxyKey
        }

        $upstreamProxyUri = $proxyUri
        $relayReady = $true
        $relayStatus = $null
        if ($RelayStatePath) {
            try { $relayStatus = Get-CodexProxyRelayStatus -StatePath $RelayStatePath -ExpectedClientProxyUri $InitialProxyUri }
            catch { $relayStatus = [pscustomobject]@{ Known = $false; Ready = $false; ErrorKind = 'StatusReadFailure' } }
            $relayReady = $null -ne $relayStatus -and $relayStatus.Known -and $relayStatus.Ready -and
                $relayStatus.ClientProxyUri -ieq $InitialProxyUri -and -not [string]::IsNullOrWhiteSpace([string]$relayStatus.UpstreamProxyUri)
            $upstreamProxyUri = if ($relayReady) { [string]$relayStatus.UpstreamProxyUri } else { '' }
            $relayRouteKey = "$($relayStatus.Known)|$relayReady|$upstreamProxyUri|$($relayStatus.InstanceId)|$($relayStatus.ProcessId)"
            if ($relayRouteKey -cne $lastRelayRouteKey) {
                # 同一固定入口切换上游后，旧上游的 HTTP 结果不能作为新链路的证明。
                if ($null -ne $lastRelayRouteKey -and $state.Status -in @('RecoveryPending', 'RecoveryEvaluationRequested')) {
                    $state.Status = 'Outage'
                    $state.RecoverySince = $null
                    $state.PendingProxyUri = $null
                }
                $lastInternetProbeAt = [datetime]::MinValue
                $lastInternetResult = $null
                $lastInternetHealthy = $false
                $lastProbedProxyUri = $null
                $vpnFailureSince = $null
                $lastVpnFailureProxy = ''
                $clientEndpoint = ([uri]$proxyUri).GetLeftPart([UriPartial]::Authority) -replace '://[^/@]+@', '://'
                if ($relayReady) {
                    $upstreamEndpoint = ([uri]$upstreamProxyUri).GetLeftPart([UriPartial]::Authority) -replace '://[^/@]+@', '://'
                    Write-WatchdogLog "relay 路由已核对：ClientProxy=$clientEndpoint UpstreamProxy=$upstreamEndpoint；固定客户端入口保持不变，新上游的传输状态需重新探测。"
                }
                else {
                    Write-WatchdogLog "relay 状态不可确认或尚未就绪：ClientProxy=$clientEndpoint；继续检查该入口，暂停 VPN 辅助，不把 HTTP 响应判作已核对的链路恢复。" 'WARN'
                }
                $lastRelayRouteKey = $relayRouteKey
            }
        }
        $localHealthy = $false
        if ($proxyUri) {
            $localHealthy = Test-LocalProxy -ProxyUri $proxyUri -TimeoutMilliseconds 1500
        }

        $now = Get-Date
        $probeIntervalSeconds = Get-ConnectionProbeIntervalSeconds -Status $state.Status -PollSeconds $PollSeconds
        $shouldProbeInternet = $localHealthy -and (
            $proxyUri -ine $lastProbedProxyUri -or
            ($now - $lastInternetProbeAt).TotalSeconds -ge $probeIntervalSeconds
        )
        if ($shouldProbeInternet) {
            $lastInternetResult = Get-ProxyInternetStatus -ProxyUri $proxyUri -TimeoutMilliseconds 8000
            $lastInternetHealthy = $lastInternetResult.Reachable
            $lastInternetProbeAt = Get-Date
            $lastProbedProxyUri = $proxyUri
        }
        elseif (-not $localHealthy) {
            $lastInternetHealthy = $false
            $lastInternetResult = $null
            $lastProbedProxyUri = $null
            $lastInternetProbeAt = [datetime]::MinValue
        }

        $now = Get-Date
        $probeKind = if (-not $localHealthy) { 'LocalProxyUnavailable' }
            elseif (-not $relayReady) { 'RelayUnavailable' }
            elseif ($null -ne $lastInternetResult) { $lastInternetResult.Kind }
            else { 'NotProbed' }
        $httpStatus = if ($null -ne $lastInternetResult) { [string]$lastInternetResult.HttpStatus } else { '' }
        $diagnosticKey = "$proxyUri|$upstreamProxyUri|$probeKind|$httpStatus"
        $diagnosticWarning = -not $relayReady -or -not $lastInternetHealthy -or $probeKind -in @('RateLimited', 'ServerError')
        if ($diagnosticKey -cne $lastDiagnosticKey -or
            ($diagnosticWarning -and ($now - $lastDiagnosticAt).TotalSeconds -ge 300)) {
            $proxyEndpoint = if ($proxyUri) { ([uri]$proxyUri).GetLeftPart([UriPartial]::Authority) -replace '://[^/@]+@', '://' } else { '(none)' }
            $upstreamEndpoint = if ($upstreamProxyUri) { ([uri]$upstreamProxyUri).GetLeftPart([UriPartial]::Authority) -replace '://[^/@]+@', '://' } else { '(unknown)' }
            $detail = "代理探测：ClientProxy=$proxyEndpoint UpstreamProxy=$upstreamEndpoint ProbeKind=$probeKind HTTP=$httpStatus"
            if ($null -ne $lastInternetResult) {
                $detail += " Target=$($lastInternetResult.TargetHost) ElapsedMs=$($lastInternetResult.ElapsedMilliseconds) ErrorType=$($lastInternetResult.ErrorType) SocketError=$($lastInternetResult.SocketErrorCode)"
            }
            Write-WatchdogLog $detail $(if ($diagnosticWarning) { 'WARN' } else { 'INFO' })
            $lastDiagnosticKey = $diagnosticKey
            $lastDiagnosticAt = $now
        }

        $isHealthy = $relayReady -and $localHealthy -and $lastInternetHealthy -and
            ($now - $lastInternetProbeAt).TotalSeconds -le ([Math]::Max(15, $probeIntervalSeconds + $PollSeconds))
        $update = Update-ConnectionWatchState -State $state -IsHealthy $isHealthy -ProxyUri ([string]$proxyUri) -Now $now -OutageSeconds $OutageSeconds -RecoverySeconds $RecoverySeconds
        $state = $update.State

        if ($update.Action -eq 'LongOutageDetected') {
            Write-WatchdogLog "代理传输探测连续失败 $OutageSeconds 秒（ProbeKind=$probeKind）；保持 GPT 进程不变，等待后续探测。" 'WARN'
            if (-not $localHealthy) {
                Write-WatchdogLog '固定客户端代理入口未监听；不能通过切远端节点修复，未启动或重载 VPN。' 'WARN'
            }
        }
        elseif ($update.Action -eq 'EvaluateRecovery') {
            Write-WatchdogLog "代理传输探测连续通过 $RecoverySeconds 秒，检查 GPT 到固定客户端入口的 TCP 连接；这不代表模型接口已恢复。"
        }

        if (-not $NoVpnAssist) {
            $vpnFailureSince = Update-VpnTransportFailureSince -FailureSince $vpnFailureSince -Now $now -ProbeKind $probeKind `
                -LocalProxyHealthy ($localHealthy -and $relayReady) -ProxyUri ([string]$upstreamProxyUri) -PreviousProxyUri $lastVpnFailureProxy
            $lastVpnFailureProxy = [string]$upstreamProxyUri
            $vpnAssistDecision = Get-VpnRecoveryDecision -Status $state.Status -FailureSince $vpnFailureSince -Now $now `
                -OutageSeconds $OutageSeconds -CooldownSeconds $VpnAssistCooldownSeconds -LastAttemptAt $lastVpnAssistAt `
                -ProbeKind $probeKind -LocalProxyHealthy ($localHealthy -and $relayReady) -ProxyUri ([string]$upstreamProxyUri) -ActiveProxyUri ([string]$upstreamProxyUri)
            if ($vpnAssistDecision.ShouldRun -and (Test-WatchdogRootIdentity -Process (Get-Process -Id $RootProcessId -ErrorAction SilentlyContinue) -ExecutablePath $CodexExecutable -StartedAt $rootStartedAt)) {
                $upstreamStillVerified = $true
                if ($RelayStatePath) {
                    try {
                        $currentRelay = Get-CodexProxyRelayStatus -StatePath $RelayStatePath -ExpectedClientProxyUri $InitialProxyUri
                        $upstreamStillVerified = $currentRelay.Known -and $currentRelay.Ready -and
                            $currentRelay.ClientProxyUri -ieq $InitialProxyUri -and $currentRelay.UpstreamProxyUri -ieq $upstreamProxyUri -and
                            $currentRelay.InstanceId -ceq $relayStatus.InstanceId -and $currentRelay.ProcessId -eq $relayStatus.ProcessId
                    }
                    catch { $upstreamStillVerified = $false }
                }
                if ($upstreamStillVerified) {
                    $lastVpnAssistAt = Get-Date
                    $vpnAssist = Invoke-VpnAutoAssist -ProxyUri $upstreamProxyUri -ProbeKind $probeKind -RootProcessId $RootProcessId -RootStartedAt $rootStartedAt
                    Write-WatchdogLog "VPN 长故障辅助：Status=$($vpnAssist.Status) Action=$($vpnAssist.Action) Client=$($vpnAssist.Client)；$($vpnAssist.Message)" `
                        $(if ($vpnAssist.Status -in @('NativeAutomatic', 'SelectedAutomatic')) { 'INFO' } else { 'WARN' })
                }
                else {
                    $vpnFailureSince = $null
                    $lastVpnFailureProxy = ''
                    Write-WatchdogLog 'relay 上游在辅助检查期间发生变化或失联，本轮未执行 VPN 辅助；等待重新核对当前链路。' 'WARN'
                }
            }
        }

        if ($state.Status -eq 'RecoveryEvaluationRequested' -and $isHealthy) {
            try { $processes = Get-LiveProcessSnapshot }
            catch {
                if (($now - $lastSnapshotFailureAt).TotalSeconds -ge 60) {
                    Write-WatchdogLog '暂时无法查询 GPT 子进程，保留监视并等待后续检查。' 'WARN'
                    $lastSnapshotFailureAt = $now
                }
                Start-Sleep -Seconds $PollSeconds
                continue
            }
            $connectionTargets = @(Get-CodexConnectionTargets -Processes $processes -RootProcessId $RootProcessId)
            $connection = if ($connectionTargets.Count -gt 0) {
                Get-CodexProxyConnectionStatus -ProcessIds @($connectionTargets.ProcessId) -ProxyUri $proxyUri
            }
            else { [pscustomobject]@{ Known = $true; Connected = $false } }

            if (-not $connection.Known) {
                if (-not $unknownConnectionLogged) {
                    Write-WatchdogLog '暂时无法查询 GPT 的 TCP 连接；未知结果不作为未连接，继续等待后续检查。' 'WARN'
                    $unknownConnectionLogged = $true
                }
            }
            elseif ($connection.Connected) {
                $unknownConnectionLogged = $false
                $state = Complete-ConnectionRecovery -State $state -ProxyUri $proxyUri -Now (Get-Date)
                Write-WatchdogLog '检测到 GPT 到本地代理的 TCP 连接（本次启动的固定客户端入口），继续监视；任务是否恢复需以任务响应为准。'
            }
            else {
                $unknownConnectionLogged = $false
                if (($now - $lastNaturalWaitLoggedAt).TotalSeconds -ge 60) {
                    Write-WatchdogLog '代理传输已可达，尚未检测到 GPT 的 TCP 连接；保持客户端不变，继续等待其自然恢复。' 'WARN'
                    $lastNaturalWaitLoggedAt = $now
                }
            }
        }

        Start-Sleep -Seconds $PollSeconds
    }

    Write-WatchdogLog 'GPT 主进程已退出，监视器同步结束。'
}
catch {
    try { Write-WatchdogLog "监视器异常退出：$($_.Exception.Message)" 'ERROR' } catch { }
    exit 1
}
finally {
    if ($mutex) {
        try { $mutex.ReleaseMutex() } catch { }
        $mutex.Dispose()
    }
}
