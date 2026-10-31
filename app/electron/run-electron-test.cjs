const { spawnSync } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const allowed = new Set(['test-desktop-service.cjs', 'test-ide-layout.cjs', 'test-account-proxy.cjs', 'test-update-ui.cjs'])
const target = process.argv[2]
if (!allowed.has(target)) throw new Error('Unknown Electron test')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const userData = target === 'test-update-ui.cjs'
  ? fs.mkdtempSync(path.join(os.tmpdir(), 'lawverify-update-ui-')) : null
if (userData) env.LAWVERIFY_TEST_USER_DATA = userData
const result = spawnSync(require('electron'), [path.join(__dirname, target)], {
  env, encoding: 'utf8', timeout: 120000, windowsHide: true,
})
// Chromium releases its profile locks only after the Electron process exits.
if (userData) fs.rmSync(userData, { recursive: true, force: true })
process.stdout.write(result.stdout ?? '')
process.stderr.write(result.stderr ?? '')
if (result.error) process.stderr.write(`${result.error.message}\n`)
process.exit(result.status ?? 1)
