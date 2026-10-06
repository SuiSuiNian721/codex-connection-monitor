[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$scriptPath = Join-Path $projectRoot 'performance-monitor\network-system.ps1'
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw '网络库存脚本存在语法错误。' }
# 从实际脚本加载纯函数；离线测试不需要再次查询系统或启动任何服务。
$definitions = $ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $false)
. ([scriptblock]::Create(($definitions | ForEach-Object { $_.Extent.Text }) -join "`n"))

function Assert-NetworkValue {
    param($Actual, $Expected, [string]$Message)
    if ($Actual -cne $Expected) { throw $Message }
}

Assert-NetworkValue (ConvertTo-NetworkLocalProxy '127.0.0.1:7890') 'http://127.0.0.1:7890' '本机代理解析错误。'
Assert-NetworkValue (ConvertTo-NetworkLocalProxy 'http=127.0.0.1:7890;https=127.0.0.1:7891') 'http://127.0.0.1:7891' 'HTTPS 对照目标没有优先采用系统 HTTPS 代理。'
Assert-NetworkValue (ConvertTo-NetworkLocalProxy 'https://[::1]:7890') 'https://[::1]:7890' 'IPv6 本机代理解析错误。'
Assert-NetworkValue (ConvertTo-NetworkLocalProxy 'socks5://127.0.0.1:7890') 'socks5://127.0.0.1:7890' 'SOCKS 端点元数据解析错误。'
foreach ($unsafe in @('http://user:secret@localhost:7890', 'http://example.com:7890',
    'http://127.0.0.2:7890', 'http://localhost:7890/private', 'http://localhost:7890/?token=secret',
    'http://localhost:7890/#secret', 'http://localhost:0', 'http://localhost:65536', 'file://localhost:7890')) {
    Assert-NetworkValue (ConvertTo-NetworkLocalProxy $unsafe) $null '不安全的代理元数据未被拒绝。'
}

$expectedScript = Join-Path $projectRoot 'Watch-CodexConnection.ps1'
$fixtureExecutable = Join-Path $projectRoot 'fixture with spaces\Codex.exe'
$commandLine = '"C:\Program Files\PowerShell\7\pwsh.exe" -NoProfile -WindowStyle Hidden -File "{0}" -RootProcessId 42 -CodexExecutable "{1}" -InitialProxyUri http://127.0.0.1:7890' -f $expectedScript, $fixtureExecutable
$arguments = Get-NetworkWatchdogArguments $commandLine $expectedScript
Assert-NetworkValue $arguments.RootProcessId 42 '监视器主进程 ID 解析错误。'
Assert-NetworkValue $arguments.CodexExecutable $fixtureExecutable '带空格的主进程路径解析错误。'
Assert-NetworkValue $arguments.ClientProxyUri 'http://127.0.0.1:7890' '已绑定的监视器入口不能被系统 HTTPS 代理选择覆盖。'
Assert-NetworkValue (Get-NetworkWatchdogArguments ($commandLine + ' -RootProcessId 43') $expectedScript) $null '重复主进程参数未被拒绝。'
Assert-NetworkValue (Get-NetworkWatchdogArguments $commandLine (Join-Path $projectRoot 'different\Watch-CodexConnection.ps1')) $null '其他目录的监视器被错误绑定。'
$decoy = 'pwsh.exe -Command "Write-Output \"-File {0} -RootProcessId 42 -CodexExecutable {1} -InitialProxyUri http://127.0.0.1:7890\""' -f $expectedScript, $fixtureExecutable
Assert-NetworkValue (Get-NetworkWatchdogArguments $decoy $expectedScript) $null '命令文本中的假监视器参数被错误绑定。'

$startedAt = [DateTime]::UtcNow.AddMinutes(-5)
$watchdogs = @(
    [pscustomobject]@{ CreationDate = $startedAt.AddMinutes(1); CommandLine = $commandLine },
    [pscustomobject]@{ CreationDate = $startedAt.AddMinutes(2); CommandLine = ($commandLine -replace '-RootProcessId 42', '-RootProcessId 43') }
)
$reader = {
    param($RootId)
    [pscustomobject]@{ Id = $RootId; StartTime = $startedAt; Path = $(if ($RootId -eq 42) { $fixtureExecutable } else { 'C:\wrong.exe' }) }
}
$binding = Find-NetworkWatchdogBinding -Watchdogs $watchdogs -Root $projectRoot -ReadRoot $reader
Assert-NetworkValue $binding.ProcessId 42 '未跳过主进程路径不符的最新监视器。'
$unrelated = foreach ($index in 1..20) {
    [pscustomobject]@{
        CreationDate = $startedAt.AddMinutes(2).AddSeconds($index)
        CommandLine = 'pwsh.exe -NoProfile -File "{0}"' -f (Join-Path $projectRoot 'performance-monitor\network-system.ps1')
    }
}
$crowdedBinding = Find-NetworkWatchdogBinding -Watchdogs (@($watchdogs) + @($unrelated)) -Root $projectRoot -ReadRoot $reader
Assert-NetworkValue $crowdedBinding.ProcessId 42 '二十个较新的无关 pwsh 进程挤掉了已核对的监视器。'
$reusedReader = { param($RootId) [pscustomobject]@{ Id = $RootId; StartTime = $startedAt.AddMinutes(3); Path = $fixtureExecutable } }
Assert-NetworkValue (Find-NetworkWatchdogBinding -Watchdogs $watchdogs -Root $projectRoot -ReadRoot $reusedReader) $null '启动时间晚于监视器的复用 PID 未被拒绝。'

$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('codex-network-system-' + [guid]::NewGuid().ToString('N'))
$linkPath = Join-Path $fixtureRoot 'runtime\linked'
try {
    [void][IO.Directory]::CreateDirectory((Join-Path $fixtureRoot 'runtime\valid'))
    [void][IO.Directory]::CreateDirectory((Join-Path $fixtureRoot 'outside'))
    $validState = Join-Path $fixtureRoot 'runtime\valid\service.json'
    $outsideState = Join-Path $fixtureRoot 'outside\service.json'
    Set-Content -LiteralPath $validState -Value '{}' -Encoding utf8
    Set-Content -LiteralPath $outsideState -Value '{}' -Encoding utf8
    Assert-NetworkValue (Test-NetworkRelayStatePath $validState $fixtureRoot) $true '正常 runtime 状态路径未通过。'
    Assert-NetworkValue (Test-NetworkRelayStatePath $outsideState $fixtureRoot) $false 'runtime 外的状态路径未被拒绝。'
    Assert-NetworkValue (Test-NetworkRelayStatePath (Join-Path $fixtureRoot 'runtime\..\outside\service.json') $fixtureRoot) $false '跨越 runtime 边界的路径未被拒绝。'
    [void](New-Item -ItemType Junction -Path $linkPath -Target (Join-Path $fixtureRoot 'outside'))
    Assert-NetworkValue (Test-NetworkRelayStatePath (Join-Path $linkPath 'service.json') $fixtureRoot) $false '通过目录链接的状态路径未被拒绝。'

    $output = @(& $scriptPath -ProjectRoot $fixtureRoot)
    if ($output.Count -ne 1) { throw '脚本标准输出必须只有一个 JSON。' }
    $snapshot = $output[0] | ConvertFrom-Json -ErrorAction Stop
    Assert-NetworkValue $snapshot.codex.monitored $false '临时工程误绑定了现有 Codex 会话。'
    Assert-NetworkValue $snapshot.codex.running $null '未绑定会话不能推断 Codex 没有运行。'
    if ($snapshot.proxySource -notin @('system', 'unknown')) { throw '临时工程没有使用系统代理回退语义。' }
    if ($output[0] -match 'CommandLine|statusToken|Authorization|CodexExecutable|MACAddress|UserInfo|Secret') {
        throw '库存 JSON 包含私密字段。'
    }
    foreach ($endpoint in @($snapshot.systemProxyUri, $snapshot.clientProxyUri, $snapshot.upstreamProxyUri)) {
        if ($endpoint -and (ConvertTo-NetworkLocalProxy $endpoint) -cne $endpoint) { throw '库存 JSON 含有不安全端点。' }
    }
    Write-Host 'Network system inventory tests passed.'
}
finally {
    $resolvedFixture = [IO.Path]::GetFullPath($fixtureRoot)
    $resolvedTemp = [IO.Path]::TrimEndingDirectorySeparator([IO.Path]::GetFullPath([IO.Path]::GetTempPath())) + [IO.Path]::DirectorySeparatorChar
    if (-not $resolvedFixture.StartsWith($resolvedTemp, [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFileName($resolvedFixture) -notmatch '^codex-network-system-[a-f0-9]{32}$') { throw '测试清理路径超出临时目录。' }
    if (Test-Path -LiteralPath $linkPath) { Remove-Item -LiteralPath $linkPath -Force }
    if (Test-Path -LiteralPath $resolvedFixture) { Remove-Item -LiteralPath $resolvedFixture -Recurse -Force }
}
