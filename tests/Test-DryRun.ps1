$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$launcherPath = Join-Path $projectRoot 'Start-CodexWithProxy.ps1'
$powershell = (Get-Command pwsh.exe -ErrorAction Stop).Source

$listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)
$tempRoot = Join-Path $env:TEMP ('codex-launcher-dryrun-' + [guid]::NewGuid().ToString('N'))
try {
    $listener.Start()
    $port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
    $fakeExecutable = Join-Path $tempRoot 'app\Codex.exe'
    New-Item -ItemType Directory -Force (Split-Path $fakeExecutable -Parent) | Out-Null
    New-Item -ItemType File -Force $fakeExecutable | Out-Null

    $watchdogPattern = [regex]::Escape((Join-Path $projectRoot 'Watch-CodexConnection.ps1'))
    $watchdogsBefore = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.CommandLine -match $watchdogPattern
    }).Count

    $output = & $powershell -NoProfile -ExecutionPolicy Bypass -File $launcherPath `
        -DryRun `
        -ProxyServerOverride "127.0.0.1:$port" `
        -CodexExecutableOverride $fakeExecutable 2>&1
    if ($LASTEXITCODE -ne 0) { throw "DryRun exit code was $LASTEXITCODE" }

    $text = $output -join [Environment]::NewLine
    if ($text -notmatch 'DryRun') { throw 'DryRun marker missing' }
    if ($text -notmatch [regex]::Escape("http://127.0.0.1:$port")) { throw 'Resolved proxy missing' }
    if ($text -notmatch [regex]::Escape($fakeExecutable)) { throw 'Resolved executable missing' }
    $watchdogsAfter = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.CommandLine -match $watchdogPattern
    }).Count
    if ($watchdogsAfter -ne $watchdogsBefore) { throw 'DryRun must not start a connection watchdog.' }
    Write-Host 'DryRun test passed.'
}
finally {
    $listener.Stop()
    if (Test-Path $tempRoot) { Remove-Item -Recurse -Force $tempRoot }
}
