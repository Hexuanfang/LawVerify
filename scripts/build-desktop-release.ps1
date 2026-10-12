param(
  [switch]$Dir,
  [switch]$Signed
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$appRoot = Join-Path $repoRoot 'app'
$releaseRoot = Join-Path $appRoot 'release'
$packageJsonPath = Join-Path $appRoot 'package.json'
$npmCommand = 'npm.cmd'

if (-not (Test-Path $packageJsonPath)) {
  throw "Desktop package.json not found: $packageJsonPath"
}

if (-not (Get-Command $npmCommand -ErrorAction SilentlyContinue)) {
  throw 'npm.cmd not found. Please install Node.js and npm first.'
}

$packageJson = Get-Content -Raw -Path $packageJsonPath | ConvertFrom-Json
$version = [string]$packageJson.version

$targetScript = 'build:desktop'
if ($Dir) {
  $targetScript = 'build:desktop:dir'
} elseif ($Signed) {
  $targetScript = 'build:desktop:signed'
}

Write-Host ''
Write-Host '== LawVerify Desktop Build ==' -ForegroundColor Cyan
Write-Host "Version: $version"
Write-Host "Mode: $targetScript"
Write-Host "Working dir: $appRoot"
Write-Host ''

$startedAt = Get-Date
Push-Location $appRoot
try {
  & $npmCommand run $targetScript
  if ($LASTEXITCODE -ne 0) {
    throw "Build failed with exit code: $LASTEXITCODE"
  }
} finally {
  Pop-Location
}

$duration = (Get-Date) - $startedAt

if ($Dir) {
  $artifactPath = Join-Path $releaseRoot 'win-unpacked\LawVerify.exe'
} else {
  $artifactPath = Join-Path $releaseRoot "LawVerify-Setup-$version.exe"
}

if (-not (Test-Path $artifactPath)) {
  throw "Build finished but artifact was not found: $artifactPath"
}

$artifact = Get-Item $artifactPath

Write-Host ''
Write-Host '== Build Complete ==' -ForegroundColor Green
Write-Host "Artifact: $($artifact.FullName)"
Write-Host ("Size: {0:N2} MB" -f ($artifact.Length / 1MB))
Write-Host "Elapsed: $([int][Math]::Round($duration.TotalMinutes, 0)) min $($duration.Seconds) sec"
Write-Host ''
Write-Host 'Minimal reusable actions:'
Write-Host '1. Double-click build-desktop.cmd at repo root'
Write-Host '2. Or run .\build-desktop.cmd'
Write-Host '3. Directory build: .\build-desktop.cmd -Dir'
Write-Host '4. Signed build: .\build-desktop.cmd -Signed'
