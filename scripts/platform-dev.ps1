[CmdletBinding()]
param(
  [ValidateSet('start', 'stop', 'restart', 'status')]
  [string]$Action = 'start',
  [switch]$Rebuild
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$runtimeDir = Join-Path $repoRoot 'tmp\platform-runtime'
$stateFile = Join-Path $runtimeDir 'state.json'
$webPort = 4273
$cloudPort = 8788
$webUrl = "http://127.0.0.1:$webPort/"
$cloudHealthUrl = "http://127.0.0.1:$cloudPort/health"

function Ensure-RuntimeDirectory {
  if (!(Test-Path $runtimeDir)) {
    New-Item -ItemType Directory -Path $runtimeDir | Out-Null
  }
}

function Get-CommandPath([string[]]$Names) {
  foreach ($name in $Names) {
    $command = Get-Command $name -ErrorAction SilentlyContinue
    if ($command) {
      return $command.Source
    }
  }

  throw "Command not found: $($Names -join ', ')"
}

function Read-State {
  if (!(Test-Path $stateFile)) {
    return $null
  }

  return Get-Content -Raw $stateFile | ConvertFrom-Json
}

function Write-State([hashtable]$State) {
  Ensure-RuntimeDirectory
  $State | ConvertTo-Json -Depth 5 | Set-Content -Path $stateFile -Encoding UTF8
}

function Remove-State {
  if (Test-Path $stateFile) {
    Remove-Item $stateFile -Force
  }
}

function Stop-ProcessIfAlive([int]$ProcessId) {
  if ($ProcessId -le 0) {
    return
  }

  $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  if ($process) {
    Stop-Process -Id $ProcessId -Force
  }
}

function Stop-PortOwners([int[]]$Ports) {
  foreach ($port in $Ports) {
    $connections = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($processId in $connections) {
      if ($processId -and $processId -gt 0) {
        Stop-ProcessIfAlive -ProcessId $processId
      }
    }
  }
}

function Test-Url([string]$Url) {
  try {
    Invoke-WebRequest -UseBasicParsing $Url -TimeoutSec 2 | Out-Null
    return $true
  } catch {
    return $false
  }
}

function Wait-UntilAvailable([string]$Url, [string]$Name, [int]$TimeoutSeconds = 30) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-Url $Url) {
      return
    }

    Start-Sleep -Seconds 1
  }

  throw "$Name startup timed out: $Url"
}

function Invoke-Build([string]$WorkingDirectory) {
  $npmPath = Get-CommandPath @('npm.cmd', 'npm')
  & $npmPath run build | Write-Output
  if ($LASTEXITCODE -ne 0) {
    throw "Build failed: $WorkingDirectory"
  }
}

function Start-WebProcess([string]$NodePath) {
  $webWorkingDirectory = Join-Path $repoRoot 'web'
  $previewServer = Join-Path $webWorkingDirectory 'preview-server.mjs'
  $stdout = Join-Path $runtimeDir 'web.out.log'
  $stderr = Join-Path $runtimeDir 'web.err.log'

  $process = Start-Process -FilePath $NodePath `
    -ArgumentList @($previewServer, '--host', '0.0.0.0', '--port', "$webPort", '--api-base', "http://127.0.0.1:$cloudPort") `
    -WorkingDirectory $webWorkingDirectory `
    -RedirectStandardOutput $stdout `
    -RedirectStandardError $stderr `
    -PassThru

  return @{
    pid = $process.Id
    stdout = $stdout
    stderr = $stderr
  }
}

function Start-CloudProcess([string]$NodePath) {
  $cloudWorkingDirectory = Join-Path $repoRoot 'cloud-server'
  $entry = Join-Path $cloudWorkingDirectory 'dist\index.js'
  $stdout = Join-Path $runtimeDir 'cloud-server.out.log'
  $stderr = Join-Path $runtimeDir 'cloud-server.err.log'

  $process = Start-Process -FilePath $NodePath `
    -ArgumentList @($entry) `
    -WorkingDirectory $cloudWorkingDirectory `
    -RedirectStandardOutput $stdout `
    -RedirectStandardError $stderr `
    -PassThru

  return @{
    pid = $process.Id
    stdout = $stdout
    stderr = $stderr
  }
}

function Start-Platform {
  Ensure-RuntimeDirectory

  $nodePath = Get-CommandPath @('node.exe', 'node')
  $webDist = Join-Path $repoRoot 'web\dist\index.html'
  $cloudDist = Join-Path $repoRoot 'cloud-server\dist\index.js'

  if ($Rebuild -or !(Test-Path $webDist)) {
    Push-Location (Join-Path $repoRoot 'web')
    try {
      Invoke-Build -WorkingDirectory 'web'
    } finally {
      Pop-Location
    }
  }

  if ($Rebuild -or !(Test-Path $cloudDist)) {
    Push-Location (Join-Path $repoRoot 'cloud-server')
    try {
      Invoke-Build -WorkingDirectory 'cloud-server'
    } finally {
      Pop-Location
    }
  }

  Stop-Platform

  $cloud = Start-CloudProcess -NodePath $nodePath
  Wait-UntilAvailable -Url $cloudHealthUrl -Name 'cloud-server'

  $web = Start-WebProcess -NodePath $nodePath
  Wait-UntilAvailable -Url $webUrl -Name 'web'

  Write-State @{
    startedAt = (Get-Date).ToString('s')
    web = $web
    cloudServer = $cloud
  }

  Write-Output "Platform started:"
  Write-Output "- web: $webUrl (PID $($web.pid))"
  Write-Output "- cloud-server: http://127.0.0.1:$cloudPort (PID $($cloud.pid))"
}

function Stop-Platform {
  $state = Read-State
  if ($state) {
    Stop-ProcessIfAlive -ProcessId ([int]$state.web.pid)
    Stop-ProcessIfAlive -ProcessId ([int]$state.cloudServer.pid)
  }

  Stop-PortOwners -Ports @($webPort, $cloudPort)
  Remove-State
}

function Show-Status {
  $state = Read-State
  $webUp = Test-Url $webUrl
  $cloudUp = Test-Url $cloudHealthUrl

  Write-Output "Platform status:"
  Write-Output "- web($webPort): $(if ($webUp) { 'running' } else { 'stopped' })"
  Write-Output "- cloud-server($cloudPort): $(if ($cloudUp) { 'running' } else { 'stopped' })"

  if ($state) {
    Write-Output "- web PID: $($state.web.pid)"
    Write-Output "- web log: $($state.web.stdout)"
    Write-Output "- cloud PID: $($state.cloudServer.pid)"
    Write-Output "- cloud log: $($state.cloudServer.stdout)"
  } else {
    Write-Output "- no runtime state file yet"
  }
}

switch ($Action) {
  'start' { Start-Platform }
  'stop' { Stop-Platform; Write-Output 'Platform stopped.' }
  'restart' { Stop-Platform; Start-Platform }
  'status' { Show-Status }
}
