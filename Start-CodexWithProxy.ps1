[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$NoWatchdog,
    [switch]$NoPerformanceMonitor,
    [string]$ProxyServerOverride,
    [string]$CodexExecutableOverride
)

$ErrorActionPreference = 'Stop'
$launcherPath = $MyInvocation.MyCommand.Path
$scriptRoot = Split-Path -Parent $launcherPath
$logPath = Join-Path $scriptRoot 'launcher.log'
Import-Module (Join-Path $scriptRoot 'CodexProxyLauncher.psm1') -Force
Import-Module (Join-Path $scriptRoot 'CuaRuntime.psm1') -Force
Import-Module (Join-Path $scriptRoot 'CodexProxyRelay.psm1') -Force
$launchMutex = $null
$ownsLaunchMutex = $false

function Write-LauncherLog {
    param([string]$Message, [string]$Level = 'INFO')
    $line = '{0} [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message
    try {
        if ((Test-Path -LiteralPath $logPath) -and (Get-Item -LiteralPath $logPath).Length -ge 1MB) {
            Move-Item -LiteralPath $logPath -Destination ($logPath + '.1') -Force
        }
        Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
    }
    catch { Write-Warning "无法写入启动日志：$($_.Exception.Message)" }
}

function Get-RunningCodexProcesses {
    param([string]$ExecutablePath, [switch]$IncludeOtherVersions)
    $expected = [IO.Path]::GetFullPath($ExecutablePath)
    $processName = [IO.Path]::GetFileNameWithoutExtension($ExecutablePath)
    $names = if ($IncludeOtherVersions) { @($processName, 'ChatGPT', 'Codex') | Select-Object -Unique } else { @($processName) }
    @(Get-Process -Name $names -ErrorAction SilentlyContinue | Where-Object {
        try {
            $_.Path -and (([IO.Path]::GetFullPath($_.Path) -ieq $expected) -or
                ($IncludeOtherVersions -and $_.Path -match '\\WindowsApps\\OpenAI\.Codex_[^\\]+\\app\\(?:ChatGPT|Codex)\.exe$'))
        }
        catch { $false }
    })
}

function Initialize-GenerationCollection {
    param([string]$RealCliPath, [switch]$Disabled)

    # 仅设置本次启动进程的环境，不修改系统或用户环境变量。
    foreach ($name in @('CODEX_GENERATION_NODE', 'CODEX_GENERATION_SCRIPT', 'CODEX_GENERATION_REAL_CLI',
            'CODEX_GENERATION_STATE_DIR', 'CODEX_GENERATION_LAUNCH_ID', 'CODEX_GENERATION_HOME_KEY')) {
        Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
    }
    Set-Item -LiteralPath 'Env:CODEX_CLI_PATH' -Value $RealCliPath
    if ($Disabled) { return $null }
    try {
        Import-Module (Join-Path $scriptRoot 'GenerationBridge.psm1') -Force
        $generationHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
        $configuration = Get-CodexGenerationConfiguration -RealCliPath $RealCliPath -CodexHome $generationHome -ProjectRoot $scriptRoot
        Set-Item -LiteralPath 'Env:CODEX_GENERATION_NODE' -Value $configuration.NodeExecutable
        Set-Item -LiteralPath 'Env:CODEX_GENERATION_SCRIPT' -Value $configuration.ScriptPath
        Set-Item -LiteralPath 'Env:CODEX_GENERATION_REAL_CLI' -Value $configuration.RealCliPath
        Set-Item -LiteralPath 'Env:CODEX_GENERATION_STATE_DIR' -Value $configuration.StateDirectory
        Set-Item -LiteralPath 'Env:CODEX_GENERATION_LAUNCH_ID' -Value $configuration.LaunchId
        Set-Item -LiteralPath 'Env:CODEX_GENERATION_HOME_KEY' -Value $configuration.HomeKey
        Set-Item -LiteralPath 'Env:CODEX_CLI_PATH' -Value $configuration.ForwarderPath
        return $configuration
    }
    catch {
        foreach ($name in @('CODEX_GENERATION_NODE', 'CODEX_GENERATION_SCRIPT', 'CODEX_GENERATION_REAL_CLI',
                'CODEX_GENERATION_STATE_DIR', 'CODEX_GENERATION_LAUNCH_ID', 'CODEX_GENERATION_HOME_KEY')) {
            Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
        }
        Set-Item -LiteralPath 'Env:CODEX_CLI_PATH' -Value $RealCliPath
        Write-LauncherLog '实时输出采集准备失败；使用原 CLI 继续启动，完成后的消息均速仍可查看。' 'WARN'
        return $null
    }
}

function Start-ConnectionWatchdog {
    param(
        [Parameter(Mandatory = $true)][int]$RootProcessId,
        [Parameter(Mandatory = $true)][string]$CodexExecutable,
        [Parameter(Mandatory = $true)][string]$ProxyUri,
        [ValidateSet('System', 'Explicit')][string]$ProxyMode = 'System',
        [string]$RelayStatePath
    )

    $watchdogPath = Join-Path $scriptRoot 'Watch-CodexConnection.ps1'
    if (-not (Test-Path -LiteralPath $watchdogPath -PathType Leaf)) {
        throw "连接监视器不存在：$watchdogPath"
    }

    $powershell = (Get-Command pwsh.exe -ErrorAction Stop).Source
    $arguments = @(
        '-NoProfile',
        '-WindowStyle', 'Hidden',
        '-ExecutionPolicy', 'Bypass',
        '-File', ('"{0}"' -f $watchdogPath),
        '-RootProcessId', $RootProcessId,
        '-CodexExecutable', ('"{0}"' -f $CodexExecutable),
        '-InitialProxyUri', $ProxyUri,
        '-ProxyMode', $ProxyMode
    )
    if ($RelayStatePath) { $arguments += @('-RelayStatePath', ('"{0}"' -f $RelayStatePath)) }
    Start-Process -FilePath $powershell -ArgumentList $arguments -WindowStyle Hidden | Out-Null
}

try {
    if ($ProxyServerOverride) {
        $proxyServer = $ProxyServerOverride
    }
    else {
        $settings = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
        if ([int]$settings.ProxyEnable -ne 1) {
            throw 'Windows 系统代理未启用。请先在代理客户端中开启“系统代理”，不需要开启 TUN。'
        }
        $proxyServer = [string]$settings.ProxyServer
    }

    $proxyUri = ConvertTo-ProxyUri -ProxyServer $proxyServer
    if (-not $proxyUri) {
        throw '无法识别系统代理地址，请使用不含账号密码的本机 HTTP/HTTPS 代理端口。'
    }
    if (([uri]$proxyUri).Scheme -notin @('http', 'https')) {
        throw '连接监视器需要本机 HTTP/HTTPS 代理，请使用代理客户端的 HTTP 或 mixed 端口。'
    }
    if (-not (Test-LocalProxy -ProxyUri $proxyUri)) {
        throw "代理端口没有响应：$proxyUri。请先启动代理客户端。"
    }

    if ($CodexExecutableOverride) {
        $codexExecutable = $CodexExecutableOverride
    }
    else {
        $codexExecutable = Find-CodexExecutable
    }
    if (-not $codexExecutable -or -not (Test-Path -LiteralPath $codexExecutable -PathType Leaf)) {
        throw '未找到 Codex 桌面端。请确认 Codex 已通过 Microsoft Store 正确安装。'
    }

    Write-Host "Proxy : $proxyUri"
    Write-Host "Codex : $codexExecutable"

    $proxyMode = if ($ProxyServerOverride) { 'Explicit' } else { 'System' }
    if ($DryRun) {
        $relayPreview = Start-CodexProxyRelay -ProxyMode $proxyMode -InitialProxyUri $proxyUri -DryRun
        Write-Host "Relay : $($relayPreview.StatePath)（预检，不启动）"
        Write-Host 'DryRun: preflight checks passed; no process was stopped or started.'
        exit 0
    }

    $mutexKey = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($scriptRoot.ToLowerInvariant()))).Substring(0, 24)
    $launchMutex = [Threading.Mutex]::new($false, "Local\CodexProxyLauncher-$mutexKey")
    try { $ownsLaunchMutex = $launchMutex.WaitOne(0) }
    catch [Threading.AbandonedMutexException] { $ownsLaunchMutex = $true }
    if (-not $ownsLaunchMutex) { throw '另一个启动器正在准备或启动 Codex，请稍候；无需重复点击。' }
    if (@(Get-RunningCodexProcesses -ExecutablePath $codexExecutable -IncludeOtherVersions).Count -gt 0) {
        $existingRelay = Restore-CodexProxyRelay -CodexExecutable $codexExecutable -ProxyMode $proxyMode -InitialProxyUri $proxyUri
        if ($existingRelay) {
            Write-Host "Codex 已经运行，固定入口 $($existingRelay.ClientProxyUri) 已就绪；本次未重新启动 Codex。"
            Write-LauncherLog "Existing Codex relay checked. ClientProxy=$($existingRelay.ClientProxyUri) RelayPID=$($existingRelay.ProcessId)"
        }
        else {
            Write-Host 'Codex 已经运行，本次未重新启动。此旧会话未使用固定入口，正常退出后再通过本启动器打开即可应用修复。'
        }
        Write-LauncherLog 'Codex is already running; duplicate launch skipped.'
        exit 0
    }

    Write-Host '正在检查运行环境缓存；更新后的首次准备会显示进度，请勿重复点击启动器。'
    Write-LauncherLog 'CUA runtime preparation started.'
    $progressState = @{ LastReportedSeconds = -5 }
    try {
        $cuaRuntime = Sync-CodexCuaRuntime -CodexExecutable $codexExecutable -OnProgress {
            param($progress)
            $percent = if ($progress.TotalFiles -gt 0) { [int](100 * $progress.CompletedFiles / $progress.TotalFiles) } else { 100 }
            Write-Progress -Activity '准备 GPT 运行环境' -Status "$($progress.CompletedFiles)/$($progress.TotalFiles) 个文件" -PercentComplete $percent
            if ($progress.ElapsedSeconds - $progressState.LastReportedSeconds -ge 5) {
                Write-Host "运行环境准备：$($progress.CompletedFiles)/$($progress.TotalFiles) 个文件，已用 $($progress.ElapsedSeconds) 秒。"
                $progressState.LastReportedSeconds = $progress.ElapsedSeconds
            }
        }
    }
    finally { Write-Progress -Activity '准备 GPT 运行环境' -Completed }
    $cacheAction = if ($cuaRuntime.Status -eq 'Reused') { '已校验并复用缓存' } else { '新缓存准备完成' }
    Write-Host "$cacheAction，用时 $($cuaRuntime.ElapsedSeconds) 秒。"
    Write-LauncherLog "CUA runtime ready. Status=$($cuaRuntime.Status) Validation=$($cuaRuntime.Validation) Fingerprint=$($cuaRuntime.Fingerprint) Files=$($cuaRuntime.FileCount) Seconds=$($cuaRuntime.ElapsedSeconds)"

    $runtimeCli = Sync-CodexRuntime -CodexExecutable $codexExecutable
    Write-Host "Runtime: $runtimeCli"
    Write-LauncherLog "Preflight passed. Proxy=$proxyUri Codex=$codexExecutable"
    if (@(Get-RunningCodexProcesses -ExecutablePath $codexExecutable -IncludeOtherVersions).Count -gt 0) {
        Write-Host '运行环境已准备好，但 Codex 已由其他入口打开；本次未重新启动。'
        exit 0
    }

    $relay = Start-CodexProxyRelay -ProxyMode $proxyMode -InitialProxyUri $proxyUri
    $proxyUri = $relay.ClientProxyUri
    Write-Host "客户端固定入口：$proxyUri；VPN 上游：$($relay.UpstreamProxyUri)"
    Write-LauncherLog "Proxy relay ready. ClientProxy=$proxyUri UpstreamProxy=$($relay.UpstreamProxyUri) Mode=$proxyMode RelayPID=$($relay.ProcessId)"

    foreach ($name in @('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy')) {
        Set-Item -Path "Env:$name" -Value $proxyUri
    }
    foreach ($name in @('NO_PROXY', 'no_proxy')) {
        Set-Item -Path "Env:$name" -Value 'localhost,127.0.0.1,::1'
    }

    $generationConfiguration = Initialize-GenerationCollection -RealCliPath $runtimeCli -Disabled:$NoPerformanceMonitor

    $started = Start-Process -FilePath $codexExecutable -ArgumentList "--proxy-server=$proxyUri" -WorkingDirectory (Split-Path $codexExecutable -Parent) -PassThru
    $startupDeadline = (Get-Date).AddSeconds(20)
    do {
        Start-Sleep -Milliseconds 500
        $running = @(Get-RunningCodexProcesses -ExecutablePath $codexExecutable)
    } while ($running.Count -eq 0 -and (Get-Date) -lt $startupDeadline)
    if ($running.Count -eq 0) {
        throw "Codex 启动后未检测到运行进程（初始 PID：$($started.Id)）。"
    }

    $rootProcess = $running | Where-Object Id -eq $started.Id | Select-Object -First 1
    if (-not $rootProcess) {
        $rootProcess = @($running | Sort-Object @{ Expression = { $_.MainWindowHandle -ne 0 }; Descending = $true }, StartTime | Select-Object -First 1)
        if ($rootProcess.Count -gt 0) { $rootProcess = $rootProcess[0] }
    }
    if (-not $rootProcess) {
        throw 'Codex 已启动，但无法确定 GPT 主进程，未创建连接监视器。'
    }

    Write-LauncherLog "Codex started with proxy. PID(s)=$($running.Id -join ',')"
    if ($generationConfiguration) {
        try {
            Register-CodexGenerationBinding -Configuration $generationConfiguration -CodexProcess $rootProcess
            Write-LauncherLog "Realtime output collection bound. RootPID=$($rootProcess.Id)"
        }
        catch {
            Write-LauncherLog '实时输出采集身份注册失败，面板将标明不可核对；Codex 与原连接监测继续运行。' 'WARN'
        }
    }
    if (-not $NoWatchdog) {
        Start-ConnectionWatchdog -RootProcessId $rootProcess.Id -CodexExecutable $codexExecutable -ProxyUri $proxyUri -ProxyMode $proxyMode -RelayStatePath $relay.StatePath
        Write-LauncherLog "Connection watchdog started. RootPID=$($rootProcess.Id)"
    }
    if (-not $NoPerformanceMonitor) {
        try {
            $performanceService = & (Join-Path $scriptRoot 'Start-CodexPerformanceMonitor.ps1')
            Write-LauncherLog "Performance monitor started in background. PID=$($performanceService.ProcessId)"
        }
        catch {
            Write-LauncherLog '性能监测暂未启动；Codex 和原连接监测继续运行，可稍后单独打开性能面板。' 'WARN'
        }
    }
    Write-Host 'Codex 已通过固定本地入口启动；系统代理模式下，新连接会跟随 VPN 上游切换。'
    exit 0
}
catch {
    $message = $_.Exception.Message
    try { Write-LauncherLog $message 'ERROR' } catch { }
    Write-Host "启动失败：$message" -ForegroundColor Red
    exit 1
}
finally {
    if ($ownsLaunchMutex) { $launchMutex.ReleaseMutex() }
    if ($launchMutex) { $launchMutex.Dispose() }
}
