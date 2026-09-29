# Read-only Windows device/source checks; no install, service restart, generation or release acceptance.
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$Repository,
  [Parameter(Mandatory)][string]$ReceiptRoot
)
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or -not [Environment]::Is64BitOperatingSystem) {
  throw 'This preflight requires a native Windows x64 operating system.'
}
$repositoryPath = (Resolve-Path -LiteralPath $Repository).Path
$packagePath = Join-Path $repositoryPath 'package.json'
$package = Get-Content -Raw -LiteralPath $packagePath | ConvertFrom-Json
if ($package.name -cne '@deepseek-ai/dsh-root') { throw 'Repository is not the Qianshou Mac-PC source root.' }
$receiptPath = [IO.Path]::GetFullPath($ReceiptRoot)
if (Test-Path -LiteralPath $receiptPath) { throw 'Choose a new receipt directory; existing evidence is never overwritten.' }
New-Item -ItemType Directory -Path $receiptPath | Out-Null
function Invoke-ReadOnly([string]$Name, [string[]]$Arguments) {
  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if (-not $command) { return [ordered]@{ available = $false } }
  $output = & $command.Source @Arguments 2>&1 | Out-String
  $code = $LASTEXITCODE
  return [ordered]@{ available = $true; executable = $command.Source; exitCode = $code; output = $output.Trim() }
}
$originalDirectory = Get-Location
try {
  Set-Location -LiteralPath $repositoryPath
  $node = Invoke-ReadOnly 'node' @('--version')
  $pnpm = Invoke-ReadOnly 'pnpm' @('--version')
  $git = Invoke-ReadOnly 'git' @('rev-parse', 'HEAD')
  $gpu = Invoke-ReadOnly 'nvidia-smi' @('--query-gpu=index,name,driver_version,memory.total', '--format=csv,noheader')
  $nodeReady = $false
  if ($node.available -and $node.exitCode -eq 0 -and $node.output -match '^v(\d+)\.(\d+)\.(\d+)$') {
    $major = [int]$Matches[1]; $minor = [int]$Matches[2]
    $nodeReady = ($major -eq 22 -and $minor -ge 19) -or $major -ge 24
  }
  $managerVersion = $package.packageManager -replace '^pnpm@', '' -replace '\+.*$', ''
  $pnpmReady = $pnpm.available -and $pnpm.exitCode -eq 0 -and $pnpm.output -ceq $managerVersion
  $desktopPackage = Get-Content -Raw -LiteralPath (Join-Path $repositoryPath 'apps/desktop/package.json') | ConvertFrom-Json
  $preparedTarget = Join-Path $repositoryPath 'apps/desktop/.desktop-build/targets/win-x64'
  $receipt = [ordered]@{
    schema = 'qianshou.windows-native-preflight.v1'
    classification = 'device-and-source-preflight'
    nativeWindows = $true
    osVersion = [Environment]::OSVersion.Version.ToString()
    powershellVersion = $PSVersionTable.PSVersion.ToString()
    measuredAt = [DateTime]::UtcNow.ToString('o')
    repository = $repositoryPath
    sourceCommit = $git
    packageJsonSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $packagePath).Hash.ToLowerInvariant()
    desktopVersion = $desktopPackage.version
    node = $node
    nodeEngineReady = $nodeReady
    pnpm = $pnpm
    requiredPnpm = $managerVersion
    pnpmReady = $pnpmReady
    gpu = $gpu
    disks = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object DeviceID,FreeSpace,Size)
    preparedWinTargetExists = (Test-Path -LiteralPath $preparedTarget)
    nativeGuiAccepted = $false
    installationAccepted = $false
    gpuExecutionAccepted = $false
    publishable = $false
  }
  $destination = Join-Path $receiptPath 'windows-native-preflight.json'
  [IO.File]::WriteAllText($destination, (($receipt | ConvertTo-Json -Depth 8) + "`n"), [Text.UTF8Encoding]::new($false))
  Write-Host "Native preflight saved: $destination"
  if (-not $nodeReady -or -not $pnpmReady) { throw 'Node/pnpm source-build prerequisite is unavailable; see the measured receipt.' }
} finally { Set-Location -LiteralPath $originalDirectory.Path }
