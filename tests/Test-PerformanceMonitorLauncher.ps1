[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$scriptPath = Join-Path $projectRoot 'Start-CodexPerformanceMonitor.ps1'
if (-not (Test-Path -LiteralPath $scriptPath)) { throw '缺少性能监测启动脚本。' }
$tokens = $null
$parseErrors = $null
[void][Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw '性能监测启动脚本存在语法错误。' }

$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('codex-performance-launcher-' + [guid]::NewGuid().ToString('N'))
[void](New-Item -ItemType Directory -Path $fixtureRoot)
$statePath = Join-Path $fixtureRoot 'state'
try {
    $result = & $scriptPath -CodexHome $fixtureRoot -StateDirectory $statePath -DryRun
    if (-not $result.DryRun) { throw 'DryRun 没有返回预检结果。' }
    if ($result.CodexHome -ne [IO.Path]::GetFullPath($fixtureRoot)) { throw 'Codex 数据目录解析错误。' }
    if (Test-Path -LiteralPath $statePath) { throw 'DryRun 不得创建状态目录或启动服务。' }
    if (-not (Test-Path -LiteralPath $result.NodeExecutable -PathType Leaf)) { throw 'Node 路径无效。' }
    $withTrailingSeparator = & $scriptPath -CodexHome ($fixtureRoot + '\') -StateDirectory $statePath -DryRun
    if ($withTrailingSeparator.CodexHome -ne $result.CodexHome) { throw '目录末尾分隔符不得改变后台服务身份。' }

    $source = Get-Content -LiteralPath $scriptPath -Raw -Encoding utf8
    if ($source -notmatch 'WindowStyle\s+Hidden') { throw '后台启动必须隐藏窗口。' }
    if ($source -match 'taskkill|Set-ItemProperty') { throw '监测入口不得批量停止进程或更改系统代理。' }
    $main = Get-Content -LiteralPath (Join-Path $projectRoot 'Start-CodexWithProxy.ps1') -Raw -Encoding utf8
    if ($main -notmatch 'Start-CodexPerformanceMonitor\.ps1') { throw '原启动器尚未接入性能采集。' }
    if ($main -notmatch '\[switch\]\$NoPerformanceMonitor') { throw '原启动器需要可选关闭性能采集。' }

    # 所有进程、健康响应与停止操作都使用合成对象；绝不访问或停止生产进程。
    $script:expectedRevision = '2026.10.06-panel.2'
    $script:fixtureNode = $result.NodeExecutable
    $script:fixtureServer = Join-Path $projectRoot 'performance-monitor\server.mjs'
    $script:fixtureManifestPath = Join-Path $statePath 'service.json'
    $script:fixtureHomeKey = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($fixtureRoot.ToLowerInvariant()))).Substring(0, 24).ToLowerInvariant()
    [void](New-Item -ItemType Directory -Path $statePath)
    function New-LauncherUpgradeCase {
        $script:stops = 0
        $script:starts = 0
        $script:healthReads = 0
        $script:cimReads = 0
        $script:changeHealthBeforeStop = $false
        $script:changeProcessBeforeStop = $false
        $script:healthUnavailable = $false
        $script:fixtureProcessMissing = $false
        $created = [DateTime]::UtcNow.AddSeconds(-3)
        $script:fakeProcess = [pscustomobject]@{ Id=2147440001; Path=$script:fixtureNode; StartTime=$created; HasExited=$false; Handle=17 }
        $script:fakeProcess | Add-Member ScriptMethod Refresh { }
        $script:fakeProcess | Add-Member ScriptMethod WaitForExit { param($Timeout) return $true }
        $script:fakeCim = [pscustomobject]@{
            ProcessId=$script:fakeProcess.Id; ExecutablePath=$script:fixtureNode; CreationDate=$created
            CommandLine=('"{0}" "{1}" --codex-home "{2}" --state-dir "{3}"' -f $script:fixtureNode, $script:fixtureServer, $fixtureRoot, $statePath)
        }
        $script:fakeManifest = [pscustomobject]@{
            version=1; pid=$script:fakeProcess.Id; homeKey=$script:fixtureHomeKey; instanceId=('a' * 32)
            url='http://127.0.0.1:39401/'; port=39401; startedAt=$created.AddSeconds(1).ToString('o')
        }
        $script:fakeHealth = [pscustomobject]@{
            service='codex-performance-monitor'; version=1; pid=$script:fakeManifest.pid; homeKey=$script:fixtureHomeKey
            instanceId=$script:fakeManifest.instanceId; startedAt=$script:fakeManifest.startedAt; ready=$true
        }
        $script:fakeManifest | ConvertTo-Json -Compress | Set-Content -LiteralPath $script:fixtureManifestPath -Encoding utf8
    }
    function Invoke-RestMethod {
        param($Uri, $TimeoutSec, [switch]$NoProxy)
        $script:healthReads++
        if ($Uri -ne ($script:fakeManifest.url + 'api/health') -or -not $NoProxy) { throw '测试外健康请求被拒绝。' }
        if ($script:healthUnavailable) { throw '合成健康端点不可达。' }
        $value = $script:fakeHealth.PSObject.Copy()
        if ($script:changeHealthBeforeStop -and $script:healthReads -ge 2) { $value.instanceId = 'b' * 32 }
        return $value
    }
    function Get-Process {
        param($Id, $ErrorAction)
        if ($Id -ne 2147440001 -or $script:fixtureProcessMissing) { throw '合成进程不存在。' }
        return $script:fakeProcess
    }
    function Get-CimInstance {
        param($ClassName, $Filter, $ErrorAction)
        if ($ClassName -ne 'Win32_Process' -or $Filter -ne 'ProcessId = 2147440001') { throw '测试外进程查询被拒绝。' }
        $script:cimReads++
        $value = $script:fakeCim.PSObject.Copy()
        if ($script:changeProcessBeforeStop -and $script:cimReads -ge 2) { $value.CreationDate = $value.CreationDate.AddMinutes(1) }
        return $value
    }
    function Stop-Process {
        param($InputObject, [switch]$Force, $ErrorAction)
        if (-not [object]::ReferenceEquals($InputObject, $script:fakeProcess) -or $InputObject.Id -ne 2147440001) { throw '停止目标不是本次合成监测进程。' }
        $script:stops++
        $InputObject.HasExited = $true
    }
    function Start-Process {
        param($FilePath, $ArgumentList, $WorkingDirectory, $WindowStyle, [switch]$PassThru, $RedirectStandardOutput, $RedirectStandardError)
        if ($FilePath -ne $script:fixtureNode -or $WorkingDirectory -ne $projectRoot -or $WindowStyle -ne 'Hidden') { throw '后台启动边界不正确。' }
        if ($ArgumentList.Count -ne 5 -or $ArgumentList[1] -ne '--codex-home' -or $ArgumentList[3] -ne '--state-dir') { throw '后台参数发生不必要变化。' }
        $script:starts++
        $script:healthUnavailable = $false
        $script:fakeManifest.pid = 2147440002
        $script:fakeManifest | Add-Member NoteProperty runtimeRevision $script:expectedRevision -Force
        $script:fakeHealth.pid = 2147440002
        $script:fakeHealth | Add-Member NoteProperty runtimeRevision $script:expectedRevision -Force
        $script:fakeManifest | ConvertTo-Json -Compress | Set-Content -LiteralPath $script:fixtureManifestPath -Encoding utf8
        $process = [pscustomobject]@{ HasExited=$false; ExitCode=0 }
        $process | Add-Member ScriptMethod Refresh { }
        return $process
    }
    $checks = [Collections.Generic.List[string]]::new()
    New-LauncherUpgradeCase
    $upgraded = . $scriptPath -CodexHome $fixtureRoot -StateDirectory $statePath
    if ($script:stops -ne 1 -or $script:starts -ne 1 -or $upgraded.ProcessId -ne 2147440002) {
        throw '旧版健康监测被直接复用，没有只替换已核验的独立监测进程。'
    }
    $checks.Add('verified-legacy-replaced-once')
    New-LauncherUpgradeCase
    $script:fakeManifest | Add-Member NoteProperty runtimeRevision $script:expectedRevision
    $script:fakeHealth | Add-Member NoteProperty runtimeRevision $script:expectedRevision
    $script:fakeManifest | ConvertTo-Json -Compress | Set-Content -LiteralPath $script:fixtureManifestPath -Encoding utf8
    $reused = . $scriptPath -CodexHome $fixtureRoot -StateDirectory $statePath
    if ($script:stops -ne 0 -or $script:starts -ne 0 -or $reused.ProcessId -ne 2147440001) { throw '当前版本没有直接复用。' }
    $checks.Add('current-revision-reused-without-process-change')
    $negativeCases = @(
        @{ Name='health-pid'; Mutate={ $script:fakeHealth.pid++ } },
        @{ Name='health-home'; Mutate={ $script:fakeHealth.homeKey = 'b' * 24 } },
        @{ Name='health-instance'; Mutate={ $script:fakeHealth.instanceId = 'b' * 32 } },
        @{ Name='health-start'; Mutate={ $script:fakeHealth.startedAt = [DateTime]::UtcNow.ToString('o') } },
        @{ Name='unknown-revision'; Mutate={ $script:fakeManifest | Add-Member NoteProperty runtimeRevision '2099.01.01-panel.1'; $script:fakeHealth | Add-Member NoteProperty runtimeRevision '2099.01.01-panel.1' } },
        @{ Name='revision-mismatch'; Mutate={ $script:fakeHealth | Add-Member NoteProperty runtimeRevision $script:expectedRevision } },
        @{ Name='wrong-node'; Mutate={ $script:fakeCim.ExecutablePath = Join-Path $fixtureRoot 'other.exe' } },
        @{ Name='other-installation'; Mutate={ $script:fakeCim.CommandLine = $script:fakeCim.CommandLine.Replace($script:fixtureServer, (Join-Path $fixtureRoot 'other\server.mjs')) } },
        @{ Name='wrong-home-argument'; Mutate={ $script:fakeCim.CommandLine = $script:fakeCim.CommandLine.Replace(('"' + $fixtureRoot + '"'), ('"' + (Join-Path $fixtureRoot 'other-home') + '"')) } },
        @{ Name='wrong-state-argument'; Mutate={ $script:fakeCim.CommandLine = $script:fakeCim.CommandLine.Replace($statePath, (Join-Path $fixtureRoot 'other-state')) } },
        @{ Name='node-eval'; Mutate={ $script:fakeCim.CommandLine = '"' + $script:fixtureNode + '" --eval "ignored server.mjs"' } },
        @{ Name='duplicate-argument'; Mutate={ $script:fakeCim.CommandLine += ' --codex-home "' + $fixtureRoot + '"' } },
        @{ Name='creation-mismatch'; Mutate={ $script:fakeCim.CreationDate = $script:fakeCim.CreationDate.AddMinutes(1) } },
        @{ Name='service-before-process'; Mutate={ $script:fakeProcess.StartTime = $script:fakeProcess.StartTime.AddMinutes(1); $script:fakeCim.CreationDate = $script:fakeProcess.StartTime } },
        @{ Name='health-unavailable'; Mutate={ $script:healthUnavailable = $true } },
        @{ Name='health-changed-before-stop'; Mutate={ $script:changeHealthBeforeStop = $true } },
        @{ Name='process-changed-before-stop'; Mutate={ $script:changeProcessBeforeStop = $true } }
    )
    foreach ($case in $negativeCases) {
        New-LauncherUpgradeCase
        & $case.Mutate
        $script:fakeManifest | ConvertTo-Json -Compress | Set-Content -LiteralPath $script:fixtureManifestPath -Encoding utf8
        $rejected = $false
        try { $null = . $scriptPath -CodexHome $fixtureRoot -StateDirectory $statePath }
        catch { $rejected = $true }
        if (-not $rejected -or $script:stops -ne 0 -or $script:starts -ne 0) { throw "身份不明时必须拒绝且不停止/启动进程：$($case.Name)" }
        $checks.Add('reject-' + $case.Name)
    }
    $serverSource = Get-Content -LiteralPath $script:fixtureServer -Raw -Encoding utf8
    if ($serverSource -notmatch "runtimeRevision = '2026\.10\.06-panel\.2'") { throw '启动器与服务端运行版本不一致。' }
    Write-Host "Performance monitor launcher: DryRun plus $($checks.Count) isolated upgrade/rejection checks passed; no production process was accessed."
}
finally {
    $resolvedFixture = [IO.Path]::GetFullPath($fixtureRoot)
    $resolvedTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (-not $resolvedFixture.StartsWith($resolvedTemp, [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFileName($resolvedFixture) -notlike 'codex-performance-launcher-*') {
        throw '测试临时目录边界不正确。'
    }
    Remove-Item -LiteralPath $resolvedFixture -Recurse -Force
}
