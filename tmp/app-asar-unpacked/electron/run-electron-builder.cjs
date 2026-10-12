const path = require('node:path')
const { spawnSync } = require('node:child_process')

const appRoot = path.resolve(__dirname, '..')
const cacheRoot = path.join(appRoot, '.cache', 'electron-builder')
const electronBuilderBin = path.join(appRoot, 'node_modules', 'electron-builder', 'cli.js')

const result = spawnSync(process.execPath, [electronBuilderBin, ...process.argv.slice(2)], {
  cwd: appRoot,
  stdio: 'inherit',
  env: {
    ...process.env,
    ELECTRON_BUILDER_CACHE: cacheRoot,
  },
})

if (result.status !== 0) {
  process.exit(result.status ?? 1)
}
