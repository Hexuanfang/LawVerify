<#
LawVerify 本地工作台一键启动脚本（Windows / PowerShell）。

用法：
  .\dev-workbench.cmd                 # 安装依赖（如缺失）并启动 API + Vite
  .\dev-workbench.cmd install         # 仅安装依赖
  .\dev-workbench.cmd start           # 仅启动（不重复安装）
  .\dev-workbench.cmd stop            # 停止
  .\dev-workbench.cmd restart         # 重启
  .\dev-workbench.cmd status          # 查看状态
  .\dev-workbench.cmd start -Force        # 强制重装依赖
  .\dev-workbench.cmd start -OpenBrowser   # 启动后打开浏览器

端口：API 8787 / Vite 5173。日志：tmp\dev-workbench\*.log
#>
param(
  [ValidateSet('install', 'start', 'stop', 'restart', 'status')]
  [string]$Action = 'start',
  [switch]$Force,
  [switch]$OpenBrowser
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$runtimeDir = Join-Path $repoRoot 'tmp\dev-workbench'
$stateFile = Join-Path $runtimeDir 'state.json'
$apiPort = 8787
$webPort = 5173
$apiHealthUrl = "http://127.0.0.1:$apiPort/api/health"
$webUrl = "http://127.0.0.1:$webPort/"
$serverRoot = Join-Path $repoRoot 'server'
$appRoot = Join-Path $repoRoot 'app'

function Ensure-RuntimeDirectory {
  if (!(Test-Path $runtimeDir)) {
    New-Item -ItemType Directory -Path $runtimeDir | Out-Null
  }
}

function Get-CommandPath([string[]]$Names) {
  if ($Names -contains 'node.exe' -and (Test-Path 'C:\nvm4w\nodejs\node.exe')) {
    return 'C:\nvm4w\nodejs\node.exe'
  }
  foreach ($name in $Names) {
    $command = Get-Command $name -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
  }
  throw "Command not found: $($Names -join ', ')"
}

function Get-NodeVersion {
  $nodePath = Get-CommandPath @('node.exe', 'node')
  $raw = & $nodePath --version
  return [version](($raw -replace '^v', '').Trim())
}

function Read-State {
  if (!(Test-Path $stateFile)) { return $null }
  try { return Get-Content -Raw -Path $stateFile | ConvertFrom-Json } catch { return $null }
}

function Write-State([hashtable]$State) {
  Ensure-RuntimeDirectory
  $State | ConvertTo-Json -Depth 5 | Set-Content -Path $stateFile -Encoding UTF8
}

function Stop-ProcessTree([int]$TargetProcessId) {
  if ($TargetProcessId -le 0) { return }
  # npm -> node(tsx watch) 是父子进程，需要按树结束，否则 watch 进程会残留。
  & taskkill.exe /F /T /PID $TargetProcessId 2>$null | Out-Null
}

function Stop-PortOwners([int[]]$Ports) {
  # tsx watch 的 node 子进程可能脱离 cmd 进程树而存活，需按端口再清理一次。
  # 只结束命令行确实属于本仓库的进程，避免误杀占用端口的其它程序。
  foreach ($port in $Ports) {
    $owners = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty OwningProcess -Unique)
    foreach ($ownerId in $owners) {
      if (!$ownerId -or $ownerId -le 0) { continue }
      $owner = Get-CimInstance Win32_Process -Filter "ProcessId = $ownerId" -ErrorAction SilentlyContinue
      if (!$owner) { continue }
      $isRepoProcess = $owner.Name -eq 'node.exe' -and $owner.CommandLine -and $owner.CommandLine.Contains('LawVerify')
      if (!$isRepoProcess) {
        Write-Warning "Port $port is held by a process outside this project (PID $ownerId). Skipped. Close it manually and retry."
        continue
      }
      Stop-ProcessTree $ownerId
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

function Wait-UntilAvailable([string]$Url, [string]$Name, [int]$TimeoutSeconds = 120) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-Url $Url) { return }
    Start-Sleep -Milliseconds 800
  }
  throw "$Name startup timed out: $Url`nCheck the log files under $runtimeDir."
}

function Show-LogTail([string]$Path, [int]$Lines = 25) {
  if (!(Test-Path $Path)) { return }
  Write-Host "--- $Path (tail) ---"
  Get-Content -Path $Path -Tail $Lines -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
  Write-Host '-------------------------'
}

function Invoke-Npm([string]$WorkingDirectory, [string[]]$NpmArguments) {
  $npmPath = Get-CommandPath @('npm.cmd', 'npm')
  Push-Location $WorkingDirectory
  try {
    & $npmPath @NpmArguments
    if ($LASTEXITCODE -ne 0) {
      throw "npm $($NpmArguments -join ' ') failed in $WorkingDirectory with exit code $LASTEXITCODE"
    }
  } finally {
    Pop-Location
  }
}

function Initialize-EnvFiles {
  $serverEnv = Join-Path $serverRoot '.env.local'
  if (!(Test-Path $serverEnv)) {
    Copy-Item (Join-Path $serverRoot '.env.example') $serverEnv
    # 本地工作区不依赖 PostgreSQL，清空示例连接串，避免误连示例数据库。
    $content = Get-Content -Raw -Path $serverEnv
    $content = $content -replace '(?m)^DATABASE_URL=.*$', 'DATABASE_URL='
    Set-Content -Path $serverEnv -Value $content -Encoding UTF8
    Write-Host 'Created server\.env.local'
  }

  $appEnv = Join-Path $appRoot '.env.local'
  if (!(Test-Path $appEnv)) {
    Copy-Item (Join-Path $appRoot '.env.example') $appEnv
    Write-Host 'Created app\.env.local'
  }
}

function Install-Dependencies {
  $nodeVersion = Get-NodeVersion
  if ($nodeVersion.Major -lt 22 -or ($nodeVersion.Major -eq 22 -and $nodeVersion.Minor -lt 23)) {
    throw "Node.js 22.23.1 or newer is required (found $nodeVersion). The local workspace uses node:sqlite."
  }
  Write-Host "Node.js $nodeVersion detected."

  foreach ($module in @($serverRoot, $appRoot)) {
    $name = Split-Path -Leaf $module
    $modulesPath = Join-Path $module 'node_modules'
    if ((Test-Path $modulesPath) -and !$Force) {
      Write-Host "== $name : dependencies already installed (use -Force to reinstall) =="
      continue
    }
    Write-Host "== $name : installing dependencies =="
    Invoke-Npm -WorkingDirectory $module -NpmArguments @('ci')
  }
}

function Start-ProcessLogged([string]$Name, [string]$WorkingDirectory, [string]$Executable, [string[]]$Arguments) {
  $stdout = Join-Path $runtimeDir "$Name.out.log"
  $stderr = Join-Path $runtimeDir "$Name.err.log"
  foreach ($log in @($stdout, $stderr)) {
    if (Test-Path $log) { Copy-Item $log "$log.prev" -Force }
  }

  $process = Start-Process -FilePath $Executable `
    -ArgumentList $Arguments `
    -WorkingDirectory $WorkingDirectory `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdout `
    -RedirectStandardError $stderr `
    -PassThru

  return @{ pid = $process.Id; stdout = $stdout; stderr = $stderr }
}
function Stop-DevWorkbench {
  Ensure-RuntimeDirectory
  $state = Read-State
  if ($state) {
    if ($state.PSObject.Properties.Name -contains 'api') { Stop-ProcessTree ([int]$state.api.pid) }
    if ($state.PSObject.Properties.Name -contains 'web') { Stop-ProcessTree ([int]$state.web.pid) }
  }
  Stop-PortOwners -Ports @($apiPort, $webPort)
  Remove-Item $stateFile -Force -ErrorAction SilentlyContinue
  Write-Host 'Workbench stopped.'
}

function Start-DevWorkbench {
  Ensure-RuntimeDirectory
  Initialize-EnvFiles

  if (Test-Url $apiHealthUrl) {
    Write-Host "API already running on port $apiPort. Run '.\dev-workbench.cmd stop' first."
    return
  }

  # npm.cmd 是批处理文件，CreateProcess 不能直接带重定向执行它，
  # 因此通过 cmd.exe /c 调用仓库自带的 dev 脚本，行为与手动执行 npm run dev 一致。
  $cmdPath = $env:ComSpec
  if (!$cmdPath -or !(Test-Path $cmdPath)) { $cmdPath = 'C:\Windows\System32\cmd.exe' }
  Get-CommandPath @('npm.cmd', 'npm') | Out-Null

  Write-Host '== Starting local API (port 8787) =='
  $api = Start-ProcessLogged -Name 'api' -WorkingDirectory $serverRoot -Executable $cmdPath `
    -Arguments @('/c', 'npm run dev')

  Write-Host '== Starting Vite workbench (port 5173) =='
  $web = Start-ProcessLogged -Name 'web' -WorkingDirectory $appRoot -Executable $cmdPath `
    -Arguments @('/c', 'npm run dev:web')

  try {
    Wait-UntilAvailable -Url $apiHealthUrl -Name 'API'
    Wait-UntilAvailable -Url $webUrl -Name 'Vite dev server'
  } catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    Show-LogTail -Path $api.stderr
    Show-LogTail -Path $api.stdout
    Show-LogTail -Path $web.stderr
    Show-LogTail -Path $web.stdout
    Stop-DevWorkbench
    throw
  }

  Write-State @{ startedAt = (Get-Date).ToString('s'); api = $api; web = $web }

  Write-Host ''
  Write-Host '== LawVerify workbench is running ==' -ForegroundColor Green
  Write-Host "- Workbench: $webUrl"
  Write-Host "- API:      $apiHealthUrl"
  Write-Host "- API log:  $($api.stdout)"
  Write-Host "- Web log:  $($web.stdout)"
  Write-Host ''
  Write-Host 'Stop with: .\dev-workbench.cmd stop'

  if ($OpenBrowser) {
    Start-Process $webUrl
  }
}

function Show-DevWorkbenchStatus {
  $state = Read-State
  Write-Host 'Workbench status:'
  Write-Host "- API($apiPort): $(if (Test-Url $apiHealthUrl) { 'running' } else { 'stopped' })"
  Write-Host "- Web($webPort): $(if (Test-Url $webUrl) { 'running' } else { 'stopped' })"
  if ($state) {
    if ($state.PSObject.Properties.Name -contains 'api') {
      Write-Host "- API PID: $($state.api.pid)  log: $($state.api.stdout)"
    }
    if ($state.PSObject.Properties.Name -contains 'web') {
      Write-Host "- Web PID: $($state.web.pid)  log: $($state.web.stdout)"
    }
  } else {
    Write-Host '- no runtime state file yet'
  }
}

switch ($Action) {
  'install' { Install-Dependencies }
  'start'   { Install-Dependencies; Start-DevWorkbench }
  'stop'    { Stop-DevWorkbench }
  'restart' { Stop-DevWorkbench; Install-Dependencies; Start-DevWorkbench }
  'status'  { Show-DevWorkbenchStatus }
}
