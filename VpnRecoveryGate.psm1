Set-StrictMode -Version 2.0

function Update-VpnTransportFailureSince {
    [CmdletBinding()]
    param(
        [AllowNull()]$FailureSince,
        [Parameter(Mandatory = $true)][datetime]$Now,
        [Parameter(Mandatory = $true)][string]$ProbeKind,
        [Parameter(Mandatory = $true)][bool]$LocalProxyHealthy,
        [AllowEmptyString()][string]$ProxyUri,
        [AllowEmptyString()][string]$PreviousProxyUri
    )
    if (-not $LocalProxyHealthy -or [string]::IsNullOrWhiteSpace($ProxyUri) -or
        $ProbeKind -notin @('Timeout', 'TlsFailure', 'ConnectionFailure', 'NameResolutionFailure', 'ResponseFailure')) { return $null }
    if ($null -eq $FailureSince -or $ProxyUri -ine $PreviousProxyUri -or $Now -lt [datetime]$FailureSince) { return $Now }
    [datetime]$FailureSince
}

function Get-VpnRecoveryDecision {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Status,
        [AllowNull()]$FailureSince,
        [Parameter(Mandatory = $true)][datetime]$Now,
        [int]$OutageSeconds = 180,
        [int]$CooldownSeconds = 600,
        [datetime]$LastAttemptAt = [datetime]::MinValue,
        [Parameter(Mandatory = $true)][string]$ProbeKind,
        [Parameter(Mandatory = $true)][bool]$LocalProxyHealthy,
        [AllowEmptyString()][string]$ProxyUri,
        [AllowEmptyString()][string]$ActiveProxyUri
    )

    if ($OutageSeconds -lt 1 -or $CooldownSeconds -lt 1) { throw '故障阈值和冷却时间必须大于零。' }
    $reason = 'Ready'
    if ($Status -ne 'Outage') { $reason = 'NotInOutage' }
    elseif ($null -eq $FailureSince -or ($Now - [datetime]$FailureSince).TotalSeconds -lt $OutageSeconds) {
        $reason = 'ThresholdNotReached'
    }
    elseif (-not $LocalProxyHealthy) { $reason = 'LocalProxyUnavailable' }
    elseif ($ProbeKind -notin @('Timeout', 'TlsFailure', 'ConnectionFailure', 'NameResolutionFailure', 'ResponseFailure')) {
        $reason = 'NotTransportFailure'
    }
    elseif ([string]::IsNullOrWhiteSpace($ProxyUri) -or $ProxyUri -ine $ActiveProxyUri) { $reason = 'ProxyChanged' }
    elseif ($LastAttemptAt -ne [datetime]::MinValue -and ($Now - $LastAttemptAt).TotalSeconds -lt $CooldownSeconds) {
        $reason = 'Cooldown'
    }
    [pscustomobject]@{ ShouldRun = ($reason -eq 'Ready'); Reason = $reason }
}

function Get-VpnAssistMessage {
    param([string]$Status)
    switch ($Status) {
        'SelectedAutomatic' { '已验证 OpenAI 专用选择组切向现有自动策略；后续连接仍由客户端自行恢复。' }
        'NativeAutomatic' { 'OpenAI 已使用原生自动策略；保持核心自行故障转移，不重复切节点。' }
        'LocalProxyUnavailable' { '本地 VPN 代理服务不可用；换远端节点不能修复未监听的本地端口。' }
        'ManualOnly' { '当前路由只有手动节点，没有可安全接入的现成自动策略。' }
        'NeedsSetup' { '核心可能支持自动策略，但当前配置尚未具备可安全调用的自动链路。' }
        'UnsafeSharedPolicy' { '当前选择组被其他流量共享，未改变全局或共享节点选择。' }
        'ManualOverride' { '自动策略被人工固定，保留用户选择，未解除固定。' }
        'ChangedDuringCheck' { '检查期间配置或选择发生变化，本轮未继续操作。' }
        'SelectionUnverified' { '选择结果暂未确认，本轮不重试或覆盖后续用户选择。' }
        'PortMismatch' { '控制器代理端口与当前 Codex 代理不匹配，拒绝操作。' }
        'AmbiguousController' { '存在多个可能控制器，无法确定当前实例，拒绝操作。' }
        'UnknownRoute' { '无法证明 OpenAI 的实际路由链，未切换节点。' }
        'HelperUnavailable' { '辅助模块缺失，保留普通连接监测。' }
        'HelperTimeout' { '辅助评估超时，终止本次辅助程序；不关闭 VPN 或 Codex。' }
        'BlockedProbe' { '当前结果不是可触发换节点的传输硬故障。' }
        'InvalidProxy' { '代理地址不符合本机安全范围，未执行控制操作。' }
        'ControllerUnavailable' { '当前本机控制接口不可用，保留普通连接监测。' }
        'ApiError' { '本机控制接口未完成安全评估，未继续控制操作。' }
        'Unsupported' { '当前 VPN 尚未适配安全控制接口，保留普通连接监测。' }
        'NoController' { '未识别到当前代理的受支持控制器，保留普通连接监测。' }
        'RootExited' { 'GPT 原进程已退出或身份变化，本次辅助随之停止。' }
        default { '辅助结果无法确认，保留普通连接监测。' }
    }
}

function Invoke-VpnAutoAssist {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$ProxyUri,
        [Parameter(Mandatory = $true)][string]$ProbeKind,
        [int]$RootProcessId = 0,
        [datetime]$RootStartedAt = [datetime]::MinValue,
        [string]$HelperPath = (Join-Path $PSScriptRoot 'VpnRecoveryHelper.exe')
    )

    $status = 'HelperUnavailable'
    $action = 'None'
    $client = ''
    $process = $null
    if (Test-Path -LiteralPath $HelperPath -PathType Leaf) {
        try {
            $startInfo = [Diagnostics.ProcessStartInfo]::new()
            $startInfo.FileName = [IO.Path]::GetFullPath($HelperPath)
            $startInfo.UseShellExecute = $false
            $startInfo.CreateNoWindow = $true
            $startInfo.RedirectStandardOutput = $true
            $startInfo.RedirectStandardError = $true
            foreach ($argument in @('--vpn-assist', $ProxyUri, $ProbeKind)) { $startInfo.ArgumentList.Add($argument) }
            if ($RootProcessId -gt 0) {
                $startInfo.ArgumentList.Add([string]$RootProcessId)
                $startInfo.ArgumentList.Add([string]$RootStartedAt.ToFileTimeUtc())
            }
            $process = [Diagnostics.Process]::Start($startInfo)
            $stdout = $process.StandardOutput.ReadToEndAsync()
            $stderr = $process.StandardError.ReadToEndAsync()
            if (-not $process.WaitForExit(25000)) {
                # 仅终止本次自己创建的 helper，不处理 VPN、Codex 或其他用户进程。
                $process.Kill($true)
                $status = 'HelperTimeout'
            }
            elseif ($process.ExitCode -eq 0) {
                $raw = $stdout.GetAwaiter().GetResult()
                if ($raw.Length -gt 4096) { throw '辅助返回超出长度限制。' }
                $parsed = ConvertFrom-Json -InputObject $raw -ErrorAction Stop
                $allowedStatuses = @('SelectedAutomatic', 'NativeAutomatic', 'LocalProxyUnavailable', 'ManualOnly', 'NeedsSetup',
                    'UnsafeSharedPolicy', 'ManualOverride', 'ChangedDuringCheck', 'SelectionUnverified', 'PortMismatch',
                    'AmbiguousController', 'UnknownRoute', 'BlockedProbe', 'InvalidProxy', 'ControllerUnavailable',
                    'ApiError', 'Unsupported', 'NoController', 'RootExited')
                if ([string]$parsed.Status -notin $allowedStatuses -or [string]$parsed.Action -notin @('None', 'SelectAutomatic') -or
                    [string]$parsed.Client -notin @('', 'CFW', 'QingShan', 'ClashVerge', 'Mihomo')) {
                    throw '辅助返回不符合协议。'
                }
                $status = [string]$parsed.Status
                $action = [string]$parsed.Action
                $client = [string]$parsed.Client
            }
            else { $status = 'ApiError' }
        }
        catch { $status = 'ApiError'; $action = 'None'; $client = '' }
        finally { if ($process) { $process.Dispose() } }
    }
    # 不转发 helper 的原始 stderr、异常、响应正文或任意 Message 字段。
    [pscustomobject]@{ Status = $status; Action = $action; Client = $client; Message = (Get-VpnAssistMessage -Status $status) }
}

Export-ModuleMember -Function Get-VpnRecoveryDecision, Update-VpnTransportFailureSince, Invoke-VpnAutoAssist
