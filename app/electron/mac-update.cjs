const fs = require('node:fs')
const path = require('node:path')
const { randomBytes } = require('node:crypto')
const { execFile, spawn } = require('node:child_process')
const { promisify } = require('node:util')

const exec = promisify(execFile)
const APP_ID = 'com.zhijing.lawverify'
const JOB_PATTERN = /^[a-f0-9]{32}$/

async function run(command, args) {
  return exec(command, args, { timeout: 120000, maxBuffer: 2 * 1024 * 1024, windowsHide: true })
}

function resolveInstalledBundle(execPath) {
  const bundle = path.resolve(execPath, '../../..')
  if (path.basename(bundle) !== 'LawVerify.app'
    || path.resolve(execPath) !== path.join(bundle, 'Contents', 'MacOS', 'LawVerify')) {
    throw new Error('请先将 LawVerify 安装到“应用程序”后再自动更新。')
  }
  const portablePath = bundle.replace(/\\/g, '/').replace(/^[a-z]:/i, '')
  if (portablePath.startsWith('/Volumes/') || portablePath.includes('/AppTranslocation/')) {
    throw new Error('当前正在从安装包或临时隔离目录运行，请先拖入“应用程序”并重新启动。')
  }
  if (fs.realpathSync(bundle) !== bundle || fs.lstatSync(bundle).isSymbolicLink()) {
    throw new Error('当前安装位置不支持自动更新，请使用原始应用目录。')
  }
  return bundle
}

async function verifyBundle(bundle, version, arch, channel, execute = run) {
  const info = path.join(bundle, 'Contents', 'Info.plist')
  const { stdout } = await execute('/usr/bin/plutil', ['-convert', 'json', '-o', '-', info])
  const metadata = JSON.parse(stdout)
  if (metadata.CFBundleIdentifier !== APP_ID || metadata.CFBundleShortVersionString !== version
    || metadata.CFBundleExecutable !== 'LawVerify') {
    throw new Error('更新应用的身份或版本不匹配，已保留原版本。')
  }
  const binary = path.join(bundle, 'Contents', 'MacOS', 'LawVerify')
  const architecture = await execute('/usr/bin/lipo', ['-archs', binary])
  if (!architecture.stdout.trim().split(/\s+/).includes(arch === 'x64' ? 'x86_64' : 'arm64')) {
    throw new Error('更新应用与当前 Mac 芯片不匹配。')
  }
  // Ad-hoc signatures also verify bundle integrity. No quarantine removal.
  await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle])
  if (channel === 'stable') {
    const signature = await execute('/usr/bin/codesign', ['-d', '--verbose=4', bundle])
    if (!signature.stderr.includes('Authority=Developer ID Application:')) {
      throw new Error('正式更新缺少 Apple Developer ID 签名。')
    }
    await execute('/usr/sbin/spctl', ['--assess', '--type', 'execute', bundle])
  }
}

function jobRoot(userData) { return path.join(userData, 'updates', 'mac') }

function prunePreviousBackups(userData, target) {
  const root = jobRoot(userData)
  for (const id of fs.readdirSync(root).filter(value => JOB_PATTERN.test(value))) {
    try {
      const directory = path.join(root, id)
      if (fs.readFileSync(path.join(directory, 'status'), 'utf8').trim() !== 'complete') continue
      const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'))
      const expected = path.join(path.dirname(target), `.LawVerify-previous-${id}.app`)
      if (manifest.target === target && manifest.backup === expected
        && fs.existsSync(expected) && !fs.lstatSync(expected).isSymbolicLink()) {
        fs.rmSync(expected, { recursive: true, force: true })
      }
    } catch { /* A retained backup must not prevent the next verified update. */ }
  }
}

async function prepareMacUpdate({
  installerPath, version, arch, channel, execPath, userData, execute = run,
}) {
  const target = resolveInstalledBundle(execPath)
  const parent = path.dirname(target)
  try {
    await fs.promises.access(parent, fs.constants.W_OK)
    await fs.promises.access(target, fs.constants.W_OK)
  } catch {
    throw new Error('当前应用目录没有写入权限，请将 LawVerify 安装到你有权限的“应用程序”目录后重试。')
  }
  if (!/^\d+\.\d+\.\d+$/.test(version) || !['arm64', 'x64'].includes(arch)
    || !['test', 'stable'].includes(channel)) throw new Error('无效的 Mac 更新参数。')
  const id = randomBytes(16).toString('hex')
  const directory = path.join(jobRoot(userData), id)
  const staged = path.join(parent, `.LawVerify-update-${id}.app`)
  const backup = path.join(parent, `.LawVerify-previous-${id}.app`)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const mount = path.join(directory, 'mount')
  fs.mkdirSync(mount)
  let attached = false
  try {
    await execute('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, installerPath])
    attached = true
    const source = path.join(mount, 'LawVerify.app')
    if (fs.lstatSync(source).isSymbolicLink()) throw new Error('更新包中的应用目录无效。')
    await verifyBundle(source, version, arch, channel, execute)
    await execute('/usr/bin/ditto', ['--rsrc', '--extattr', source, staged])
    await verifyBundle(staged, version, arch, channel, execute)
    // Disk-image quarantine is not necessarily copied to the mounted bundle.
    // Preserve it explicitly so LaunchServices still applies Gatekeeper policy.
    let quarantine
    try { quarantine = (await execute('/usr/bin/xattr', ['-p', 'com.apple.quarantine', installerPath])).stdout.trim() }
    catch (error) {
      if (!String(error.stderr || '').includes('No such xattr')) throw error
    }
    if (quarantine) await execute('/usr/bin/xattr', ['-w', 'com.apple.quarantine', quarantine, staged])
    await execute('/usr/bin/hdiutil', ['detach', mount])
    attached = false
    const manifest = { id, target, staged, backup, version, channel }
    fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 })
    fs.writeFileSync(path.join(directory, 'status'), 'prepared\n', { mode: 0o600 })
    const helper = path.join(directory, 'helper.sh')
    fs.copyFileSync(path.join(__dirname, 'mac-update-helper.sh'), helper)
    fs.chmodSync(helper, 0o700)
    prunePreviousBackups(userData, target)
    return { ...manifest, directory, helper }
  } catch (error) {
    if (attached) await execute('/usr/bin/hdiutil', ['detach', mount]).catch(() => {})
    fs.rmSync(staged, { recursive: true, force: true })
    fs.rmSync(directory, { recursive: true, force: true })
    throw error
  }
}

async function launchMacUpdate(job, oldPid = process.pid, { exitTimeout = 120, startupTimeout = 120 } = {}) {
  if (![exitTimeout, startupTimeout].every(value => Number.isInteger(value) && value >= 1 && value <= 120)) {
    throw new Error('Invalid update timeout')
  }
  const child = spawn('/bin/bash', [
    job.helper, job.directory, job.target, job.staged, job.backup, String(oldPid), job.id,
    String(exitTimeout), String(startupTimeout),
  ], { detached: true, stdio: 'ignore', env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: process.env.HOME } })
  let failure
  child.on('error', error => { failure = error })
  child.unref()
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (failure) {
      fs.writeFileSync(path.join(job.directory, 'cancel-request'), 'cancel\n')
      throw failure
    }
    try {
      if (fs.readFileSync(path.join(job.directory, 'helper-ready'), 'utf8').trim() === job.id) return
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  // The helper must see the old process exit before replacing anything.
  fs.writeFileSync(path.join(job.directory, 'cancel-request'), 'cancel\n')
  child.kill('SIGTERM')
  throw new Error('自动更新进程未能启动，原版本保持不变。')
}

function readStartupJob({ userData, execPath, version, argv = process.argv }) {
  const id = argv.find(arg => arg.startsWith('--lawverify-update-job='))?.split('=')[1]
  if (!id || !JOB_PATTERN.test(id)) return null
  const directory = path.join(jobRoot(userData), id)
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'))
    if (manifest.id !== id || manifest.version !== version || !path.isAbsolute(manifest.target)
      || path.basename(manifest.target) !== 'LawVerify.app'
      || manifest.staged !== path.join(path.dirname(manifest.target), `.LawVerify-update-${id}.app`)
      || manifest.backup !== path.join(path.dirname(manifest.target), `.LawVerify-previous-${id}.app`)
      || fs.realpathSync(directory) !== directory
      || fs.readFileSync(path.join(directory, 'status'), 'utf8').trim() !== 'restarting') return null
    let eligible = false
    try { eligible = manifest.target === resolveInstalledBundle(execPath) } catch {}
    // Record the new PID even if Gatekeeper translocated it, so rollback can
    // stop that process before restoring the original installed bundle.
    return { id, directory, eligible }
  } catch { return null }
}

function acknowledgeMacUpdate(job, ready = false) {
  if (!job) return
  fs.writeFileSync(path.join(job.directory, ready ? 'startup-ok' : 'new-pid'),
    `${ready ? job.id : process.pid}\n`, { mode: 0o600 })
}

function getMacUpdateResult(userData, consume = false) {
  const root = jobRoot(userData)
  try {
    const jobs = fs.readdirSync(root).filter(id => JOB_PATTERN.test(id)).map(id => {
      const directory = path.join(root, id)
      const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'))
      const status = fs.readFileSync(path.join(directory, 'status'), 'utf8').trim()
      return { directory, version: manifest.version, status, time: fs.statSync(path.join(directory, 'status')).mtimeMs }
    }).sort((a, b) => b.time - a.time)
    const latest = jobs[0]
    if (!latest || !['complete', 'rolled-back', 'failed', 'cancelled'].includes(latest.status)) return null
    if (consume && fs.existsSync(path.join(latest.directory, 'result-seen'))) return null
    const message = latest.status === 'complete' ? `已自动更新至 v${latest.version}。`
      : latest.status === 'rolled-back' ? '新版未能正常启动，已恢复原版本。请检查 macOS 安全提示后重试。'
        : latest.status === 'cancelled' ? '更新已取消，原版本未更改。'
          : '自动更新未完成，旧版备份已保留。请从官网下载并安装。'
    if (consume) fs.writeFileSync(path.join(latest.directory, 'result-seen'), 'seen\n', { mode: 0o600 })
    return { status: latest.status === 'complete' ? 'ready' : 'error', message }
  } catch { return null }
}

module.exports = {
  resolveInstalledBundle, verifyBundle, prepareMacUpdate, launchMacUpdate,
  readStartupJob, acknowledgeMacUpdate, getMacUpdateResult,
}
