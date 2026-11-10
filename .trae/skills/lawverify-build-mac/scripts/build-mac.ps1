param(
  [switch]$Signed,
  [switch]$SignedOnly,
  [switch]$Push,
  [switch]$KeepDownloads,
  [string]$Ref,
  [string]$ResumeRunId
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
$remoteNames = @(& git remote)
$remoteName = if ($remoteNames -contains 'origin') { 'origin' } elseif ($remoteNames -contains 'github') { 'github' } else { throw 'No origin or github remote configured.' }
$workflowName = 'mac-desktop.yml'
if ($Signed -and $SignedOnly) { throw 'Choose -Signed or -SignedOnly, not both.' }
if ($ResumeRunId -and (-not $Signed -or $SignedOnly -or $ResumeRunId -notmatch '^\d+$')) {
  throw '-ResumeRunId requires -Signed and a numeric GitHub run ID. Use the same source commit as that run.'
}

if (-not (Test-Path $packageJsonPath)) { throw "Desktop package.json not found: $packageJsonPath" }
if (-not (Get-Command 'git' -ErrorAction SilentlyContinue)) { throw 'git not found on PATH.' }
if (-not (Get-Command 'gh' -ErrorAction SilentlyContinue)) { throw 'gh CLI not found. Install it (winget install GitHub.cli) and run "gh auth login" first.' }

function Invoke-Checked {
  param([Parameter(Mandatory = $true)][string]$Command, [string[]]$Args, [string]$WorkingDir = $repoRoot)
  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $output = & $Command @Args 2>&1 | ForEach-Object { "$_" }
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
  }
  if ($exitCode -ne 0) {
    throw "Command failed ($exitCode): $Command $($Args -join ' ')`n$($output -join "`n")"
  }
  return $output
}

$packageJson = Get-Content -Raw -Path $packageJsonPath | ConvertFrom-Json
$version = [string]$packageJson.version

Write-Host ''
Write-Host '== LawVerify Mac Build (GitHub Actions) ==' -ForegroundColor Cyan
Write-Host "Version   : $version"
Write-Host "Signed    : $Signed"
Write-Host "SignedOnly: $SignedOnly"
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
if ($Ref) {
  if ($Push) { throw '-Ref cannot be combined with -Push. Push the selected branch deliberately first.' }
  $head = (Invoke-Checked 'git' @('rev-parse', 'HEAD') | Select-Object -First 1).Trim()
  $refInfo = (Invoke-Checked 'gh' @('api', "repos/$repoSlug/commits/$Ref", '--jq', '.sha') | Select-Object -First 1).Trim()
  if ($refInfo -ne $head) { throw "Selected remote ref $Ref does not match local HEAD $head." }
  Write-Host "[ok] pinned remote ref $Ref => $head"
} else {
$division = (& 'git' 'rev-list' '--left-right' '--count' "$remoteName/$branch...HEAD" 2>&1)
if ($LASTEXITCODE -ne 0) {
  Write-Host "[warn] Cannot compare with $remoteName/$branch (branch may be untracked). Trusting -Push flag." -ForegroundColor Yellow
} else {
  $parts = "$division" -split '\s+'
  $behind = [int]$parts[0]
  $ahead = if ($parts.Count -gt 1) { [int]$parts[1] } else { 0 }
  if ($behind -gt 0) {
    throw "Local branch is $behind commit(s) BEHIND $remoteName/$branch. Run 'git pull --rebase' first."
  }
  if ($ahead -gt 0 -and -not $Push) {
    throw "Local branch is $ahead commit(s) AHEAD of $remoteName/$branch. Pass -Push to push, or push manually."
  }
}
if ($Push) {
  Write-Host 'Pushing branch to origin...'
  Invoke-Checked 'git' @('push', $remoteName, $branch)
  Start-Sleep -Seconds 2
}
}

# -- trigger ----------------------------------------------------------------
$signedFlag = if ($Signed -or $SignedOnly) { 'true' } else { 'false' }
Write-Host "Triggering workflow $workflowName (signed=$signedFlag)..."
$triggerArgs = @('workflow', 'run', $workflowName, '--repo', $repoSlug, '-f', "signed=$signedFlag")
if ($SignedOnly) { $triggerArgs += @('-f', 'signed_only=true') }
if ($ResumeRunId) { $triggerArgs += @('-f', "resume_run_id=$ResumeRunId") }
if ($Ref) { $triggerArgs += @('--ref', $Ref) }
$trigger = Invoke-Checked 'gh' $triggerArgs
Write-Host ($trigger -join "`n")

# -- wait for the newest run of this workflow ------------------------------
Start-Sleep -Seconds 6
$listArgs = @('run', 'list', '--workflow', $workflowName, '--repo', $repoSlug, '--limit', '1', '--json', 'databaseId,status,conclusion,headBranch')
if ($Ref) { $listArgs += @('--branch', $Ref) }
$runInfo = (Invoke-Checked 'gh' $listArgs | Out-String | ConvertFrom-Json)
if (-not $runInfo -or -not $runInfo.databaseId) { throw 'Could not find the triggered workflow run.' }
$runId = $runInfo.databaseId
Write-Host "Watching run #$runId (branch=$($runInfo.headBranch), status=$($runInfo.status))..."
Invoke-Checked 'gh' @('run', 'watch', $runId, '--repo', $repoSlug, '--exit-status', '--interval', '30')

$runFinal = (Invoke-Checked 'gh' @('run', 'view', $runId, '--repo', $repoSlug, '--json', 'conclusion') | Out-String | ConvertFrom-Json)
if ($runFinal.conclusion -ne 'success') { throw "Workflow run #$runId ended with '$($runFinal.conclusion)'. See: gh run view $runId --repo $repoSlug" }

# -- download ---------------------------------------------------------------
$destDir = Join-Path $appRoot ($(if ($SignedOnly) { 'release-mac-signed-only' } elseif ($Signed) { 'release-mac' } else { 'release-mac-unsigned' }))
$destDir = Join-Path $destDir "$version-run-$runId"
if (-not (Test-Path $destDir)) { New-Item -ItemType Directory -Path $destDir | Out-Null }
Write-Host "Downloading artifacts to $destDir ..."
$artifactSuffix = if ($SignedOnly) { 'signed-only' } elseif ($Signed) { 'signed' } else { 'unsigned' }
Invoke-Checked 'gh' @('run', 'download', $runId, '--repo', $repoSlug, '--dir', $destDir,
  '--pattern', "LawVerify-Mac-*-$artifactSuffix")

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
Write-Host "Version   : $version (signed=$($Signed -or $SignedOnly), signed-only=$SignedOnly)"
Write-Host "Artifacts : $destDir"
$reports | Format-Table -AutoSize
if ($SignedOnly) {
  Write-Host 'Signed-only packages are not notarized or validated. macOS Gatekeeper may block them.'
} elseif (-not $Signed) {
  Write-Host 'Note: unsigned test packages must be allowed manually in macOS Settings > Privacy & Security on first launch.'
}
