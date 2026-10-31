param(
  [switch]$Signed,
  [switch]$Push,
  [switch]$KeepDownloads
)

# One-shot LawVerify macOS builder (via GitHub Actions mac-desktop.yml).
# Windows cannot produce a mac DMG locally, so this script:
#   1) checks git / gh / auth / remote / worktree state,
#   2) (optionally) pushes the local commits to origin,
#   3) triggers the mac-desktop.yml workflow_dispatch,
#   4) waits for the run to finish,
#   5) downloads artifacts into app\release-mac-unsigned (or -mac when signed),
#   6) re-hashes every dmg/zip and compares against the published .sha256 files.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = $PSScriptRoot | Split-Path -Parent | Split-Path -Parent | Split-Path -Parent | Split-Path -Parent
$appRoot = Join-Path $repoRoot 'app'
$packageJsonPath = Join-Path $appRoot 'package.json'
$remoteName = 'origin'
$workflowName = 'mac-desktop.yml'

if (-not (Test-Path $packageJsonPath)) { throw "Desktop package.json not found: $packageJsonPath" }
if (-not (Get-Command 'git' -ErrorAction SilentlyContinue)) { throw 'git not found on PATH.' }
if (-not (Get-Command 'gh' -ErrorAction SilentlyContinue)) { throw 'gh CLI not found. Install it (winget install GitHub.cli) and run "gh auth login" first.' }

function Invoke-Checked {
  param([Parameter(Mandatory = $true)][string]$Command, [string[]]$Args, [string]$WorkingDir = $repoRoot)
  $output = & $Command @Args 2>&1 | ForEach-Object { "$_" }
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed ($LASTEXITCODE): $Command $($Args -join ' ')`n$($output -join "`n")"
  }
  return $output
}

$packageJson = Get-Content -Raw -Path $packageJsonPath | ConvertFrom-Json
$version = [string]$packageJson.version

Write-Host ''
Write-Host '== LawVerify Mac Build (GitHub Actions) ==' -ForegroundColor Cyan
Write-Host "Version   : $version"
Write-Host "Signed    : $Signed"
Write-Host "RepoRoot  : $repoRoot"
Write-Host ''

# -- gh auth ----------------------------------------------------------------
$ghAuth = & 'gh' 'auth' 'status' 2>&1 | ForEach-Object { "$_" }
if ($LASTEXITCODE -ne 0) {
  throw "gh is not authenticated. Run 'gh auth login' first.`n$($ghAuth -join "`n")"
}
Write-Host ('[ok] gh authenticated')

# -- remote -----------------------------------------------------------------
$remoteUrl = (Invoke-Checked 'git' @('remote', 'get-url', $remoteName) | Select-Object -First 1).Trim()
if ($remoteUrl -notmatch 'github.com[/:]([^/]+)/([^/.]+)') {
  throw "Cannot parse GitHub owner/repo from remote URL: $remoteUrl"
}
$owner = $Matches[1]
$repository = $Matches[2]
$repoSlug = "$owner/$repository"
Write-Host "[ok] remote => $repoSlug"

# -- worktree ---------------------------------------------------------------
$status = @(Invoke-Checked 'git' @('status', '--porcelain'))
if ($status.Count -gt 0) {
  Write-Host '[warn] Local working tree has changes. GitHub Actions builds the PUSHED remote code,'
  Write-Host '       so uncommitted changes will NOT be part of the mac package.'
  Write-Host '       If you want them included, commit first (a manual, deliberate step).' -ForegroundColor Yellow
}

$branch = (Invoke-Checked 'git' @('rev-parse', '--abbrev-ref', 'HEAD') | Select-Object -First 1).Trim()
$division = (& 'git' 'rev-list' '--left-right' '--count' "origin/$branch...HEAD" 2>&1)
if ($LASTEXITCODE -ne 0) {
  Write-Host "[warn] Cannot compare with origin/$branch (branch may be untracked). Trusting -Push flag." -ForegroundColor Yellow
} else {
  $parts = "$division" -split '\s+'
  $behind = [int]$parts[0]
  $ahead = if ($parts.Count -gt 1) { [int]$parts[1] } else { 0 }
  if ($behind -gt 0) {
    throw "Local branch is $behind commit(s) BEHIND origin/$branch. Run 'git pull --rebase' first."
  }
  if ($ahead -gt 0 -and -not $Push) {
    throw "Local branch is $ahead commit(s) AHEAD of origin/$branch. Pass -Push to push, or push manually."
  }
}
if ($Push) {
  Write-Host 'Pushing branch to origin...'
  Invoke-Checked 'git' @('push', $remoteName, $branch)
  Start-Sleep -Seconds 2
}

# -- trigger ----------------------------------------------------------------
$signedFlag = if ($Signed) { 'true' } else { 'false' }
Write-Host "Triggering workflow $workflowName (signed=$signedFlag)..."
$trigger = Invoke-Checked 'gh' @('workflow', 'run', $workflowName, '--repo', $repoSlug, '-f', "signed=$signedFlag")
Write-Host ($trigger -join "`n")

# -- wait for the newest run of this workflow ------------------------------
Start-Sleep -Seconds 6
$runInfo = (Invoke-Checked 'gh' @('run', 'list', '--workflow', $workflowName, '--repo', $repoSlug, '--limit', '1', '--json', 'databaseId,status,conclusion,headBranch') | Out-String | ConvertFrom-Json)
if (-not $runInfo -or -not $runInfo.databaseId) { throw 'Could not find the triggered workflow run.' }
$runId = $runInfo.databaseId
Write-Host "Watching run #$runId (branch=$($runInfo.headBranch), status=$($runInfo.status))..."
Invoke-Checked 'gh' @('run', 'watch', $runId, '--repo', $repoSlug, '--exit-status')

$runFinal = (Invoke-Checked 'gh' @('run', 'view', $runId, '--repo', $repoSlug, '--json', 'conclusion') | Out-String | ConvertFrom-Json)
if ($runFinal.conclusion -ne 'success') { throw "Workflow run #$runId ended with '$($runFinal.conclusion)'. See: gh run view $runId --repo $repoSlug" }

# -- download ---------------------------------------------------------------
$destDir = Join-Path $appRoot ($(if ($Signed) { 'release-mac' } else { 'release-mac-unsigned' }))
if (-not (Test-Path $destDir)) { New-Item -ItemType Directory -Path $destDir | Out-Null }
Write-Host "Downloading artifacts to $destDir ..."
Invoke-Checked 'gh' @('run', 'download', $runId, '--repo', $repoSlug, '--dir', $destDir)

# Flatten artifact subfolders (LawVerify-Mac-arm64-unsigned/, ...-) into dest root.
$artifactFiles = Get-ChildItem -Path $destDir -Recurse -File | Where-Object { $_.Extension -in @('.dmg', '.zip', '.sha256', '.json') }
foreach ($file in $artifactFiles) {
  if ($file.DirectoryName -ne $destDir) {
    $target = Join-Path $destDir $file.Name
    $n = 1
    while (Test-Path $target) {
      $target = Join-Path $destDir ("{0}.{1}{2}" -f $file.BaseName, $n, $file.Extension)
      $n++
    }
    Move-Item -Path $file.FullName -Destination $target -Force
  }
}
if (-not $KeepDownloads) {
  Get-ChildItem -Path $destDir -Directory | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}

# -- verify sha256 ----------------------------------------------------------
$reports = @()
$failCount = 0
foreach ($file in Get-ChildItem -Path $destDir -File | Where-Object { $_.Extension -in @('.dmg', '.zip') }) {
  $expectedFile = Join-Path $destDir "$($file.Name).sha256"
  if (-not (Test-Path $expectedFile)) {
    Write-Host "[warn] Missing .sha256 for $($file.Name)" -ForegroundColor Yellow
    $failCount++
    continue
  }
  $expected = ((Get-Content $expectedFile -Raw) -split '\s+')[0].ToLowerInvariant()
  $actual = (Get-FileHash -Path $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  $ok = $actual -eq $expected
  if (-not $ok) { $failCount++ }
  Write-Host ("SHA256 [{0}] {1}" -f $($(if ($ok) { 'OK' } else { 'FAIL' })), $file.Name) -ForegroundColor $(if ($ok) { 'Green' } else { 'Red' })
  $reports += [pscustomobject]@{ File = $file.Name; SizeMB = [math]::Round($file.Length / 1MB, 2); Sha256 = $actual; Match = $ok }
}
if ($failCount -gt 0) { throw "$failCount artifact hash(es) failed to verify." }

Write-Host ''
Write-Host '== Mac Build Complete ==' -ForegroundColor Green
Write-Host "Version   : $version (signed=$Signed)"
Write-Host "Artifacts : $destDir"
$reports | Format-Table -AutoSize
Write-Host 'Note: unsigned test packages must be allowed manually in macOS Settings > Privacy & Security on first launch.'
