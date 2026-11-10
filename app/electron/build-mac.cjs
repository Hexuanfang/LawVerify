const path = require('node:path')
const fs = require('node:fs')
const { spawnSync } = require('node:child_process')
const { checkCredentials, notarizeFile } = require('./verify-mac-notary.cjs')
const { runStapler } = require('./verify-mac-stapler.cjs')
const { version } = require('../package.json')

const appRoot = path.resolve(__dirname, '..')
const args = process.argv.slice(2)
const signedOnly = args.includes('--signed-only')
const signed = signedOnly || args.includes('--signed')
const resume = args.includes('--resume')
if (signedOnly && args.includes('--signed')) {
  throw new Error('Choose --signed or --signed-only, not both.')
}
const archIndex = args.indexOf('--arch')
const arch = archIndex >= 0 ? args[archIndex + 1] : 'all'

if (!['all', 'arm64', 'x64'].includes(arch)) {
  throw new Error('Use --arch arm64, --arch x64 or --arch all.')
}
if (resume && (!signed || signedOnly || arch === 'all')) {
  throw new Error('Resume requires --signed and one explicit architecture.')
}
if (process.platform !== 'darwin') {
  throw new Error('Mac DMG builds require macOS. Run the macOS GitHub Actions workflow or use a Mac.')
}
if (signed && !signedOnly) {
  for (const name of ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']) {
    if (!process.env[name]) throw new Error(`Signed Mac builds require ${name}.`)
  }
}
if (signed) {
  if (!process.env.CSC_LINK && !process.env.CSC_NAME) {
    throw new Error('Configure CSC_LINK and CSC_KEY_PASSWORD, or CSC_NAME for an installed Developer ID Application certificate.')
  }
}

const env = {
  ...process.env,
  LAWVERIFY_MAC_SIGNED: signed ? '1' : '0',
  LAWVERIFY_MAC_SIGNED_ONLY: signedOnly ? '1' : '0',
}
if (signedOnly) {
  delete env.APPLE_ID
  delete env.APPLE_APP_SPECIFIC_PASSWORD
  delete env.APPLE_TEAM_ID
  console.log('Developer ID signing only: notarization and package validation are skipped.')
}
if (!signed) {
  env.CSC_IDENTITY_AUTO_DISCOVERY = 'false'
  delete env.CSC_LINK
  delete env.CSC_NAME
  delete env.CSC_KEY_PASSWORD
}

function execute(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { cwd: appRoot, env, stdio: 'inherit', timeout: 20 * 60_000 })
  if (result.error) throw new Error(`${command} failed: ${result.error.code || 'execution error'}`)
  if (result.status !== 0) throw new Error(`${command} exited with code ${result.status}`)
}

function run(commandArgs) {
  execute(process.execPath, commandArgs)
}

async function main() {
  if (signed && !signedOnly) await checkCredentials({ env })
  if (!resume) {
    const tasks = ['build', 'build:server', 'prepare:desktop']
    if (!signedOnly) tasks.push('verify:workspace')
    for (const task of tasks) run([process.env.npm_execpath, 'run', task])
  }
  const builder = ['node_modules/electron-builder/cli.js', '--config', 'electron/mac-builder.cjs']
  if (!signed || signedOnly) {
    run([...builder, '--mac', 'dmg', 'zip', '--publish', 'never',
      ...(arch === 'all' ? ['--arm64', '--x64'] : [`--${arch}`])])
    run([signedOnly ? 'electron/export-mac-signed-only.cjs' : 'electron/verify-mac.cjs', '--arch', arch])
    return
  }
  for (const selectedArch of arch === 'all' ? ['arm64', 'x64'] : [arch]) {
    const root = path.join(appRoot, 'release-mac')
    const appDir = path.join(root, selectedArch === 'arm64' ? 'mac-arm64' : 'mac', 'LawVerify.app')
    const manifestFile = path.join(root, `notary-recovery-${selectedArch}.json`)
    let manifest
    if (resume) {
      manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
      if (manifest.version !== version || manifest.arch !== selectedArch ||
          !manifest.sourceSha || manifest.sourceSha !== env.GITHUB_SHA) {
        throw new Error('Recovery version, architecture or source commit does not match this build.')
      }
      if (!fs.existsSync(appDir)) throw new Error('Recovery artifact is missing the signed application.')
    } else {
      run([...builder, '--mac', '--dir', '--publish', 'never', `--${selectedArch}`])
      manifest = { version, arch: selectedArch, sourceSha: env.GITHUB_SHA || null, packagesReady: false }
      fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n')
    }
    const archive = path.join(root, `notary-app-${version}-${selectedArch}.zip`)
    execute('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appDir])
    if (!fs.existsSync(archive)) {
      const temporaryArchive = `${archive}.tmp.zip`
      execute('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appDir, temporaryArchive])
      execute('unzip', ['-tq', temporaryArchive])
      fs.renameSync(temporaryArchive, archive)
    }
    await notarizeFile(archive, { env })
    await runStapler('staple', appDir)
    await runStapler('validate', appDir)
    if (!manifest.packagesReady) {
      // Package the already signed, stapled app without re-signing or changing its identity.
      run([...builder, '--mac', 'dmg', 'zip', '--prepackaged', appDir, '--publish', 'never', `--${selectedArch}`])
      manifest.packagesReady = true
      fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n')
    }
    // Verification owns the second (DMG) submission and exports hashes only after acceptance.
    const result = spawnSync(process.execPath, ['electron/verify-mac.cjs', '--arch', selectedArch, '--signed'], {
      cwd: appRoot, env, stdio: 'inherit', timeout: 135 * 60_000,
    })
    if (result.error || result.status !== 0) throw new Error('Mac release verification failed; preserve the recovery artifact.')
  }
}

main().catch(error => { console.error(error.message); process.exit(1) })
