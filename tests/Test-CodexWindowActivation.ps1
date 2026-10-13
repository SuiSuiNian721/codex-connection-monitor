$ErrorActionPreference = 'Stop'
$launcherPath = Join-Path (Split-Path $PSScriptRoot -Parent) 'Start-CodexWithProxy.ps1'
$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($launcherPath, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Launcher syntax error.' }
$functionAst = $ast.FindAll({
    param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Request-CodexWindowActivation'
}, $true)
if ($functionAst.Count -ne 1) { throw 'Activation function was not found uniquely.' }
. ([scriptblock]::Create($functionAst[0].Extent.Text))

$script:assertions = 0
$script:started = @()
$script:cimRecords = @{}
$script:queries = @()
function Assert-True($Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
    $script:assertions++
}
function Get-CimInstance {
    param($ClassName, $Filter, $ErrorAction)
    if ($ClassName -ne 'Win32_Process' -or $Filter -notmatch '^ProcessId\s*=\s*(\d+)$') { throw 'Unexpected CIM query.' }
    $script:queries += [int]$matches[1]
    $script:cimRecords[[int]$matches[1]]
}
function Start-Process {
    param($FilePath, $WorkingDirectory, $ArgumentList)
    $script:started += [pscustomobject]@{ FilePath = $FilePath; WorkingDirectory = $WorkingDirectory; Arguments = $ArgumentList }
}
function Write-LauncherLog { param($Message, $Level) }
function Assert-Rejected([object[]]$Processes, [string]$Name) {
    $script:started = @()
    $caught = $null
    try { Request-CodexWindowActivation -Processes $Processes } catch { $caught = $_ }
    Assert-True ($null -ne $caught -and $caught.ToString() -match '原.*入口|未另开') "Unsafe activation was not rejected: $Name"
    Assert-True ($script:started.Count -eq 0) "Unsafe activation started an executable: $Name"
}

$executable = 'C:\Program Files\WindowsApps\OpenAI.Codex_26.1007.2314.0_x64__fixture\app\ChatGPT.exe'
$startedAt = [datetime]::new(2026, 10, 13, 4, 25, 0, [DateTimeKind]::Utc)
$rootProcess = [pscustomobject]@{ Id = 41001; Path = $executable; StartTime = $startedAt }
$rendererProcess = [pscustomobject]@{ Id = 41002; Path = $executable; StartTime = $startedAt.AddSeconds(1) }
function Reset-Records {
    $script:started = @()
    $script:queries = @()
    $script:cimRecords = @{
        41001 = [pscustomobject]@{ ProcessId = 41001; CreationDate = $startedAt; ExecutablePath = $executable; CommandLine = ('"' + $executable + '"') }
        41002 = [pscustomobject]@{ ProcessId = 41002; CreationDate = $startedAt.AddSeconds(1); ExecutablePath = $executable; CommandLine = ('"' + $executable + '" --type=renderer') }
    }
}

$originalProfile = $env:CODEX_ELECTRON_USER_DATA_PATH
try {
    Remove-Item -LiteralPath 'Env:CODEX_ELECTRON_USER_DATA_PATH' -ErrorAction SilentlyContinue
    $environmentBefore = [Environment]::GetEnvironmentVariables('Process')
    Reset-Records
    Request-CodexWindowActivation -Processes @($rootProcess)
    Assert-True ($script:started.Count -eq 1 -and $script:started[0].FilePath -ceq $executable) 'A verified default root must request native activation.'
    Assert-True ($null -eq $script:started[0].Arguments) 'Activation must not replay command-line arguments.'
    Assert-True ($script:started[0].WorkingDirectory -ceq (Split-Path $executable -Parent)) 'Activation must use the existing executable directory.'
    $environmentAfter = [Environment]::GetEnvironmentVariables('Process')
    Assert-True ($environmentAfter.Count -eq $environmentBefore.Count) 'Activation changed the process environment.'
    foreach ($name in $environmentBefore.Keys) {
        if ($environmentBefore[$name] -cne $environmentAfter[$name]) { throw 'Activation changed an environment value.' }
    }
    $script:assertions++

    Reset-Records
    Request-CodexWindowActivation -Processes @($rendererProcess, $rootProcess)
    Assert-True ($script:started.Count -eq 1) 'A renderer must not be counted as another GUI root.'

    foreach ($profileArgument in @('--user-data-dir="C:\fixture-profile"', '--user-data-dir "C:\fixture-profile"', '"--user-data-dir=C:\fixture-profile"')) {
        Reset-Records
        $script:cimRecords[41001].CommandLine += ' ' + $profileArgument
        Assert-Rejected @($rootProcess) 'custom user-data-dir'
    }
    Reset-Records
    $env:CODEX_ELECTRON_USER_DATA_PATH = 'C:\fixture-profile'
    Assert-Rejected @($rootProcess) 'explicit profile environment'
    Remove-Item -LiteralPath 'Env:CODEX_ELECTRON_USER_DATA_PATH'

    Reset-Records
    $script:cimRecords[41001].CreationDate = $startedAt.AddSeconds(1)
    Assert-Rejected @($rootProcess) 'process start time changed'
    Reset-Records
    $script:cimRecords[41001].ProcessId = 41003
    Assert-Rejected @($rootProcess) 'process ID changed'
    Reset-Records
    $script:cimRecords[41001].ExecutablePath = 'C:\fixture-other\ChatGPT.exe'
    Assert-Rejected @($rootProcess) 'executable identity changed'
    Reset-Records
    $script:cimRecords[41001].CommandLine = $null
    Assert-Rejected @($rootProcess) 'unreadable command line'
    Reset-Records
    $script:cimRecords[41002].CommandLine = ('"' + $executable + '"')
    Assert-Rejected @($rootProcess, $rendererProcess) 'multiple GUI roots'
    Reset-Records
    Assert-Rejected @($rendererProcess) 'only a renderer exists'
    Reset-Records
    $script:cimRecords.Remove(41001)
    Assert-Rejected @($rootProcess) 'process disappeared'

    Write-Host "Codex window activation tests passed. Assertions=$script:assertions"
}
finally {
    if ($null -eq $originalProfile) { Remove-Item -LiteralPath 'Env:CODEX_ELECTRON_USER_DATA_PATH' -ErrorAction SilentlyContinue }
    else { $env:CODEX_ELECTRON_USER_DATA_PATH = $originalProfile }
}
