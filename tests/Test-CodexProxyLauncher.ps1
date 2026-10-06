$ErrorActionPreference = 'Stop'
$script:Passed = 0

function Assert-Equal {
    param($Expected, $Actual, [string]$Name)
    if ($Expected -ne $Actual) {
        throw "FAIL [$Name]: expected '$Expected', got '$Actual'"
    }
    $script:Passed++
}

function Assert-True {
    param([bool]$Condition, [string]$Name)
    if (-not $Condition) {
        throw "FAIL [$Name]: condition was false"
    }
    $script:Passed++
}

$projectRoot = Split-Path $PSScriptRoot -Parent
$modulePath = Join-Path $projectRoot 'CodexProxyLauncher.psm1'
Import-Module $modulePath -Force

Assert-Equal 'http://127.0.0.1:9674' (ConvertTo-ProxyUri '127.0.0.1:9674') 'plain proxy'
Assert-Equal 'http://127.0.0.1:7890' (ConvertTo-ProxyUri 'http=127.0.0.1:7890;https=127.0.0.1:7891') 'protocol proxy'
Assert-Equal 'http://localhost:8080' (ConvertTo-ProxyUri 'https=localhost:8080') 'https-only proxy'
Assert-Equal $null (ConvertTo-ProxyUri 'not-a-proxy') 'invalid proxy'
Assert-Equal $null (ConvertTo-ProxyUri '') 'empty proxy'
Assert-Equal 'http://[::1]:7890' (ConvertTo-ProxyUri '[::1]:7890') 'IPv6 proxy'
Assert-Equal 'https://localhost:8080' (ConvertTo-ProxyUri 'https://localhost:8080/') 'HTTPS proxy URL'
Assert-Equal 'socks5://localhost:1080' (ConvertTo-ProxyUri 'socks=localhost:1080') 'SOCKS proxy map'
foreach ($invalid in @('ftp://localhost:7890', 'file://localhost:7890', 'http://user:secret@localhost:7890',
    'http://localhost:7890/path', 'http://localhost:7890//', 'http://localhost:7890/?token=secret', 'http://localhost:7890/#secret',
    'http://localhost:0', 'http://localhost:65536')) {
    Assert-Equal $null (ConvertTo-ProxyUri $invalid) "reject unsupported or secret-bearing proxy [$invalid]"
}

$tempRoot = Join-Path $env:TEMP ('codex-launcher-test-' + [guid]::NewGuid().ToString('N'))
try {
    $fakeExecutable = Join-Path $tempRoot 'app\Codex.exe'
    New-Item -ItemType Directory -Force (Split-Path $fakeExecutable -Parent) | Out-Null
    New-Item -ItemType File -Force $fakeExecutable | Out-Null
    Assert-Equal $fakeExecutable (Find-CodexExecutable -InstallLocation $tempRoot) 'Codex discovery'

    $currentExecutable = Join-Path $tempRoot 'app\ChatGPT.exe'
    New-Item -ItemType File -Force $currentExecutable | Out-Null
    Assert-Equal $currentExecutable (Find-CodexExecutable -InstallLocation $tempRoot) 'current ChatGPT entrypoint preferred'

    foreach ($version in @('26.928.2636.0', '26.1001.1234.0')) {
        $directory = Join-Path $tempRoot ($version + '\app')
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
        New-Item -ItemType File -Path (Join-Path $directory 'Codex.exe') | Out-Null
    }
    $module = Get-Module CodexProxyLauncher
    & $module {
        param($root)
        $script:packageTestRoot = $root
        function script:Get-AppxPackage {
            param($Name, $ErrorAction)
            foreach ($version in @('26.928.2636.0', '26.1001.1234.0')) {
                [pscustomobject]@{ Version = $version; InstallLocation = (Join-Path $script:packageTestRoot $version) }
            }
        }
        function script:Get-AppxPackageManifest { process { throw 'Fixture manifest unavailable.' } }
    } $tempRoot
    Assert-Equal (Join-Path $tempRoot '26.1001.1234.0\app\Codex.exe') (Find-CodexExecutable) 'semantic package version order'
}
finally {
    $resolved = [IO.Path]::GetFullPath($tempRoot)
    if ([IO.Path]::GetDirectoryName($resolved) -ine [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') -or
        [IO.Path]::GetFileName($resolved) -notlike 'codex-launcher-test-*') { throw 'Unsafe test cleanup path.' }
    if (Test-Path -LiteralPath $resolved) {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}

$listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)
try {
    $listener.Start()
    $port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
    Assert-True (Test-LocalProxy -ProxyUri "http://127.0.0.1:$port") 'listening proxy'
}
finally {
    $listener.Stop()
}

$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::IPv6Loopback, 0)
try {
    $listener.Start()
    $port = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
    Assert-True (Test-LocalProxy -ProxyUri "http://[::1]:$port") 'listening IPv6 proxy'
}
finally { $listener.Stop() }

Write-Host "All tests passed. Assertions: $script:Passed"
