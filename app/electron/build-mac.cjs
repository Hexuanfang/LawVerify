const path = require('node:path')
const { spawnSync } = require('node:child_process')

const appRoot = path.resolve(__dirname, '..')
const args = process.argv.slice(2)
const signed = args.includes('--signed')
const archIndex = args.indexOf('--arch')
const arch = archIndex >= 0 ? args[archIndex + 1] : 'all'

if (!['all', 'arm64', 'x64'].includes(arch)) {
  throw new Error('Use --arch arm64, --arch x64 or --arch all.')
}
if (process.platform !== 'darwin') {
  throw new Error('Mac DMG builds require macOS. Run the macOS GitHub Actions workflow or use a Mac.')
}
if (signed) {
  for (const name of ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']) {
    if (!process.env[name]) throw new Error(`Signed Mac builds require ${name}.`)
  }
  if (!process.env.CSC_LINK && !process.env.CSC_NAME) {
    throw new Error('Configure CSC_LINK and CSC_KEY_PASSWORD, or CSC_NAME for an installed Developer ID Application certificate.')
  }
}

const env = { ...process.env, LAWVERIFY_MAC_SIGNED: signed ? '1' : '0' }
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

for (const task of ['build', 'build:server', 'prepare:desktop', 'verify:workspace']) {
  run([process.env.npm_execpath, 'run', task])
}
const builderArgs = ['node_modules/electron-builder/cli.js', '--config', 'electron/mac-builder.cjs',
  '--mac', 'dmg', 'zip', '--publish', 'never']
builderArgs.push(...(arch === 'all' ? ['--arm64', '--x64'] : [`--${arch}`]))
run(builderArgs)
run(['electron/verify-mac.cjs', '--arch', arch, ...(signed ? ['--signed'] : [])])
