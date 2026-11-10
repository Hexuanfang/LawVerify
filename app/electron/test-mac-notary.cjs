const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { checkCredentials, notarizeFile, fileHash } = require('./verify-mac-notary.cjs')

const id = '12345678-1234-1234-1234-123456789abc'
const env = { APPLE_ID: 'user@example.com', APPLE_APP_SPECIFIC_PASSWORD: 'secret-password', APPLE_TEAM_ID: 'team-secret' }
const ok = value => ({ status: 0, stdout: JSON.stringify(value) })

async function fixture(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lawverify-notary-'))
  const file = path.join(root, 'installer.dmg')
  fs.writeFileSync(file, 'signed installer fixture')
  try {
    await callback(file, root)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

function harness(results) {
  const calls = [], waits = [], logs = []
  let clock = 0
  const options = {
    env, now: () => clock, waitMs: 120_000, pollMs: 60_000,
    log: message => logs.push(message),
    delay: async ms => { waits.push(ms); clock += ms },
    execute(command, args, config) {
      calls.push({ command, args, config })
      const next = results[Math.min(calls.length - 1, results.length - 1)]
      return typeof next === 'function' ? next() : next
    },
  }
  return { calls, waits, logs, options }
}

test('credentials fail before upload and secrets are redacted', async () => {
  const h = harness([{ status: 1, stderr: `HTTP status code: 401. Invalid credentials ${env.APPLE_ID} ${env.APPLE_APP_SPECIFIC_PASSWORD} ${env.APPLE_TEAM_ID}` }])
  await assert.rejects(checkCredentials(h.options), error => {
    assert.match(error.message, /401/)
    for (const secret of Object.values(env)) assert.ok(!error.message.includes(secret))
    return true
  })
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0].args[1], 'history')
  await assert.rejects(checkCredentials({ ...h.options, env: {} }), /requires APPLE_ID/)
})

test('submission ID is durable before polling and acceptance is required', async () => {
  await fixture(async file => {
    const h = harness([
      ok({ id }),
      () => {
        assert.equal(JSON.parse(fs.readFileSync(`${file}.notary.json`, 'utf8')).id, id)
        return ok({ id, status: 'In Progress' })
      },
      ok({ id, status: 'Accepted' }),
    ])
    const state = await notarizeFile(file, h.options)
    assert.equal(state.status, 'Accepted')
    assert.equal(h.calls[0].config.timeout, 20 * 60_000)
    assert.equal(h.calls[1].config.timeout, 120_000)
    assert.ok(!h.calls[0].args.includes('--wait'))
    assert.deepEqual(h.waits, [60_000])
    assert.ok(h.logs.some(message => message.includes(id)))
  })
})

test('wait timeout keeps ID and resume never uploads again', async () => {
  await fixture(async file => {
    const first = harness([ok({ id }), ok({ id, status: 'In Progress' })])
    await assert.rejects(notarizeFile(file, first.options), /still In Progress.*Resume/)
    const state = JSON.parse(fs.readFileSync(`${file}.notary.json`, 'utf8'))
    assert.equal(state.id, id)
    assert.equal(state.status, 'In Progress')
    const resumed = harness([ok({ id, status: 'Accepted' })])
    await notarizeFile(file, resumed.options)
    assert.deepEqual(resumed.calls.map(call => call.args[1]), ['info'])
  })
})

test('transient status failures retry only reads', async () => {
  await fixture(async file => {
    const h = harness([
      ok({ id }),
      { status: 1, stderr: 'NSURLErrorDomain Code=-1005 network connection was lost' },
      { status: null, error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) },
      ok({ id, status: 'Accepted' }),
    ])
    await notarizeFile(file, h.options)
    assert.equal(h.calls.filter(call => call.args[1] === 'submit').length, 1)
    assert.deepEqual(h.waits, [5_000, 10_000])
  })
})

test('ambiguous upload failure cannot trigger duplicate submissions', async () => {
  await fixture(async file => {
    const h = harness([{ status: null, error: Object.assign(new Error(`timeout ${env.APPLE_APP_SPECIFIC_PASSWORD}`), { code: 'ETIMEDOUT' }) }])
    await assert.rejects(notarizeFile(file, h.options), /query Apple history/)
    assert.equal(h.calls.length, 1)
    assert.ok(!fs.readFileSync(`${file}.notary.json`, 'utf8').includes(env.APPLE_APP_SPECIFIC_PASSWORD))
    await assert.rejects(notarizeFile(file, h.options), /Previous upload has no submission ID/)
    assert.equal(h.calls.length, 1)
  })
})

test('rejection exports diagnostics and never passes as timeout or success', async () => {
  await fixture(async file => {
    const h = harness([
      ok({ id }), ok({ id, status: 'Invalid' }),
      ok({ issues: [{ message: 'Invalid signature', detail: env.APPLE_APP_SPECIFIC_PASSWORD }] }),
    ])
    await assert.rejects(notarizeFile(file, h.options), /Apple Invalid/)
    const diagnostics = fs.readFileSync(`${file}.notary-log.json`, 'utf8')
    assert.match(diagnostics, /Invalid signature/)
    assert.ok(!diagnostics.includes(env.APPLE_APP_SPECIFIC_PASSWORD))
    assert.equal(h.calls[2].args[1], 'log')
    assert.deepEqual(h.waits, [])
  })
})

test('payload change forbids reuse of an in-progress submission', async () => {
  await fixture(async file => {
    const sha256 = await fileHash(file)
    fs.writeFileSync(`${file}.notary.json`, JSON.stringify({ id, fileName: path.basename(file), sha256, status: 'In Progress' }))
    fs.appendFileSync(file, 'changed')
    const h = harness([ok({ id, status: 'Accepted' })])
    await assert.rejects(notarizeFile(file, h.options), /payload changed/)
    assert.equal(h.calls.length, 0)
  })
})

test('stapled DMG reuse requires successful Apple ticket validation', async () => {
  await fixture(async file => {
    const sha256 = await fileHash(file)
    fs.writeFileSync(`${file}.notary.json`, JSON.stringify({ id, fileName: path.basename(file), sha256, status: 'Accepted' }))
    fs.appendFileSync(file, 'stapled ticket')
    const h = harness([])
    let validated = false
    const state = await notarizeFile(file, { ...h.options, validateAccepted: async () => { validated = true } })
    assert.equal(state.id, id)
    assert.equal(validated, true)
    assert.equal(h.calls.length, 0)
    await assert.rejects(notarizeFile(file, {
      ...h.options, validateAccepted: async () => { throw new Error('Invalid ticket') },
    }), /Invalid ticket/)
  })
})

test('unknown or mismatched Apple responses fail closed', async () => {
  await fixture(async file => {
    const h = harness([ok({ id }), ok({ id, status: 'Unknown' })])
    await assert.rejects(notarizeFile(file, h.options), /Unexpected Apple status/)
  })
})

test('persistent network failures keep state and stop after bounded retries', async () => {
  await fixture(async file => {
    const h = harness([ok({ id }), { status: 1, stderr: 'HTTP status code: 503' }])
    await assert.rejects(notarizeFile(file, h.options), /503/)
    assert.equal(h.calls.length, 5)
    assert.deepEqual(h.waits, [5_000, 10_000, 20_000])
    assert.equal(JSON.parse(fs.readFileSync(`${file}.notary.json`, 'utf8')).id, id)
  })
})

async function buildHarness(root, argv, manifest) {
  const calls = [], phases = []
  const appRoot = path.dirname(root)
  const selectedArch = argv[argv.indexOf('--arch') + 1]
  const appDir = path.join(root, selectedArch === 'arm64' ? 'mac-arm64' : 'mac', 'LawVerify.app')
  if (manifest) {
    fs.mkdirSync(appDir, { recursive: true })
    fs.writeFileSync(path.join(root, `notary-recovery-${selectedArch}.json`), JSON.stringify(manifest))
  }
  await vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'build-mac.cjs'), 'utf8'), {
    __dirname: path.join(appRoot, 'electron'),
    console: { log() {}, error: message => phases.push(message) },
    process: {
      argv: ['node', 'build-mac.cjs', ...argv], platform: 'darwin', execPath: process.execPath,
      env: { ...env, CSC_LINK: 'fixture', npm_execpath: 'npm-cli.js', GITHUB_SHA: 'source-commit' },
      exit: code => { phases.push(`exit ${code}`) },
    },
    require(name) {
      if (name === './verify-mac-notary.cjs') return {
        checkCredentials: async () => phases.push('credentials'),
        notarizeFile: async () => phases.push('notarize'),
      }
      if (name === './verify-mac-stapler.cjs') return { runStapler: async action => phases.push(action) }
      if (name === '../package.json') return { version: '0.1.60' }
      if (name === 'node:child_process') return {
        spawnSync(command, args, options) {
          calls.push({ command, args, options })
          if (args.includes('--dir')) fs.mkdirSync(appDir, { recursive: true })
          if (command === 'ditto') fs.writeFileSync(args.at(-1), 'signed app archive fixture')
          return { status: 0 }
        },
      }
      return require(name)
    },
  })
  return { calls, phases }
}

test('formal build preflights, notarizes app, packages prebuilt app and verifies DMG', async () => {
  await fixture(async (_file, temporary) => {
    const h = await buildHarness(path.join(temporary, 'release-mac'), ['--signed', '--arch', 'arm64'])
    assert.deepEqual(h.phases, ['credentials', 'notarize', 'staple', 'validate'])
    assert.ok(h.calls.some(call => call.args.includes('--dir')))
    assert.ok(h.calls.some(call => call.args.includes('--prepackaged')))
    assert.equal(h.calls.at(-1).args[0], 'electron/verify-mac.cjs')
  })
})

test('recovery skips build and packaging once original packages are ready', async () => {
  await fixture(async (_file, temporary) => {
    const h = await buildHarness(path.join(temporary, 'release-mac'), ['--signed', '--resume', '--arch', 'x64'], {
      version: '0.1.60', arch: 'x64', sourceSha: 'source-commit', packagesReady: true,
    })
    assert.ok(!h.calls.some(call => call.args.includes('--dir') || call.args.includes('--prepackaged') || call.args.includes('build')))
    assert.equal(h.calls.at(-1).args[0], 'electron/verify-mac.cjs')
  })
})

test('recovery rejects a different source commit before notarization or packaging', async () => {
  await fixture(async (_file, temporary) => {
    const h = await buildHarness(path.join(temporary, 'release-mac'), ['--signed', '--resume', '--arch', 'arm64'], {
      version: '0.1.60', arch: 'arm64', sourceSha: 'different-commit', packagesReady: true,
    })
    assert.ok(h.phases.some(message => message.includes('does not match')))
    assert.ok(!h.phases.includes('notarize'))
    assert.equal(h.calls.length, 0)
  })
})

test('recovery after app wait finishes packaging without rebuilding the application', async () => {
  await fixture(async (_file, temporary) => {
    const h = await buildHarness(path.join(temporary, 'release-mac'), ['--signed', '--resume', '--arch', 'arm64'], {
      version: '0.1.60', arch: 'arm64', sourceSha: 'source-commit', packagesReady: false,
    })
    assert.ok(!h.calls.some(call => call.args.includes('--dir') || call.args.includes('build')))
    assert.ok(h.calls.some(call => call.args.includes('--prepackaged')))
    assert.deepEqual(h.phases, ['credentials', 'notarize', 'staple', 'validate'])
  })
})

async function verificationHarness(root, accepted) {
  const phases = []
  const appRoot = path.dirname(root)
  for (const extension of ['dmg', 'zip']) {
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(path.join(root, `LawVerify-Mac-0.1.60-x64.${extension}`), 'signed payload fixture')
  }
  await vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'verify-mac.cjs'), 'utf8'), {
    __dirname: path.join(appRoot, 'electron'),
    console: { log() {}, error() {} },
    process: {
      argv: ['node', 'verify-mac.cjs', '--signed', '--arch', 'x64'],
      platform: 'darwin', arch: 'arm64', env,
      exit: code => phases.push(`exit ${code}`),
    },
    require(name) {
      if (name === '../package.json') return { version: '0.1.60' }
      if (name === './verify-mac-notary.cjs') return {
        notarizeFile: async () => {
          assert.ok(!fs.existsSync(path.join(root, 'verification-x64.json')))
          assert.ok(!fs.existsSync(path.join(root, 'LawVerify-Mac-0.1.60-x64.dmg.sha256')))
          phases.push('notarize-dmg')
          if (!accepted) throw new Error('Apple Invalid')
          return { id, status: 'Accepted' }
        },
      }
      if (name === './verify-mac-stapler.cjs') return {
        runStapler: async (action, target) => phases.push(`${action}:${path.extname(target)}`),
      }
      if (name === 'node:child_process') return {
        spawnSync: command => ({ status: 0, stdout: command === 'lipo' ? 'x86_64' : '' }),
      }
      return require(name)
    },
  })
  return phases
}

test('release hashes and reports are exported only after DMG acceptance and ticket validation', async () => {
  await fixture(async (_file, temporary) => {
    const root = path.join(temporary, 'release-mac')
    const phases = await verificationHarness(root, true)
    assert.deepEqual(phases, ['validate:.app', 'notarize-dmg', 'staple:.dmg', 'validate:.dmg'])
    const reports = JSON.parse(fs.readFileSync(path.join(root, 'verification-x64.json'), 'utf8'))
    assert.equal(reports.length, 2)
    assert.ok(reports.every(report => report.notarized === true && report.signed === true))
    for (const report of reports) {
      assert.equal(report.sha256, await fileHash(path.join(root, report.fileName)))
    }
  })
})

test('rejected DMG produces neither release hashes nor success reports', async () => {
  await fixture(async (_file, temporary) => {
    const root = path.join(temporary, 'release-mac')
    const phases = await verificationHarness(root, false)
    assert.deepEqual(phases, ['validate:.app', 'notarize-dmg', 'exit 1'])
    assert.ok(!fs.existsSync(path.join(root, 'verification-x64.json')))
    assert.ok(!fs.existsSync(path.join(root, 'LawVerify-Mac-0.1.60-x64.dmg.sha256')))
  })
})
