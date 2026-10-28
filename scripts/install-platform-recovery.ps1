[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$script = Join-Path $PSScriptRoot 'platform-dev.ps1'
$powershell = Join-Path $PSHOME 'powershell.exe'
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
# Child services must outlive the short recovery check.
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$action = New-ScheduledTaskAction -Execute $powershell `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`" ensure" `
  -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'LawVerify-Platform-Recovery' -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal -Force | Out-Null

# The login task and periodic recovery use the same idempotent entry point.
$loginTrigger = New-ScheduledTaskTrigger -AtLogOn -User $user
Register-ScheduledTask -TaskName 'LawVerify-Platform-Autostart' -Action $action -Trigger $loginTrigger `
  -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName 'LawVerify-Platform-Recovery'
Write-Output 'Platform recovery installed: one-minute checks, battery-safe, manual stop respected.'
