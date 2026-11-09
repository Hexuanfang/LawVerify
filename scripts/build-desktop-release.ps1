param(
  [switch]$Dir,
  [switch]$Signed
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$appRoot = Join-Path $repoRoot 'app'
$releaseRoot = Join-Path $appRoot 'release'
$tempOutputName = 'release-temp'
$tempReleaseRoot = Join-Path $appRoot $tempOutputName
$packageJsonPath = Join-Path $appRoot 'package.json'

function Get-CommandPath([string[]]$Names) {
  foreach ($name in $Names) {
    $command = Get-Command $name -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
  }
  throw "Command not found: $($Names -join ', ')"
}

# Editors and scanners can keep an exclusive handle on the previous build output,
# which makes electron-builder fail with EBUSY while replacing app.asar.
function Test-PathLocked([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) {
    return $false
  }
  $directory = Split-Path -Parent $Path
  $originalName = Split-Path -Leaf $Path
  $probeName = "$originalName.lockprobe"
  try {
    Rename-Item -LiteralPath $Path -NewName $probeName -ErrorAction Stop
  } catch {
    return $true
  }
  try {
    Rename-Item -LiteralPath (Join-Path $directory $probeName) -NewName $originalName -ErrorAction Stop
  } catch {
    throw "Failed to restore '$Path' after the lock probe."
  }
  return $false
}

function Copy-BuildArtifacts([string]$SourceRoot, [string]$TargetRoot) {
  $failed = New-Object System.Collections.ArrayList
  Get-ChildItem -LiteralPath $SourceRoot -File | ForEach-Object {
    try {
      Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $TargetRoot $_.Name) -Force -ErrorAction Stop
    } catch {
      [void]$failed.Add($_.Name)
    }
  }
  $sourceUnpacked = Join-Path $SourceRoot 'win-unpacked'
  if (Test-Path -LiteralPath $sourceUnpacked) {
    $targetUnpacked = Join-Path $TargetRoot 'win-unpacked'
    New-Item -ItemType Directory -Force -Path $targetUnpacked | Out-Null
    Get-ChildItem -LiteralPath $sourceUnpacked -Recurse -File | ForEach-Object {
      $relative = $_.FullName.Substring($sourceUnpacked.Length).TrimStart([char[]]@('\', '/'))
      $destination = Join-Path $targetUnpacked $relative
      $destinationDir = Split-Path -Parent $destination
      if (-not (Test-Path -LiteralPath $destinationDir)) {
        New-Item -ItemType Directory -Force -Path $destinationDir | Out-Null
      }
      try {
        Copy-Item -LiteralPath $_.FullName -Destination $destination -Force -ErrorAction Stop
      } catch {
        [void]$failed.Add($relative)
      }
    }
  }
  return $failed
}

function Invoke-DesktopBuild([string]$NpmCommand, [string]$AppRoot, [string]$TargetScript, [string]$TempOutputName) {
  if ($TempOutputName) {
    $env:LAWVERIFY_BUILDER_OUTPUT_DIR = $TempOutputName
  } else {
    $env:LAWVERIFY_BUILDER_OUTPUT_DIR = $null
  }
  Push-Location $AppRoot
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    # Native stderr output (Vite warnings, for example) must not abort the build.
    $ErrorActionPreference = 'Continue'
    & $NpmCommand run $TargetScript 2>&1 | Tee-Object -Variable captured | Out-Host
    $exitCode = $LASTEXITCODE
    return [PSCustomObject]@{
      ExitCode = $exitCode
      Output   = (($captured | ForEach-Object { $_.ToString() }) -join "`n")
    }
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
    Pop-Location
  }
}

$npmCommand = Get-CommandPath @('npm.cmd', 'npm.exe', 'npm')

if (-not (Test-Path $packageJsonPath)) {
  throw "Desktop package.json not found: $packageJsonPath"
}

$packageJson = Get-Content -Raw -Path $packageJsonPath | ConvertFrom-Json
$version = [string]$packageJson.version

$targetScript = 'build:desktop'
if ($Dir) {
  $targetScript = 'build:desktop:dir'
} elseif ($Signed) {
  $targetScript = 'build:desktop:signed'
}

$lockProbePath = Join-Path $releaseRoot 'win-unpacked\resources\app.asar'
$useTempOutput = Test-PathLocked $lockProbePath
$tempOutputArg = if ($useTempOutput) { $tempOutputName } else { '' }

Write-Host ''
Write-Host '== LawVerify Desktop Build ==' -ForegroundColor Cyan
Write-Host "Version: $version"
Write-Host "Mode: $targetScript"
Write-Host "Working dir: $appRoot"
if ($useTempOutput) {
  Write-Host "Output: $tempOutputName (release output is locked by another process)" -ForegroundColor Yellow
} else {
  Write-Host 'Output: release'
}
Write-Host ''

$startedAt = Get-Date
$build = Invoke-DesktopBuild -NpmCommand $npmCommand -AppRoot $appRoot -TargetScript $targetScript -TempOutputName $tempOutputArg

if ($build.ExitCode -ne 0 -and -not $useTempOutput -and $build.Output -match 'EBUSY') {
  Write-Host ''
  Write-Host 'Release output is locked. Rebuilding into a temporary output directory...' -ForegroundColor Yellow
  $useTempOutput = $true
  $build = Invoke-DesktopBuild -NpmCommand $npmCommand -AppRoot $appRoot -TargetScript $targetScript -TempOutputName $tempOutputName
}

if ($build.ExitCode -ne 0) {
  throw "Build failed with exit code: $($build.ExitCode)"
}

if ($useTempOutput) {
  Write-Host ''
  Write-Host '== Sync artifacts to release ==' -ForegroundColor Cyan
  $failedFiles = @(Copy-BuildArtifacts -SourceRoot $tempReleaseRoot -TargetRoot $releaseRoot)
  if ($failedFiles.Count -gt 0) {
    Write-Host ("Files that could not be copied: {0}" -f ($failedFiles -join ', ')) -ForegroundColor Yellow
    Write-Host 'Close the program locking the release folder and run the build again.' -ForegroundColor Yellow
  }
  Remove-Item -LiteralPath $tempReleaseRoot -Recurse -Force -ErrorAction SilentlyContinue
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
