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

for (const task of ['build', 'build:server']) {
  run([process.env.npm_execpath, 'run', task])
}
// 每个架构单独准备 Python，再打包，避免把主机架构的运行环境带入另一种安装包。
for (const target of arch === 'all' ? ['arm64', 'x64'] : [arch]) {
  env.LAWVERIFY_PARSER_TARGET_ARCH = target
  const source = process.env[`LAWVERIFY_PARSER_RUNTIME_SOURCE_${target.toUpperCase()}`] || process.env.LAWVERIFY_PARSER_RUNTIME_SOURCE
  if (source) env.LAWVERIFY_PARSER_RUNTIME_SOURCE = source
  else delete env.LAWVERIFY_PARSER_RUNTIME_SOURCE
  for (const task of ['prepare:desktop', 'verify:workspace']) run([process.env.npm_execpath, 'run', task])
  run(['node_modules/electron-builder/cli.js', '--config', 'electron/mac-builder.cjs',
    '--mac', 'dmg', 'zip', '--publish', 'never', `--${target}`])
  run(['electron/verify-mac.cjs', '--arch', target, ...(signed ? ['--signed'] : [])])
}
