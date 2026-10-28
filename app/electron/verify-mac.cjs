const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { spawnSync } = require('node:child_process')
const os = require('node:os')
const { pathToFileURL } = require('node:url')
const { version } = require('../package.json')

assert.equal(process.platform, 'darwin', 'Mac verification requires macOS')
const args = process.argv.slice(2)
const signed = args.includes('--signed')
const archIndex = args.indexOf('--arch')
const selectedArch = archIndex >= 0 ? args[archIndex + 1] : 'all'
assert.ok(['all', 'arm64', 'x64'].includes(selectedArch), 'Invalid architecture')
const root = path.resolve(__dirname, '..', signed ? 'release-mac' : 'release-mac-unsigned')

function run(command, commandArgs, env = process.env) {
  const result = spawnSync(command, commandArgs, { env, encoding: 'utf8', timeout: 1_800_000 })
  if (result.error) throw result.error
  assert.equal(result.status, 0, result.stderr || result.stdout || `${command} failed`)
  return result.stdout
}

async function main() {
  const reports = []
  for (const arch of selectedArch === 'all' ? ['arm64', 'x64'] : [selectedArch]) {
    const appDir = path.join(root, arch === 'arm64' ? 'mac-arm64' : 'mac', 'LawVerify.app')
    const binary = path.join(appDir, 'Contents', 'MacOS', 'LawVerify')
    assert.ok(run('lipo', ['-archs', binary]).trim().split(/\s+/).includes(arch === 'x64' ? 'x86_64' : 'arm64'))
    if (arch === process.arch) {
      const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'lawverify-mac-smoke-'))
      const runtime = path.join(appDir, 'Contents', 'Resources', 'app.asar', '.desktop', 'server')
      const sqliteUrl = pathToFileURL(path.join(runtime, 'dist', 'infrastructure', 'workspace-sqlite.js')).href
      const backendUrl = pathToFileURL(path.join(runtime, 'dist', 'app.js')).href
      try {
        const script = `
          const { WorkspaceSqliteStore } = await import(${JSON.stringify(sqliteUrl)});
          const store = new WorkspaceSqliteStore(${JSON.stringify(temporary)});
          const state = store.read(() => ({ user: { id: 'smoke', points: 0, pointLogs: [] }, cases: [] }));
          state.cases.push({ id: 'smoke', name: 'Mac smoke test' });
          store.save(state);
          if (store.read(() => {}).cases[0].id !== 'smoke') throw new Error('SQLite save failed');
          const { createApp, initializeCommercialInfrastructure } = await import(${JSON.stringify(backendUrl)});
          await initializeCommercialInfrastructure();
          const { app } = createApp();
          const server = app.listen(0, '127.0.0.1');
          await new Promise(resolve => server.once('listening', resolve));
          const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/health');
          if (!response.ok) throw new Error('Packaged backend health check failed');
          server.closeAllConnections();
          await new Promise(resolve => server.close(resolve));
          console.log('Packaged Mac SQLite and backend health passed');
          process.exit(0);
        `
        console.log(run(binary, ['--input-type=module', '--eval', script], {
          ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_ENV: 'test',
          APP_RUNTIME_ROOT: runtime, APP_DATA_ROOT: temporary,
          WORKSPACE_DATA_DIR: temporary, STORAGE_LOCAL_ROOT: path.join(temporary, 'storage'),
          AUTO_RUN_MIGRATIONS: 'false', KNOWLEDGE_RAG_MODE: 'local', AI_GATEWAY_MODE: 'cloud',
        }).trim())
      } finally {
        fs.rmSync(temporary, { recursive: true, force: true })
      }
    }
    run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appDir])
    if (signed) {
      run('spctl', ['--assess', '--type', 'execute', '--verbose=2', appDir])
      run('xcrun', ['stapler', 'validate', appDir])
    }
    for (const extension of ['dmg', 'zip']) {
      const fileName = `LawVerify-Mac-${version}-${arch}${signed ? '' : '-unsigned'}.${extension}`
      const file = path.join(root, fileName)
      assert.ok(fs.statSync(file).size > 0, `Missing ${fileName}`)
      if (extension === 'dmg') {
        run('hdiutil', ['verify', file])
        if (signed) {
          // The builder notarizes the app; submit the final DMG as well.
          run('xcrun', ['notarytool', 'submit', file, '--wait',
            '--apple-id', process.env.APPLE_ID, '--password', process.env.APPLE_APP_SPECIFIC_PASSWORD,
            '--team-id', process.env.APPLE_TEAM_ID])
          run('xcrun', ['stapler', 'staple', file])
          run('xcrun', ['stapler', 'validate', file])
        }
      } else {
        run('unzip', ['-tq', file])
      }
      const hash = createHash('sha256')
      for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
      const sha256 = hash.digest('hex')
      fs.writeFileSync(`${file}.sha256`, `${sha256}  ${fileName}\n`)
      reports.push({ fileName, arch, version, sha256, signed, notarized: signed })
    }
  }
  fs.writeFileSync(path.join(root, `verification-${selectedArch}.json`), JSON.stringify(reports, null, 2))
  console.log(`Verified ${reports.length} Mac artifacts (${signed ? 'signed and notarized' : 'ad-hoc test build'}).`)
}

main().catch((error) => { console.error(error); process.exit(1) })
