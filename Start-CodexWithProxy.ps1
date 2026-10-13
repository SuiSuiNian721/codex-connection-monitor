[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$NoWatchdog,
    [string]$ProxyServerOverride,
    [string]$CodexExecutableOverride
)

$ErrorActionPreference = 'Stop'
$launcherPath = $MyInvocation.MyCommand.Path
$scriptRoot = Split-Path -Parent $launcherPath
$logPath = Join-Path $scriptRoot 'launcher.log'
Import-Module (Join-Path $scriptRoot 'CodexProxyLauncher.psm1') -Force
Import-Module (Join-Path $scriptRoot 'CuaRuntime.psm1') -Force
Import-Module (Join-Path $scriptRoot 'CodexStartup.psm1') -Force
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

function Request-CodexWindowActivation {
    param([object[]]$Processes)
    if (-not [string]::IsNullOrWhiteSpace($env:CODEX_ELECTRON_USER_DATA_PATH)) {
        throw '检测到独立的 Codex 配置目录，请从该会话原来的入口唤起窗口；未另开应用。'
    }
    # 单实例锁按桌面配置隔离；同名程序和安装路径相同都不足以确认是同一会话。
    $roots = @()
    foreach ($process in @($Processes)) {
        try {
            $processId = [int]$process.Id
            $executable = [IO.Path]::GetFullPath([string]$process.Path)
            if ($processId -le 0 -or $executable -notmatch '\\WindowsApps\\OpenAI\.Codex_[^\\]+\\app\\(?:ChatGPT|Codex)\.exe$') { throw 'Unverified executable.' }
            $records = @(Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $processId" -ErrorAction Stop)
            if ($records.Count -ne 1) { throw 'Process identity unavailable.' }
            $record = $records[0]
            if ([int]$record.ProcessId -ne $processId -or -not $record.ExecutablePath -or
                [IO.Path]::GetFullPath([string]$record.ExecutablePath) -ine $executable -or
                $null -eq $process.StartTime -or $null -eq $record.CreationDate -or
                [math]::Abs((([datetime]$record.CreationDate).ToUniversalTime() - ([datetime]$process.StartTime).ToUniversalTime()).TotalMilliseconds) -gt 1 -or
                [string]::IsNullOrWhiteSpace([string]$record.CommandLine)) { throw 'Process identity changed or unreadable.' }
        }
        catch {
            throw '无法核对后台 Codex 的进程身份，请从该会话原来的入口唤起窗口；未另开应用。'
        }
        $commandLine = [string]$record.CommandLine
        if ($commandLine -match '(?:^|\s|")--type(?:=|\s|"|$)') { continue }
        if ($commandLine -match '(?:^|\s|")--user-data-dir(?:=|\s|"|$)') {
            throw '检测到 Codex 使用独立配置，请从该会话原来的入口唤起窗口；未另开应用。'
        }
        $roots += $executable
    }
    if ($roots.Count -ne 1) {
        throw '无法确认唯一的后台 Codex 主进程，请从该会话原来的入口唤起窗口；未另开应用。'
    }
    $executable = $roots[0]
    Write-Host '检测到 Codex 留在后台，正在请求显示已有窗口……'
    # 商店版将无参数的第二次打开交给已有实例处理，第二个进程会自行退出。
    Start-Process -FilePath $executable -WorkingDirectory (Split-Path $executable -Parent) | Out-Null
    Write-LauncherLog 'Requested native activation of the existing Codex window.'
}

function Confirm-CodexWindowReady {
    param([object]$Result)
    if ($Result.Status -eq 'Ready') { return $Result.Process }
    Write-LauncherLog "Codex window not ready. Status=$($Result.Status) PID(s)=$($Result.ProcessIds -join ',') Seconds=$($Result.ElapsedSeconds)" 'WARN'
    if ($Result.Status -eq 'TimedOut') {
        throw "已等待 $($Result.ElapsedSeconds) 秒，Codex 仍有后台进程，但没有可用窗口（PID：$($Result.ProcessIds -join ',')）。本次启动未完成，后台进程已保留；详细记录见 launcher.log。"
    }
    throw '等待窗口时 Codex 进程已经退出，本次启动未完成；详细记录见 launcher.log。'
}

function Get-CodexStartupBackgroundRoot {
    param(
        [Parameter(Mandatory = $true)][string]$CodexExecutable,
        [Parameter(Mandatory = $true)][datetime]$LaunchStartedAt,
        [Parameter(Mandatory = $true)][string]$ProxyUri
    )
    $expectedPath = [IO.Path]::GetFullPath($CodexExecutable)
    $earliestStart = $LaunchStartedAt.ToUniversalTime().AddMilliseconds(-1)
    $proxyArgument = [regex]::Escape('--proxy-server=' + $ProxyUri)
    $proxyPattern = '(?:^|\s)(?:' + $proxyArgument + '|"' + $proxyArgument + '")(?=\s|$)'
    $candidates = @(foreach ($candidate in @(Get-RunningCodexProcesses -ExecutablePath $CodexExecutable)) {
        try {
            if ($candidate.PSObject.Methods['Refresh']) { $candidate.Refresh() }
            if ($candidate.HasExited -or -not $candidate.Path -or
                [IO.Path]::GetFullPath($candidate.Path) -ine $expectedPath) { continue }
            $startedAt = $candidate.StartTime.ToUniversalTime()
            if ($startedAt -lt $earliestStart) { continue }
            $records = @(Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $($candidate.Id)" -ErrorAction Stop)
            if ($records.Count -ne 1) { continue }
            $record = $records[0]
            if ($record.ProcessId -ne $candidate.Id -or -not $record.ExecutablePath -or
                [IO.Path]::GetFullPath($record.ExecutablePath) -ine $expectedPath -or -not $record.CreationDate) { continue }
            # CIM 的创建时间精度可能低于 Process；仅容许不足 1 ms 的表示差。
            if ([math]::Abs(($record.CreationDate.ToUniversalTime() - $startedAt).TotalMilliseconds) -ge 1) { continue }
            if ([string]::IsNullOrWhiteSpace($record.CommandLine) -or
                $record.CommandLine -match '(?:^|\s)["'']?--(?:type|user-data-dir)(?:=|\s|["'']|$)') { continue }
            # 只接受本次固定代理入口，防止等待期间从其他入口新开的实例被绑定。
            if ($record.CommandLine -notmatch $proxyPattern -or
                [regex]::Matches($record.CommandLine, '(?:^|\s)"?--proxy-server(?:=|\s|"|$)').Count -ne 1) { continue }
            $candidate
        }
        catch { } # 身份无法核对或正好退出时，保留进程但不建立监测绑定。
    })
    if ($candidates.Count -eq 1) { return $candidates[0] }
    return $null
}

function Complete-CodexStartup {
    param(
        [Parameter(Mandatory = $true)][object]$StartupWindow,
        [Parameter(Mandatory = $true)][string]$CodexExecutable,
        [Parameter(Mandatory = $true)][datetime]$LaunchStartedAt,
        [Parameter(Mandatory = $true)][string]$ProxyUri,
        [ValidateSet('System', 'Explicit')][string]$ProxyMode = 'System',
        [switch]$NoWatchdog
    )
    $rootProcess = $null
    if ($StartupWindow.Status -eq 'Ready') {
        $rootProcess = $StartupWindow.Process
        Write-LauncherLog "Codex window ready with proxy. RootPID=$($rootProcess.Id)"
    }
    elseif ($StartupWindow.Status -eq 'TimedOut') {
        $rootProcess = Get-CodexStartupBackgroundRoot -CodexExecutable $CodexExecutable -LaunchStartedAt $LaunchStartedAt -ProxyUri $ProxyUri
        if (-not $rootProcess) {
            Write-LauncherLog '无法确认本次启动的后台主进程，未绑定新的监测；已有进程已保留。' 'WARN'
        }
    }
    if ($rootProcess -and -not $NoWatchdog) {
        Start-ConnectionWatchdog -RootProcessId $rootProcess.Id -CodexExecutable $CodexExecutable -ProxyUri $ProxyUri -ProxyMode $ProxyMode
        Write-LauncherLog "Connection watchdog started. RootPID=$($rootProcess.Id)"
        if ($StartupWindow.Status -eq 'TimedOut') {
            Write-Host '窗口尚未出现，已为确认属于本次启动的后台主进程保留连接监测。'
        }
    }
    Confirm-CodexWindowReady -Result $StartupWindow
}

function Start-ConnectionWatchdog {
    param(
        [Parameter(Mandatory = $true)][int]$RootProcessId,
        [Parameter(Mandatory = $true)][string]$CodexExecutable,
        [Parameter(Mandatory = $true)][string]$ProxyUri,
        [ValidateSet('System', 'Explicit')][string]$ProxyMode = 'System'
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
        Write-Host 'DryRun: preflight checks passed; no process was stopped or started.'
        exit 0
    }

    $mutexKey = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($scriptRoot.ToLowerInvariant()))).Substring(0, 24)
    $launchMutex = [Threading.Mutex]::new($false, "Local\CodexProxyLauncher-$mutexKey")
    try { $ownsLaunchMutex = $launchMutex.WaitOne(0) }
    catch [Threading.AbandonedMutexException] { $ownsLaunchMutex = $true }
    if (-not $ownsLaunchMutex) { throw '另一个启动器正在准备或启动 Codex，请稍候；无需重复点击。' }
    $windowProgress = {
        param($progress)
        Write-Host "正在等待 Codex 窗口，已用 $($progress.ElapsedSeconds) 秒……"
    }
    $existingProcesses = @(Get-RunningCodexProcesses -ExecutablePath $codexExecutable -IncludeOtherVersions)
    if ($existingProcesses.Count -gt 0) {
        $existingWindow = Open-CodexExistingWindow -GetProcesses {
            Get-RunningCodexProcesses -ExecutablePath $codexExecutable -IncludeOtherVersions
        } -RequestActivation { Request-CodexWindowActivation -Processes $existingProcesses } -OnProgress $windowProgress
        $null = Confirm-CodexWindowReady -Result $existingWindow
        Write-Host 'Codex 已经运行，窗口已打开。若要应用新的代理，请先保存工作并正常退出 Codex。'
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
    $existingProcesses = @(Get-RunningCodexProcesses -ExecutablePath $codexExecutable -IncludeOtherVersions)
    if ($existingProcesses.Count -gt 0) {
        $existingWindow = Open-CodexExistingWindow -GetProcesses {
            Get-RunningCodexProcesses -ExecutablePath $codexExecutable -IncludeOtherVersions
        } -RequestActivation { Request-CodexWindowActivation -Processes $existingProcesses } -OnProgress $windowProgress
        $null = Confirm-CodexWindowReady -Result $existingWindow
        Write-Host '运行环境已准备好，Codex 已由其他入口打开，窗口已显示。'
        exit 0
    }

    foreach ($name in @('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy')) {
        Set-Item -Path "Env:$name" -Value $proxyUri
    }
    foreach ($name in @('NO_PROXY', 'no_proxy')) {
        Set-Item -Path "Env:$name" -Value 'localhost,127.0.0.1,::1'
    }

    Set-Item -Path 'Env:CODEX_CLI_PATH' -Value $runtimeCli

    $launchStartedAt = [datetime]::UtcNow
    $started = Start-Process -FilePath $codexExecutable -ArgumentList "--proxy-server=$proxyUri" -WorkingDirectory (Split-Path $codexExecutable -Parent) -PassThru
    $startupWindow = Wait-CodexWindow -GetProcesses {
        Get-RunningCodexProcesses -ExecutablePath $codexExecutable
    } -OnProgress $windowProgress
    $rootProcess = Complete-CodexStartup -StartupWindow $startupWindow -CodexExecutable $codexExecutable `
        -LaunchStartedAt $launchStartedAt -ProxyUri $proxyUri -ProxyMode $proxyMode -NoWatchdog:$NoWatchdog
    Write-Host 'Codex 窗口已打开，正在使用当前代理。'
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
