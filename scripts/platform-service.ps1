# LawVerify 平台服务常驻守护脚本
# 由计划任务 LawVerifyPlatformServices 在用户登录时拉起，负责：
#   1. 启动 cloud-server (8788) 与官网 preview-server (4273)
#   2. 进程退出或健康检查失败时自动重启
#   3. 日志写入 logs/platform/ 目录
$ErrorActionPreference = 'Continue'

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

function Test-CloudHealthy {
    try {
        $response = Invoke-WebRequest -Uri 'http://127.0.0.1:8788/api/web/site/config' -UseBasicParsing -TimeoutSec 5
        return $response.StatusCode -eq 200
    } catch {
        return $false
    }
}

function Start-CloudServer {
    return Start-ManagedProcess -Name 'cloud-server' -WorkDir (Join-Path $root 'cloud-server') -Arguments @('dist\index.js')
}

function Start-PreviewServer {
    return Start-ManagedProcess -Name 'preview-server' -WorkDir (Join-Path $root 'web') -Arguments @('preview-server.mjs', '--host', '0.0.0.0', '--port', '4273', '--api-base', 'http://127.0.0.1:8788')
}

Write-SupervisorLog '=== supervisor starting ==='

$cloud = Start-CloudServer
$preview = Start-PreviewServer
$lastHealthProbe = Get-Date

while ($true) {
    Start-Sleep -Seconds 10

    if ($cloud.HasExited) {
        Write-SupervisorLog "cloud-server exited (code=$($cloud.ExitCode)), restarting"
        $cloud = Start-CloudServer
    } elseif (((Get-Date) - $lastHealthProbe).TotalSeconds -ge 60) {
        $lastHealthProbe = Get-Date
        if (-not (Test-CloudHealthy)) {
            Write-SupervisorLog 'cloud-server health check failed, restarting'
            Stop-Process -Id $cloud.Id -Force -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 2
            $cloud = Start-CloudServer
        }
    }

    if ($preview.HasExited) {
        Write-SupervisorLog "preview-server exited (code=$($preview.ExitCode)), restarting"
        $preview = Start-PreviewServer
    }
}
