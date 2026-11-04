const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawnSync } = require('node:child_process')
const {
  resolveInstalledBundle, verifyBundle, prepareMacUpdate, readStartupJob, getMacUpdateResult,
} = require('./mac-update.cjs')

const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash'
const posix = value => value.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_match, drive) => `/${drive.toLowerCase()}`)

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lawverify-mac-auto-')))
  const target = path.join(root, 'LawVerify.app')
  fs.mkdirSync(path.join(target, 'Contents', 'MacOS'), { recursive: true })
  fs.writeFileSync(path.join(target, 'marker'), 'old')
  return { root, target, execPath: path.join(target, 'Contents', 'MacOS', 'LawVerify') }
}

test('bundle validation checks identity, chip and ad-hoc integrity without disabling Gatekeeper', async () => {
  const calls = []
  const execute = async (command, args) => {
    calls.push({ command, args })
    if (command.endsWith('plutil')) return { stdout: JSON.stringify({
      CFBundleIdentifier: 'com.zhijing.lawverify', CFBundleShortVersionString: '0.1.60', CFBundleExecutable: 'LawVerify',
    }) }
    if (command.endsWith('lipo')) return { stdout: 'arm64\n' }
    return { stdout: '', stderr: '' }
  }
  await verifyBundle('/Applications/LawVerify.app', '0.1.60', 'arm64', 'test', execute)
  assert.ok(calls.some(call => call.command.endsWith('codesign') && call.args.includes('--verify')))
  assert.ok(!calls.some(call => call.command.endsWith('spctl')))
  await assert.rejects(verifyBundle('/Applications/LawVerify.app', '0.1.60', 'x64', 'test', execute), /芯片/)
  await assert.rejects(verifyBundle('/Applications/LawVerify.app', '0.1.59', 'arm64', 'test', execute), /版本/)
  await assert.rejects(verifyBundle('/Applications/LawVerify.app', '0.1.60', 'arm64', 'stable', execute), /Developer ID/)
  assert.ok(!calls.some(call => call.args.includes('--master-disable') || call.args.includes('--remove-signature')))
})

test('non-installed and translocated apps are refused before any mutation', () => {
  assert.throws(() => resolveInstalledBundle('/tmp/not-an-app'), /应用程序/)
  assert.throws(() => resolveInstalledBundle('/Volumes/Installer/LawVerify.app/Contents/MacOS/LawVerify'), /安装包/)
  assert.throws(() => resolveInstalledBundle('/private/tmp/AppTranslocation/test/LawVerify.app/Contents/MacOS/LawVerify'), /隔离/)
})

test('preparation stages on the same filesystem, verifies twice and preserves quarantine', async () => {
  const item = fixture()
  const calls = []
  try {
    const job = await prepareMacUpdate({
      installerPath: path.join(item.root, 'installer.dmg'), execPath: item.execPath, userData: path.join(item.root, 'profile'),
      version: '0.1.60', arch: 'arm64', channel: 'test',
      execute: async (command, args) => {
        calls.push({ command, args })
        if (command.endsWith('hdiutil') && args[0] === 'attach') {
          const mount = args[args.indexOf('-mountpoint') + 1]
          fs.mkdirSync(path.join(mount, 'LawVerify.app', 'Contents', 'MacOS'), { recursive: true })
        }
        if (command.endsWith('plutil')) return { stdout: JSON.stringify({
          CFBundleIdentifier: 'com.zhijing.lawverify', CFBundleShortVersionString: '0.1.60', CFBundleExecutable: 'LawVerify',
        }) }
        if (command.endsWith('lipo')) return { stdout: 'arm64' }
        if (command.endsWith('ditto')) fs.cpSync(args.at(-2), args.at(-1), { recursive: true })
        if (command.endsWith('xattr') && args[0] === '-p') return { stdout: '0081;test;download;\n' }
        return { stdout: '', stderr: '' }
      },
    })
    assert.equal(path.dirname(job.staged), path.dirname(item.target))
    assert.equal(path.dirname(job.backup), path.dirname(item.target))
    assert.equal(fs.readFileSync(path.join(item.target, 'marker'), 'utf8'), 'old')
    assert.equal(calls.filter(call => call.command.endsWith('codesign')).length, 2)
    assert.ok(calls.some(call => call.command.endsWith('xattr') && call.args[0] === '-w'))
    assert.ok(!calls.some(call => call.command.endsWith('xattr') && call.args[0] === '-d'))
    fs.writeFileSync(path.join(job.directory, 'status'), 'restarting')
    assert.equal(readStartupJob({ userData: path.join(item.root, 'profile'), execPath: item.execPath,
      version: '0.1.60', argv: [`--lawverify-update-job=${job.id}`] }).id, job.id)
    assert.equal(readStartupJob({ userData: path.join(item.root, 'profile'),
      execPath: '/private/tmp/AppTranslocation/test/LawVerify.app/Contents/MacOS/LawVerify',
      version: '0.1.60', argv: [`--lawverify-update-job=${job.id}`] }).eligible, false)
    assert.equal(readStartupJob({ userData: path.join(item.root, 'profile'), execPath: item.execPath,
      version: '0.1.59', argv: [`--lawverify-update-job=${job.id}`] }), null)
    fs.writeFileSync(path.join(job.directory, 'status'), 'rolled-back')
    assert.match(getMacUpdateResult(path.join(item.root, 'profile')).message, /恢复原版本/)
    assert.ok(getMacUpdateResult(path.join(item.root, 'profile'), true))
    assert.equal(getMacUpdateResult(path.join(item.root, 'profile'), true), null)
    assert.equal(readStartupJob({ userData: item.root, execPath: item.execPath,
      version: '0.1.60', argv: ['--lawverify-update-job=../../escape'] }), null)
  } finally { fs.rmSync(item.root, { recursive: true, force: true }) }
})

test('failed staging detaches the image and leaves the old application untouched', async () => {
  const item = fixture()
  const calls = []
  try {
    await assert.rejects(prepareMacUpdate({
      installerPath: '/tmp/fixture.dmg', execPath: item.execPath, userData: path.join(item.root, 'profile'),
      version: '0.1.60', arch: 'arm64', channel: 'test',
      execute: async (command, args) => {
        calls.push({ command, args })
        if (command.endsWith('hdiutil') && args[0] === 'attach') {
          fs.mkdirSync(path.join(args[args.indexOf('-mountpoint') + 1], 'LawVerify.app'))
          return { stdout: '' }
        }
        if (command.endsWith('hdiutil') && args[0] === 'detach') return { stdout: '' }
        throw new Error('Integrity verification failed')
      },
    }), /Integrity/)
    assert.equal(fs.readFileSync(path.join(item.target, 'marker'), 'utf8'), 'old')
    assert.ok(calls.some(call => call.command.endsWith('hdiutil') && call.args[0] === 'detach'))
    assert.ok(!fs.readdirSync(item.root).some(name => name.startsWith('.LawVerify-update')))
  } finally { fs.rmSync(item.root, { recursive: true, force: true }) }
})

test('read-only installation is rejected without mounting or replacing files', async (context) => {
  const item = fixture()
  let mounted = false
  context.mock.method(fs.promises, 'access', async () => { throw new Error('EACCES') })
  try {
    await assert.rejects(prepareMacUpdate({
      installerPath: '/tmp/update.dmg', execPath: item.execPath, userData: path.join(item.root, 'profile'),
      version: '0.1.60', arch: 'arm64', channel: 'test',
      execute: async () => { mounted = true },
    }), /写入权限/)
    assert.equal(mounted, false)
    assert.equal(fs.readFileSync(path.join(item.target, 'marker'), 'utf8'), 'old')
  } finally { fs.rmSync(item.root, { recursive: true, force: true }) }
})

async function transaction(mode) {
  const item = fixture()
  const id = 'a'.repeat(32)
  const job = path.join(item.root, 'job')
  const tools = path.join(item.root, 'tools')
  const staged = path.join(item.root, 'staged.app')
  const backup = path.join(item.root, 'backup.app')
  fs.mkdirSync(job)
  if (mode === 'cancel-request') fs.writeFileSync(path.join(job, 'cancel-request'), 'cancel')
  fs.mkdirSync(tools)
  fs.mkdirSync(staged)
  fs.writeFileSync(path.join(staged, 'marker'), 'new')
  fs.writeFileSync(path.join(tools, 'open'), `#!/bin/bash
if [ "$MAC_TEST_MODE" = "launch-failure" ] && [ "$2" = "$MAC_TEST_TARGET" ]; then
  if [ -f "$MAC_TEST_JOB/status" ] && [ "$(cat "$MAC_TEST_JOB/status")" = "restarting" ]; then exit 1; fi
fi
if [ "$MAC_TEST_MODE" = "success" ]; then printf '%s\\n' "$MAC_TEST_ID" > "$MAC_TEST_JOB/startup-ok"; fi
if [ "$MAC_TEST_MODE" = "wrong-ack" ]; then printf 'wrong\\n' > "$MAC_TEST_JOB/startup-ok"; fi
exit 0
`)
  fs.writeFileSync(path.join(tools, 'mv'), `#!/bin/bash
if [ "$MAC_TEST_MODE" = "rename-failure" ] && [ "$1" = "$MAC_TEST_STAGED" ]; then exit 1; fi
/bin/mv "$@"
`)
  fs.chmodSync(path.join(tools, 'open'), 0o700)
  fs.chmodSync(path.join(tools, 'mv'), 0o700)
  try {
    const helper = posix(path.join(__dirname, 'mac-update-helper.sh'))
    const args = [helper, posix(job), posix(item.target), posix(staged), posix(backup), '99999999', id, '1', '2']
    const options = { encoding: 'utf8', timeout: 60000, windowsHide: true,
      env: { ...process.env, PATH: `${posix(tools)}:/usr/bin:/bin`,
        MAC_TEST_MODE: mode, MAC_TEST_TARGET: posix(item.target), MAC_TEST_STAGED: posix(staged),
        MAC_TEST_JOB: posix(job), MAC_TEST_ID: id } }
    let result
    if (mode === 'old-still-running') {
      result = spawnSync(bash, ['-c', 'sleep 5 & p=$!; bash "$1" "$2" "$3" "$4" "$5" "$p" "$6" 1 2; r=$?; kill "$p"; wait "$p" 2>/dev/null; exit "$r"', '_',
        ...args.slice(0, 5), id], options)
    } else result = spawnSync(bash, args, options)
    if (result.error) throw new Error(`${result.error.message}\n${result.stdout}\n${result.stderr}`)
    assert.equal(result.status, mode === 'success' ? 0 : 1, result.stderr)
    assert.equal(fs.readFileSync(path.join(item.target, 'marker'), 'utf8'), mode === 'success' ? 'new' : 'old')
    const status = fs.readFileSync(path.join(job, 'status'), 'utf8').trim()
    assert.equal(status, mode === 'success' ? 'complete' : ['old-still-running', 'cancel-request'].includes(mode) ? 'cancelled' : 'rolled-back')
    if (mode === 'success') assert.equal(fs.readFileSync(path.join(backup, 'marker'), 'utf8'), 'old')
  } finally { fs.rmSync(item.root, { recursive: true, force: true }) }
}

for (const mode of ['success', 'rename-failure', 'launch-failure', 'no-ack', 'wrong-ack', 'old-still-running', 'cancel-request']) {
  test(`real helper transaction: ${mode}`, () => transaction(mode))
}
