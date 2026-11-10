const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { createHash } = require('node:crypto')
const { exportArtifacts } = require('./export-mac-signed-only.cjs')

test('signed-only keeps real certificate signing but disables notarization and stable channel', () => {
  const before = { signed: process.env.LAWVERIFY_MAC_SIGNED, only: process.env.LAWVERIFY_MAC_SIGNED_ONLY }
  try {
    process.env.LAWVERIFY_MAC_SIGNED = '1'
    process.env.LAWVERIFY_MAC_SIGNED_ONLY = '1'
    delete require.cache[require.resolve('./mac-builder.cjs')]
    const config = require('./mac-builder.cjs')
    assert.equal(config.forceCodeSigning, true)
    assert.equal(config.mac.notarize, false)
    assert.equal(config.mac.hardenedRuntime, true)
    assert.notEqual(config.mac.identity, '-')
    assert.equal(config.dmg.sign, true)
    assert.equal(config.directories.output, 'release-mac-signed-only')
    assert.ok(config.mac.artifactName.includes('-signed-only'))
    assert.ok(!config.files.includes('!electron/mac-test-channel.json'))
  } finally {
    for (const [key, value] of [
      ['LAWVERIFY_MAC_SIGNED', before.signed], ['LAWVERIFY_MAC_SIGNED_ONLY', before.only],
    ]) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    delete require.cache[require.resolve('./mac-builder.cjs')]
  }
})

test('direct packaging needs no Apple credentials and invokes no validation commands', () => {
  const calls = []
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'build-mac.cjs'), 'utf8'), {
    __dirname,
    console: { log() {} },
    process: {
      argv: ['node', 'build-mac.cjs', '--signed-only', '--arch', 'arm64'],
      platform: 'darwin', execPath: process.execPath,
      env: { CSC_LINK: 'fixture-certificate', npm_execpath: 'npm-cli.js' },
      exit: code => { throw new Error(`Unexpected exit ${code}`) },
    },
    require(name) {
      if (name === 'node:child_process') {
        return { spawnSync: (command, args, options) => { calls.push({ args, options }); return { status: 0 } } }
      }
      return require(name)
    },
  })
  assert.deepEqual(Array.from(calls.slice(0, 3), call => call.args[2]), ['build', 'build:server', 'prepare:desktop'])
  assert.equal(calls.length, 5)
  assert.equal(calls[3].options.env.LAWVERIFY_MAC_SIGNED_ONLY, '1')
  assert.equal(calls[3].options.env.LAWVERIFY_MAC_SIGNED, '1')
  assert.equal(calls[4].args[0], 'electron/export-mac-signed-only.cjs')
  assert.ok(!calls.some(call => call.args.includes('verify:workspace') || call.args.includes('electron/verify-mac.cjs')))
})

test('integrity export never claims notarization or validation and covers both architectures', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lawverify-signed-only-'))
  try {
    for (const arch of ['arm64', 'x64']) {
      for (const ext of ['dmg', 'zip']) {
        fs.writeFileSync(path.join(root, `LawVerify-Mac-0.1.60-${arch}-signed-only.${ext}`), `${arch}-${ext}`)
      }
    }
    const reports = await exportArtifacts({ root, version: '0.1.60', arch: 'all' })
    assert.equal(reports.length, 4)
    for (const report of reports) {
      assert.equal(report.notarized, false)
      assert.equal(report.verified, false)
      assert.equal(report.verificationSkipped, true)
      assert.equal(report.channel, 'test')
      const hash = createHash('sha256').update(fs.readFileSync(path.join(root, report.fileName))).digest('hex')
      assert.equal(report.sha256, hash)
      assert.ok(fs.readFileSync(path.join(root, `${report.fileName}.sha256`), 'utf8').startsWith(hash))
    }
    await assert.rejects(exportArtifacts({ root, version: '0.1.61', arch: 'arm64' }), /ENOENT/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
