param(
  [switch]$NoVersionBump,
  [switch]$KeepTemp
)

# One-shot LawVerify desktop EXE builder.
# Increments the patch version (unless -NoVersionBump), builds frontend/server,
# bundles the default law library, packages the NSIS installer into a temp output
# dir (avoids the app.asar EBUSY lock on app\release), copies the Setup exe into
# app\release (old versions are kept), then cleans up the temp dir.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# .trae/skills/<name>/scripts -> repo root (4 levels up)
$repoRoot = $PSScriptRoot | Split-Path -Parent | Split-Path -Parent | Split-Path -Parent | Split-Path -Parent
$appRoot = Join-Path $repoRoot 'app'
$packageJsonPath = Join-Path $appRoot 'package.json'

if (-not (Test-Path $packageJsonPath)) { throw "Desktop package.json not found: $packageJsonPath" }
if (-not (Get-Command 'npm.cmd' -ErrorAction SilentlyContinue)) { throw 'npm.cmd not found. Please install Node.js and npm first.' }

function Resolve-App-Version {
  param($VersionString)
  $parts = ($VersionString -split '\.')
  if ($parts.Count -lt 3) { throw "Unexpected version format: $VersionString" }
  $major = [int]$parts[0]
  $minor = [int]$parts[1]
  $patch = [int]$parts[2] + 1
  return "$major.$minor.$patch"
}

$packageJson = Get-Content -Raw -Path $packageJsonPath | ConvertFrom-Json
$oldVersion = [string]$packageJson.version
$newVersion = $oldVersion
if (-not $NoVersionBump) {
  $newVersion = Resolve-App-Version $oldVersion
  $packageJson.version = $newVersion
  # Write back WITHOUT BOM (PowerShell 5 Set-Content -Encoding UTF8 adds a BOM
  # that breaks vite.config.ts / Node JSON.parse). Use UTF8Encoding(false).
  $jsonOut = $packageJson | ConvertTo-Json -Depth 100
  [System.IO.File]::WriteAllText($packageJsonPath, $jsonOut + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))
}

$tempOut = Join-Path $appRoot ("release-$newVersion")
if (Test-Path $tempOut) {
  Start-Sleep -Milliseconds 500
  Remove-Item $tempOut -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host '== LawVerify EXE Build ==' -ForegroundColor Cyan
Write-Host "Version: $oldVersion -> $newVersion"
Write-Host "Repo: $repoRoot"
Write-Host ''

Push-Location $appRoot
try {
  $steps = @('build', 'build:server', 'prepare:desktop', 'prepare:builder-cache')
  foreach ($step in $steps) {
    Write-Host "== npm run $step ==" -ForegroundColor Yellow
    & 'npm.cmd' run $step
    if ($LASTEXITCODE -ne 0) { throw "Step '$step' failed with exit code $LASTEXITCODE" }
  }

  Write-Host '== electron-builder (temp out dir) ==' -ForegroundColor Yellow
  & 'node.exe' 'electron/run-electron-builder.cjs' --publish never --win nsis "--config.directories.output=$tempOut"
  if ($LASTEXITCODE -ne 0) { throw "electron-builder failed with exit code $LASTEXITCODE" }
} finally {
  Pop-Location
}

$builtExe = Join-Path $tempOut "LawVerify-Setup-$newVersion.exe"
if (-not (Test-Path $builtExe)) { throw "Build finished but Setup exe not found: $builtExe" }

$releaseRoot = Join-Path $appRoot 'release'
if (-not (Test-Path $releaseRoot)) { New-Item -ItemType Directory -Path $releaseRoot | Out-Null }
Copy-Item -Path $builtExe -Destination $releaseRoot -Force

if (-not $KeepTemp) {
  Start-Sleep -Milliseconds 500
  Remove-Item $tempOut -Recurse -Force -ErrorAction SilentlyContinue
}

$artifact = Get-Item (Join-Path $releaseRoot "LawVerify-Setup-$newVersion.exe")
Write-Host ''
Write-Host '== Build Complete ==' -ForegroundColor Green
Write-Host "New version : $newVersion"
Write-Host "Artifact    : $($artifact.FullName)"
Write-Host ("Size        : {0:N2} MB" -f ($artifact.Length / 1MB))
Write-Host 'Old versions in app\release are kept (not deleted).'
Write-Host ''