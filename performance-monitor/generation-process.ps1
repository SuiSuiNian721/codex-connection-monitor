[CmdletBinding()]
param(
    [Parameter(Mandatory)][int]$RootProcessId,
    [Parameter(Mandatory)][string]$StartedAt,
    [Parameter(Mandatory)][string]$Executable
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$verified = $false
try {
    if ($RootProcessId -gt 0 -and [IO.Path]::IsPathFullyQualified($Executable)) {
        $expectedStart = [DateTimeOffset]::Parse($StartedAt).UtcDateTime
        $rootProcess = Get-Process -Id $RootProcessId -ErrorAction Stop
        $verified = $rootProcess.Path -and
            [IO.Path]::GetFullPath($rootProcess.Path) -ieq [IO.Path]::GetFullPath($Executable) -and
            [Math]::Abs(($rootProcess.StartTime.ToUniversalTime() - $expectedStart).TotalMilliseconds) -lt 1
    }
}
catch { $verified = $false }
[ordered]@{ verified = [bool]$verified } | ConvertTo-Json -Compress
