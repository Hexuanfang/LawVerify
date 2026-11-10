const path = require('node:path')
const { spawnSync } = require('node:child_process')

const appRoot = path.resolve(__dirname, '..')
const args = process.argv.slice(2)
const signedOnly = args.includes('--signed-only')
const signed = signedOnly || args.includes('--signed')
if (signedOnly && args.includes('--signed')) {
  throw new Error('Choose --signed or --signed-only, not both.')
}
const archIndex = args.indexOf('--arch')
const arch = archIndex >= 0 ? args[archIndex + 1] : 'all'

if (!['all', 'arm64', 'x64'].includes(arch)) {
  throw new Error('Use --arch arm64, --arch x64 or --arch all.')
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

function run(commandArgs) {
  const result = spawnSync(process.execPath, commandArgs, { cwd: appRoot, env, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

const tasks = ['build', 'build:server', 'prepare:desktop']
if (!signedOnly) tasks.push('verify:workspace')
for (const task of tasks) {
  run([process.env.npm_execpath, 'run', task])
}
const builderArgs = ['node_modules/electron-builder/cli.js', '--config', 'electron/mac-builder.cjs',
  '--mac', 'dmg', 'zip', '--publish', 'never']
builderArgs.push(...(arch === 'all' ? ['--arm64', '--x64'] : [`--${arch}`]))
run(builderArgs)
if (signedOnly) {
  run(['electron/export-mac-signed-only.cjs', '--arch', arch])
} else {
  run(['electron/verify-mac.cjs', '--arch', arch, ...(signed ? ['--signed'] : [])])
}
