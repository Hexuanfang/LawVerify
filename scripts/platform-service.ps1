[CmdletBinding()]
param(
    [ValidateSet('all', 'cloud', 'web')]
    [string]$Service = 'all'
)

# LawVerify 平台服务常驻守护脚本
# 由计划任务 LawVerifyPlatformServices 在用户登录时拉起，负责：
#   1. 启动 cloud-server (8788) 与官网 preview-server (4273)
#   2. 阻塞等待进程退出，然后自动重启
#   3. 日志写入 logs/platform/ 目录
$ErrorActionPreference = 'Stop'

$root = Split-Path $PSScriptRoot -Parent
$node = 'C:\nvm4w\nodejs\node.exe'
if (-not (Test-Path $node)) {
    $node = (Get-Command node -ErrorAction Stop).Source
}

$logDir = Join-Path $root 'logs\platform'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Write-SupervisorLog([string]$message) {
    $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $message
    Add-Content -Path (Join-Path $logDir 'supervisor.log') -Value $line -Encoding UTF8
}

function Start-ManagedProcess {
    param(
        [string]$Name,
        [string]$WorkDir,
        [string[]]$Arguments
    )

    $outLog = Join-Path $logDir "$Name.out.log"
    $errLog = Join-Path $logDir "$Name.err.log"
    foreach ($file in @($outLog, $errLog)) {
        if (Test-Path $file) {
            Copy-Item $file "$file.prev" -Force -ErrorAction SilentlyContinue
        }
    }

    $process = Start-Process -FilePath $node -ArgumentList $Arguments -WorkingDirectory $WorkDir `
        -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru
    Write-SupervisorLog "started $Name (PID=$($process.Id))"
    return $process
}

if ($Service -eq 'all') {
    $children = foreach ($name in @('cloud', 'web')) {
        Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') `
            -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', "`"$PSCommandPath`"", '-Service', $name) `
            -WorkingDirectory $root -WindowStyle Hidden -PassThru
    }
    foreach ($child in $children) { $child.WaitForExit() }
    exit 1
}

$name = if ($Service -eq 'cloud') { 'cloud-server' } else { 'preview-server' }
$workDir = if ($Service -eq 'cloud') { Join-Path $root 'cloud-server' } else { Join-Path $root 'web' }
$entry = if ($Service -eq 'cloud') { Join-Path $workDir 'dist\index.js' } else { Join-Path $workDir 'preview-server.mjs' }
$port = if ($Service -eq 'cloud') { 8788 } else { 4273 }
$arguments = if ($Service -eq 'cloud') { @($entry) } else { @($entry, '--host', '0.0.0.0', '--port', '4273', '--api-base', 'http://127.0.0.1:8788') }
$mutex = New-Object System.Threading.Mutex($false, "Local\LawVerifySupervisor-$Service")
if (-not $mutex.WaitOne(0)) { $mutex.Dispose(); exit 0 }
try {
    Write-SupervisorLog "$name supervisor starting"
    while ($true) {
        $owners = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty OwningProcess -Unique)
        $process = $null
        foreach ($ownerId in $owners) {
            $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$ownerId"
            if (!$owner -or $owner.Name -ne 'node.exe' -or !$owner.CommandLine.Contains($entry)) {
                throw "Port $port belongs to another application; recovery cancelled."
            }
            $process = Get-Process -Id $ownerId -ErrorAction Stop
        }
        if (!$process) { $process = Start-ManagedProcess -Name $name -WorkDir $workDir -Arguments $arguments }
        $started = Get-Date
        $process.WaitForExit()
        Write-SupervisorLog "$name exited (code=$($process.ExitCode)), restarting"
        if (((Get-Date) - $started).TotalSeconds -lt 5) { Start-Sleep -Seconds 5 }
    }
} finally {
    $mutex.ReleaseMutex()
    $mutex.Dispose()
}
