Set-StrictMode -Version 2.0

function Copy-ConnectionWatchState {
    param([Parameter(Mandatory = $true)]$State)

    [pscustomobject]@{
        Status = [string]$State.Status
        ActiveProxyUri = [string]$State.ActiveProxyUri
        PendingProxyUri = [string]$State.PendingProxyUri
        FailureSince = $State.FailureSince
        RecoverySince = $State.RecoverySince
        RecoveryReason = [string]$State.RecoveryReason
        LastRecoveryAt = $State.LastRecoveryAt
    }
}

function New-ConnectionWatchState {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$InitialProxyUri,
        [Parameter(Mandatory = $true)][datetime]$Now
    )

    [pscustomobject]@{
        Status = 'Healthy'
        ActiveProxyUri = $InitialProxyUri
        PendingProxyUri = $null
        FailureSince = $null
        RecoverySince = $null
        RecoveryReason = $null
        LastRecoveryAt = $Now
    }
}

function Update-ConnectionWatchState {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)][bool]$IsHealthy,
        [AllowEmptyString()][string]$ProxyUri,
        [Parameter(Mandatory = $true)][datetime]$Now,
        [int]$OutageSeconds = 180,
        [int]$RecoverySeconds = 15
    )

    if ($OutageSeconds -lt 1) { throw 'OutageSeconds must be at least 1.' }
    if ($RecoverySeconds -lt 1) { throw 'RecoverySeconds must be at least 1.' }

    $next = Copy-ConnectionWatchState -State $State
    $action = 'None'

    if (-not $IsHealthy) {
        $next.RecoverySince = $null
        $next.PendingProxyUri = $null

        switch ($next.Status) {
            'Healthy' {
                $next.Status = 'Suspect'
                $next.FailureSince = $Now
                $next.RecoveryReason = $null
            }
            'Suspect' {
                if ($null -eq $next.FailureSince) { $next.FailureSince = $Now }
                if (($Now - [datetime]$next.FailureSince).TotalSeconds -ge $OutageSeconds) {
                    $next.Status = 'Outage'
                    $next.RecoveryReason = 'LongOutage'
                    $action = 'LongOutageDetected'
                }
            }
            'RecoveryPending' {
                if ($null -eq $next.FailureSince) {
                    $next.Status = 'Suspect'
                    $next.FailureSince = $Now
                    $next.RecoveryReason = $null
                }
                else { $next.Status = 'Outage' }
            }
            'RecoveryEvaluationRequested' {
                if ($null -eq $next.FailureSince) {
                    $next.Status = 'Suspect'
                    $next.FailureSince = $Now
                    $next.RecoveryReason = $null
                }
                else { $next.Status = 'Outage' }
            }
        }

        return [pscustomobject]@{ State = $next; Action = $action }
    }

    $proxyChanged = -not [string]::IsNullOrWhiteSpace($ProxyUri) -and
        -not [string]::IsNullOrWhiteSpace($next.ActiveProxyUri) -and
        $ProxyUri -ine $next.ActiveProxyUri

    if ($next.Status -eq 'Suspect') {
        $next.FailureSince = $null
        if ($proxyChanged) {
            $next.Status = 'RecoveryPending'
            $next.PendingProxyUri = $ProxyUri
            $next.RecoverySince = $Now
            $next.RecoveryReason = 'ProxyChanged'
        }
        else {
            $next.Status = 'Healthy'
            $next.RecoveryReason = $null
        }
    }
    elseif ($next.Status -eq 'Outage') {
        $next.Status = 'RecoveryPending'
        $next.PendingProxyUri = $ProxyUri
        $next.RecoverySince = $Now
        if ($proxyChanged) {
            $next.RecoveryReason = 'ProxyChanged'
        }
        elseif ([string]::IsNullOrWhiteSpace([string]$next.RecoveryReason)) {
            $next.RecoveryReason = 'LongOutage'
        }
    }
    elseif ($next.Status -eq 'Healthy' -and $proxyChanged) {
        $next.Status = 'RecoveryPending'
        $next.PendingProxyUri = $ProxyUri
        $next.RecoverySince = $Now
        $next.RecoveryReason = 'ProxyChanged'
    }
    elseif ($next.Status -eq 'RecoveryPending') {
        if ($ProxyUri -ine $next.PendingProxyUri) {
            if ($ProxyUri -ieq $next.ActiveProxyUri -and $next.RecoveryReason -eq 'ProxyChanged' -and
                $null -eq $next.FailureSince) {
                $next.Status = 'Healthy'
                $next.PendingProxyUri = $null
                $next.RecoverySince = $null
                $next.RecoveryReason = $null
            }
            else {
                $next.PendingProxyUri = $ProxyUri
                $next.RecoverySince = $Now
                if ($ProxyUri -ine $next.ActiveProxyUri) {
                    $next.RecoveryReason = 'ProxyChanged'
                }
                else { $next.RecoveryReason = 'LongOutage' }
            }
        }
        elseif ($null -ne $next.RecoverySince -and
            ($Now - [datetime]$next.RecoverySince).TotalSeconds -ge $RecoverySeconds) {
            $next.Status = 'RecoveryEvaluationRequested'
            $action = 'EvaluateRecovery'
        }
    }
    elseif ($next.Status -eq 'RecoveryEvaluationRequested' -and
        $ProxyUri -ine $next.PendingProxyUri) {
        if ($ProxyUri -ieq $next.ActiveProxyUri -and $null -eq $next.FailureSince) {
            $next.Status = 'Healthy'
            $next.PendingProxyUri = $null
            $next.RecoverySince = $null
            $next.RecoveryReason = $null
        }
        else {
            $next.Status = 'RecoveryPending'
            $next.PendingProxyUri = $ProxyUri
            $next.RecoverySince = $Now
            $next.RecoveryReason = if ($ProxyUri -ine $next.ActiveProxyUri) { 'ProxyChanged' } else { 'LongOutage' }
        }
    }

    [pscustomobject]@{ State = $next; Action = $action }
}

function Complete-ConnectionRecovery {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)][string]$ProxyUri,
        [Parameter(Mandatory = $true)][datetime]$Now
    )

    $next = Copy-ConnectionWatchState -State $State
    $next.Status = 'Healthy'
    $next.ActiveProxyUri = $ProxyUri
    $next.PendingProxyUri = $null
    $next.FailureSince = $null
    $next.RecoverySince = $null
    $next.RecoveryReason = $null
    $next.LastRecoveryAt = $Now
    $next
}

function Get-DescendantProcessIds {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][object[]]$Processes,
        [Parameter(Mandatory = $true)][int]$RootProcessId
    )

    $known = @{ $RootProcessId = $true }
    $descendants = @()
    $changed = $true
    while ($changed) {
        $changed = $false
        foreach ($process in $Processes) {
            $processId = [int]$process.ProcessId
            $parentProcessId = [int]$process.ParentProcessId
            if (-not $known.ContainsKey($processId) -and $known.ContainsKey($parentProcessId)) {
                $known[$processId] = $true
                $descendants += $processId
                $changed = $true
            }
        }
    }
    $descendants
}

function Get-CodexConnectionTargets {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][object[]]$Processes,
        [Parameter(Mandatory = $true)][int]$RootProcessId
    )

    $descendantSet = @{}
    foreach ($processId in @(Get-DescendantProcessIds -Processes $Processes -RootProcessId $RootProcessId)) {
        $descendantSet[[int]$processId] = $true
    }

    @($Processes | Where-Object {
        $processId = [int]$_.ProcessId
        if (-not $descendantSet.ContainsKey($processId)) { return $false }

        $name = ([string]$_.Name).ToLowerInvariant()
        if ($name -eq 'codex.exe' -and
            ([string]$_.CommandLine) -match '(?i)(?:^|\s)app-server(?:\s|$)') { return $true }
        if ($name -eq 'chatgpt.exe' -and
            ([string]$_.CommandLine) -match 'network\.mojom\.NetworkService') { return $true }
        return $false
    })
}

function Get-ProxyInternetStatus {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$ProxyUri,
        [int]$TimeoutMilliseconds = 5000,
        [string]$ProbeUri = 'https://chatgpt.com/favicon.ico'
    )

    if ($TimeoutMilliseconds -lt 100) { throw 'TimeoutMilliseconds must be at least 100.' }

    # 只保留分类、主机名和错误代码，不把查询参数、代理凭据或响应正文写入日志。
    $result = [pscustomobject][ordered]@{
        Reachable = $false
        Kind = 'InvalidProxy'
        HttpStatus = $null
        ElapsedMilliseconds = 0L
        TargetHost = $null
        ErrorType = $null
        SocketErrorCode = $null
    }
    $proxy = $null
    if (-not [Uri]::TryCreate($ProxyUri, [UriKind]::Absolute, [ref]$proxy)) { return $result }
    if ($proxy.Scheme -notin @('http', 'https')) { return $result }
    $target = $null
    if (-not [Uri]::TryCreate($ProbeUri, [UriKind]::Absolute, [ref]$target) -or
        $target.Scheme -notin @('http', 'https')) {
        $result.Kind = 'InvalidTarget'
        return $result
    }
    $result.TargetHost = $target.Host

    Add-Type -AssemblyName System.Net.Http
    $handler = [System.Net.Http.HttpClientHandler]::new()
    $client = $null
    $request = $null
    $response = $null
    $timer = [Diagnostics.Stopwatch]::StartNew()
    try {
        $handler.Proxy = [System.Net.WebProxy]::new($proxy)
        $handler.UseProxy = $true
        $handler.AllowAutoRedirect = $false
        $client = [System.Net.Http.HttpClient]::new($handler)
        $client.Timeout = [TimeSpan]::FromMilliseconds($TimeoutMilliseconds)
        $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Head, $target)
        $response = $client.SendAsync($request, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
        $result.HttpStatus = [int]$response.StatusCode
        $result.Reachable = $true
        $result.Kind = 'HttpResponse'
        if ($result.HttpStatus -eq 407) {
            $result.Kind = 'ProxyAuthenticationRequired'
            $result.Reachable = $false
        }
        elseif ($result.HttpStatus -eq 429) { $result.Kind = 'RateLimited' }
        elseif ($result.HttpStatus -ge 500) { $result.Kind = 'ServerError' }
        elseif ($result.HttpStatus -ge 400) { $result.Kind = 'HttpRestricted' }
        # 403、429、5xx 都证明收到了 HTTP 响应，但不证明模型服务或任务正常。
    }
    catch {
        $result.Kind = 'RequestFailure'
        $errorKind = $null
        $timedOut = $false
        $tlsFailure = $false
        $connectionFailure = $false
        $proxyResponseStatus = $null
        $exception = $_.Exception
        while ($null -ne $exception) {
            $result.ErrorType = $exception.GetType().FullName
            if ($exception -is [OperationCanceledException]) { $timedOut = $true }
            if ($exception -is [System.Security.Authentication.AuthenticationException]) { $tlsFailure = $true }
            if ($exception -is [IO.IOException]) { $connectionFailure = $true }
            if ($exception -is [System.Net.Sockets.SocketException]) {
                $result.SocketErrorCode = $exception.NativeErrorCode
                $connectionFailure = $true
            }
            if ($exception -is [System.Net.Http.HttpRequestException] -and
                $null -ne $exception.PSObject.Properties['HttpRequestError']) {
                $errorKind = [string]$exception.HttpRequestError
                if ($null -ne $exception.StatusCode) { $proxyResponseStatus = [int]$exception.StatusCode }
            }
            $exception = $exception.InnerException
        }
        if ($errorKind -eq 'ProxyTunnelError' -and $null -ne $proxyResponseStatus) {
            # CONNECT 拒绝来自代理，不代表已经收到 OpenAI 响应，也不是节点传输硬故障。
            $result.HttpStatus = $proxyResponseStatus
            if ($proxyResponseStatus -eq 407) { $result.Kind = 'ProxyAuthenticationRequired' }
            elseif ($proxyResponseStatus -eq 429) { $result.Kind = 'ProxyRateLimited' }
            elseif ($proxyResponseStatus -ge 500) { $result.Kind = 'ProxyServerError' }
            else { $result.Kind = 'ProxyHttpRestricted' }
        }
        elseif ($timedOut) { $result.Kind = 'Timeout' }
        elseif ($tlsFailure -or $errorKind -eq 'SecureConnectionError') { $result.Kind = 'TlsFailure' }
        elseif ($errorKind -eq 'NameResolutionError') { $result.Kind = 'NameResolutionFailure' }
        elseif ($errorKind -eq 'ProxyTunnelError') { $result.Kind = 'ProxyTunnelRejected' }
        elseif ($errorKind -eq 'ConnectionError' -or $connectionFailure) { $result.Kind = 'ConnectionFailure' }
        elseif ($errorKind -in @('HttpProtocolError', 'InvalidResponse', 'ResponseEnded')) { $result.Kind = 'ResponseFailure' }
    }
    finally {
        $timer.Stop()
        $result.ElapsedMilliseconds = $timer.ElapsedMilliseconds
        if ($response) { $response.Dispose() }
        if ($request) { $request.Dispose() }
        if ($client) { $client.Dispose() } else { $handler.Dispose() }
    }
    $result
}

function Test-ProxyInternet {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$ProxyUri,
        [int]$TimeoutMilliseconds = 5000,
        [string]$ProbeUri = 'https://chatgpt.com/favicon.ico'
    )

    # 保留旧调用方需要的布尔接口；新监视器使用完整诊断结果。
    (Get-ProxyInternetStatus @PSBoundParameters).Reachable
}

function Get-ConnectionProbeIntervalSeconds {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet('Healthy', 'Suspect', 'Outage', 'RecoveryPending', 'RecoveryEvaluationRequested')]
        [string]$Status,
        [ValidateRange(1, 3600)][int]$PollSeconds = 3
    )

    $interval = switch ($Status) {
        'Healthy' { 30 }
        'Outage' { 30 }
        'RecoveryEvaluationRequested' { 30 }
        'Suspect' { 10 }
        default { $PollSeconds }
    }
    [Math]::Max($PollSeconds, $interval)
}

function Get-CodexProxyConnectionStatus {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][int[]]$ProcessIds,
        [Parameter(Mandatory = $true)][string]$ProxyUri
    )

    $result = [pscustomobject]@{ Known = $false; Connected = $false }
    if ($ProcessIds.Count -eq 0) { return $result }
    $proxy = $null
    if (-not [Uri]::TryCreate($ProxyUri, [UriKind]::Absolute, [ref]$proxy)) { return $result }
    if ($proxy.DnsSafeHost -notin @('127.0.0.1', 'localhost', '::1')) { return $result }
    if (-not (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue)) { return $result }

    try {
        $result.Connected = @(
            Get-NetTCPConnection -State Established -ErrorAction Stop | Where-Object {
                $_.OwningProcess -in $ProcessIds -and
                [int]$_.RemotePort -eq $proxy.Port -and
                $_.RemoteAddress -in @('127.0.0.1', '::1')
            }
        ).Count -gt 0
        $result.Known = $true
    }
    catch { }
    $result
}

function Test-CodexProxyConnection {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][int[]]$ProcessIds,
        [Parameter(Mandatory = $true)][string]$ProxyUri
    )

    (Get-CodexProxyConnectionStatus @PSBoundParameters).Connected
}

Export-ModuleMember -Function New-ConnectionWatchState, Update-ConnectionWatchState, Complete-ConnectionRecovery, Get-DescendantProcessIds, Get-CodexConnectionTargets, Get-ProxyInternetStatus, Test-ProxyInternet, Get-ConnectionProbeIntervalSeconds, Get-CodexProxyConnectionStatus, Test-CodexProxyConnection
