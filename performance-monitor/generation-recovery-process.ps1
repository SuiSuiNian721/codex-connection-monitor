[CmdletBinding()]
param(
    [Parameter(Mandatory)][int]$RootProcessId,
    [Parameter(Mandatory)][string]$RootStartedAt,
    [Parameter(Mandatory)][string]$RootExecutable,
    [Parameter(Mandatory)][int]$BridgeProcessId,
    [Parameter(Mandatory)][int]$CliProcessId,
    [Parameter(Mandatory)][string]$NodeExecutable,
    [Parameter(Mandatory)][string]$NativeExecutable,
    [Parameter(Mandatory)][string]$BridgeScript
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
try {
    $root = Get-Process -Id $RootProcessId -ErrorAction Stop
    if ($root.Path -ine $RootExecutable -or
        [Math]::Abs(($root.StartTime.ToUniversalTime() - [DateTimeOffset]::Parse($RootStartedAt).UtcDateTime).TotalMilliseconds) -ge 1) {
        throw 'root-identity'
    }
    $bridge = Get-CimInstance Win32_Process -Filter "ProcessId=$BridgeProcessId" -ErrorAction Stop
    $cli = Get-CimInstance Win32_Process -Filter "ProcessId=$CliProcessId" -ErrorAction Stop
    if (-not $bridge -or -not $cli -or $bridge.ExecutablePath -ine $NodeExecutable -or
        $cli.ParentProcessId -ne $BridgeProcessId -or
        -not $bridge.CommandLine.Contains($BridgeScript) -or
        $bridge.CreationDate.ToUniversalTime() -lt $root.StartTime.ToUniversalTime() -or
        $cli.CreationDate.ToUniversalTime() -lt $bridge.CreationDate.ToUniversalTime()) { throw 'bridge-identity' }
    $native = Get-CimInstance Win32_Process -Filter "ProcessId=$($bridge.ParentProcessId)" -ErrorAction Stop
    if (-not $native -or $native.ExecutablePath -ine $NativeExecutable -or
        $native.ParentProcessId -ne $RootProcessId -or
        $native.CreationDate.ToUniversalTime() -lt $root.StartTime.ToUniversalTime()) { throw 'native-identity' }
    $listeners = @(Get-NetTCPConnection -OwningProcess $BridgeProcessId -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty LocalPort -Unique)
    $recoveryPortOwners = @(Get-NetTCPConnection -LocalPort 9229 -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique)
    [ordered]@{ verified=$true; bridgePid=$BridgeProcessId; cliPid=$CliProcessId; nativePid=$native.ProcessId;
        bridgeStartedAt=$bridge.CreationDate.ToUniversalTime().ToString('o'); cliStartedAt=$cli.CreationDate.ToUniversalTime().ToString('o');
        listeners=$listeners; recoveryPortOwners=$recoveryPortOwners } | ConvertTo-Json -Compress
}
catch { [ordered]@{ verified=$false } | ConvertTo-Json -Compress }
