[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$RemoteHost,

  [Parameter(Mandatory = $true)]
  [string]$RemoteUser,

  [Parameter(Mandatory = $true)]
  [string]$RemoteWebRoot,

  [Parameter(Mandatory = $true)]
  [string]$RemoteReleaseRoot,

  [string]$RemoteCloudRoot,
  [int]$Port = 22,
  [string]$IdentityFile,
  [string]$CloudInstallCommand,
  [string]$RestartCommand,
  [string]$ValidationUrl = 'https://lawagent.zhijing.fun/api/web/site/config',
  [int]$ValidationRetries = 5,
  [switch]$SkipCloudDeploy,
  [switch]$SkipValidation,
  [switch]$SkipBuild
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$webRoot = Join-Path $repoRoot 'web'
$webDistRoot = Join-Path $webRoot 'dist'
$cloudRoot = Join-Path $repoRoot 'cloud-server'
$cloudDistRoot = Join-Path $cloudRoot 'dist'
$cloudMigrationsRoot = Join-Path $cloudRoot 'migrations'
$appReleaseRoot = Join-Path $repoRoot 'app\release'
$deployTempRoot = Join-Path $repoRoot 'tmp\deploy-platform'
$npmCommand = 'npm.cmd'
$sshCommand = 'ssh.exe'
$scpCommand = 'scp.exe'

function Assert-CommandExists([string]$CommandName) {
  if (-not (Get-Command $CommandName -ErrorAction SilentlyContinue)) {
    throw "Command not found: $CommandName"
  }
}

function Invoke-CheckedCommand {
  param(
    [Parameter(Mandatory = $true)]
    [string]$FilePath,

    [Parameter(Mandatory = $true)]
    [string[]]$Arguments,

    [string]$WorkingDirectory
  )

  if ($WorkingDirectory) {
    Push-Location $WorkingDirectory
  }

  try {
    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
      throw "Command failed with exit code ${LASTEXITCODE}: $FilePath $($Arguments -join ' ')"
    }
  } finally {
    if ($WorkingDirectory) {
      Pop-Location
    }
  }
}

function Get-LatestInstaller {
  if (-not (Test-Path $appReleaseRoot)) {
    throw "Release directory not found: $appReleaseRoot"
  }

  $installer = Get-ChildItem -Path $appReleaseRoot -Filter 'LawVerify-Setup-*.exe' |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

  if (-not $installer) {
    throw "No installer found under $appReleaseRoot"
  }

  return $installer
}

function New-SshArguments([string[]]$ExtraArgs) {
  $args = @('-P', "$Port")
  if ($IdentityFile) {
    $args += @('-i', $IdentityFile)
  }

  $args += $ExtraArgs
  return $args
}

function New-DeployTempDirectory([string]$Name) {
  if (-not (Test-Path $deployTempRoot)) {
    New-Item -ItemType Directory -Path $deployTempRoot | Out-Null
  }

  $target = Join-Path $deployTempRoot ("{0}-{1}" -f $Name, [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $target | Out-Null
  return $target
}

function Copy-ItemIfExists {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Source,

    [Parameter(Mandatory = $true)]
    [string]$Destination
  )

  if (Test-Path $Source) {
    Copy-Item -Path $Source -Destination $Destination -Recurse -Force
  }
}

function New-CloudDeployPayload {
  if (-not (Test-Path $cloudDistRoot)) {
    throw "Cloud dist directory not found: $cloudDistRoot"
  }

  $payloadRoot = New-DeployTempDirectory 'cloud-server'

  Copy-ItemIfExists -Source $cloudDistRoot -Destination (Join-Path $payloadRoot 'dist')
  Copy-ItemIfExists -Source $cloudMigrationsRoot -Destination (Join-Path $payloadRoot 'migrations')
  Copy-ItemIfExists -Source (Join-Path $cloudRoot 'package.json') -Destination (Join-Path $payloadRoot 'package.json')
  Copy-ItemIfExists -Source (Join-Path $cloudRoot 'package-lock.json') -Destination (Join-Path $payloadRoot 'package-lock.json')

  return $payloadRoot
}

function Test-ValidationEndpoint {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Url,

    [int]$MaxRetries = 5
  )

  $lastError = $null

  for ($attempt = 1; $attempt -le $MaxRetries; $attempt++) {
    try {
      $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 15
      if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 300) {
        return
      }

      $lastError = "Validation returned HTTP $($response.StatusCode)"
    } catch {
      $lastError = $_.Exception.Message
    }

    if ($attempt -lt $MaxRetries) {
      Start-Sleep -Seconds 2
    }
  }

  throw "Validation failed for $Url. Last error: $lastError"
}

Assert-CommandExists $npmCommand
Assert-CommandExists $sshCommand
Assert-CommandExists $scpCommand

$deployCloud = -not $SkipCloudDeploy -and -not [string]::IsNullOrWhiteSpace($RemoteCloudRoot)

if (-not $SkipBuild) {
  Write-Host ''
  Write-Host '== Build web ==' -ForegroundColor Cyan
  Invoke-CheckedCommand -FilePath $npmCommand -Arguments @('run', 'build') -WorkingDirectory $webRoot

  if ($deployCloud) {
    Write-Host ''
    Write-Host '== Build cloud-server ==' -ForegroundColor Cyan
    Invoke-CheckedCommand -FilePath $npmCommand -Arguments @('run', 'build') -WorkingDirectory $cloudRoot
  }
}

if (-not (Test-Path $webDistRoot)) {
  throw "Web dist directory not found: $webDistRoot"
}

$installer = Get-LatestInstaller
$remoteTarget = "$RemoteUser@$RemoteHost"
$webDistUploadPath = (Join-Path $webDistRoot '*')
$cloudPayloadRoot = if ($deployCloud) { New-CloudDeployPayload } else { $null }
$cloudUploadPath = if ($cloudPayloadRoot) { (Join-Path $cloudPayloadRoot '*') } else { $null }

Write-Host ''
Write-Host '== Release payload ==' -ForegroundColor Cyan
Write-Host "Remote target: $remoteTarget"
Write-Host "Remote web root: $RemoteWebRoot"
Write-Host "Remote release root: $RemoteReleaseRoot"
if ($deployCloud) {
  Write-Host "Remote cloud root: $RemoteCloudRoot"
}
Write-Host "Installer: $($installer.FullName)"

Write-Host ''
Write-Host '== Ensure remote directories ==' -ForegroundColor Cyan
$remoteDirectories = @($RemoteWebRoot, $RemoteReleaseRoot)
if ($deployCloud) {
  $remoteDirectories += $RemoteCloudRoot
}
$quotedRemoteDirectories = $remoteDirectories | ForEach-Object { "`"$_`"" }
$mkdirCommand = "mkdir -p $($quotedRemoteDirectories -join ' ')"
Invoke-CheckedCommand -FilePath $sshCommand -Arguments (New-SshArguments @($remoteTarget, $mkdirCommand))

Write-Host ''
Write-Host '== Upload web dist ==' -ForegroundColor Cyan
Invoke-CheckedCommand -FilePath $scpCommand -Arguments (New-SshArguments @('-r', $webDistUploadPath, "${remoteTarget}:$RemoteWebRoot/"))

Write-Host ''
Write-Host '== Upload latest installer ==' -ForegroundColor Cyan
Invoke-CheckedCommand -FilePath $scpCommand -Arguments (New-SshArguments @($installer.FullName, "${remoteTarget}:$RemoteReleaseRoot/"))

if ($deployCloud) {
  Write-Host ''
  Write-Host '== Upload cloud-server payload ==' -ForegroundColor Cyan
  Invoke-CheckedCommand -FilePath $scpCommand -Arguments (New-SshArguments @('-r', $cloudUploadPath, "${remoteTarget}:$RemoteCloudRoot/"))

  $resolvedCloudInstallCommand = $CloudInstallCommand
  if ([string]::IsNullOrWhiteSpace($resolvedCloudInstallCommand)) {
    $resolvedCloudInstallCommand = "cd `"$RemoteCloudRoot`" && npm ci --omit=dev"
  }

  Write-Host ''
  Write-Host '== Install cloud-server production dependencies ==' -ForegroundColor Cyan
  Invoke-CheckedCommand -FilePath $sshCommand -Arguments (New-SshArguments @($remoteTarget, $resolvedCloudInstallCommand))
}

if ($RestartCommand) {
  Write-Host ''
  Write-Host '== Run remote restart command ==' -ForegroundColor Cyan
  Invoke-CheckedCommand -FilePath $sshCommand -Arguments (New-SshArguments @($remoteTarget, $RestartCommand))
}

if (-not $SkipValidation) {
  Write-Host ''
  Write-Host '== Validate remote API ==' -ForegroundColor Cyan
  Test-ValidationEndpoint -Url $ValidationUrl -MaxRetries $ValidationRetries
  Write-Host "API validation passed: $ValidationUrl"
}

Write-Host ''
Write-Host '== Deploy complete ==' -ForegroundColor Green
Write-Host "Uploaded web dist to $RemoteWebRoot"
Write-Host "Uploaded installer to $RemoteReleaseRoot\$($installer.Name)"
if ($deployCloud) {
  Write-Host "Uploaded cloud-server payload to $RemoteCloudRoot"
}
Write-Host ''
Write-Host 'Example validation URLs:'
Write-Host '- https://lawagent.zhijing.fun/download'
Write-Host '- https://lawagent.zhijing.fun/api/web/releases'
