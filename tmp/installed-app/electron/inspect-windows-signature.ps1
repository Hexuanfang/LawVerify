[CmdletBinding()]
param(
  [string]$InstallerPath,
  [switch]$RequireValid
)

$ErrorActionPreference = 'Stop'

function Resolve-InstallerPath {
  param(
    [string]$ExplicitPath
  )

  if ($ExplicitPath) {
    return (Resolve-Path -Path $ExplicitPath).Path
  }

  $appRoot = Split-Path -Parent $PSScriptRoot
  $releaseDir = Join-Path $appRoot 'release'

  if (!(Test-Path $releaseDir)) {
    throw "Release directory not found: $releaseDir"
  }

  $latest = Get-ChildItem -Path $releaseDir -Filter 'LawVerify-Setup-*.exe' -File |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

  if (!$latest) {
    throw "No installer found under $releaseDir"
  }

  return $latest.FullName
}

$resolvedInstallerPath = Resolve-InstallerPath -ExplicitPath $InstallerPath
$installer = Get-Item -Path $resolvedInstallerPath
$signature = Get-AuthenticodeSignature -FilePath $resolvedInstallerPath
$versionInfo = $installer.VersionInfo
$statusMessage = if ($signature.Status -eq [System.Management.Automation.SignatureStatus]::NotSigned) {
  'Current installer is not digitally signed.'
} else {
  $signature.StatusMessage
}

$signerSubject = if ($signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { 'UNSIGNED' }
$signerThumbprint = if ($signature.SignerCertificate) { $signature.SignerCertificate.Thumbprint } else { '' }
$timestampSubject = if ($signature.TimeStamperCertificate) { $signature.TimeStamperCertificate.Subject } else { '' }

Write-Host "Installer: $($installer.FullName)"
Write-Host "Size: $([math]::Round($installer.Length / 1MB, 2)) MB"
Write-Host "File version: $($versionInfo.FileVersion)"
Write-Host "Product version: $($versionInfo.ProductVersion)"
Write-Host "Signature status: $($signature.Status)"
Write-Host "Status message: $statusMessage"
Write-Host "Publisher: $signerSubject"

if ($signerThumbprint) {
  Write-Host "Thumbprint: $signerThumbprint"
}

if ($timestampSubject) {
  Write-Host "Timestamp: $timestampSubject"
} else {
  Write-Host 'Timestamp: MISSING'
}

if ($RequireValid -and $signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
  throw "Signature is not valid: $($signature.Status)"
}
