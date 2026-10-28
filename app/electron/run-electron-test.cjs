const { spawnSync } = require('node:child_process')
const path = require('node:path')
const allowed = new Set(['test-desktop-service.cjs', 'test-ide-layout.cjs'])
const target = process.argv[2]
if (!allowed.has(target)) throw new Error('Unknown Electron test')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const result = spawnSync(require('electron'), [path.join(__dirname, target)], {
  env, encoding: 'utf8', timeout: 120000, windowsHide: true,
})
process.stdout.write(result.stdout ?? '')
process.stderr.write(result.stderr ?? '')
if (result.error) process.stderr.write(`${result.error.message}\n`)
process.exit(result.status ?? 1)
