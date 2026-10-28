const { spawnSync } = require('node:child_process')
const path = require('node:path')

const env = { ...process.env, LAWVERIFY_REQUIRE_SIGNATURE: '1' }
const check = spawnSync(process.execPath, [path.join(__dirname, 'run-electron-builder.cjs'), '--check-signing'], {
  env, stdio: 'inherit', windowsHide: true,
})
if (check.status !== 0) process.exit(check.status ?? 1)

// Use npm's JS entry point, avoiding shell quoting and a separate command window.
const build = spawnSync(process.execPath, [process.env.npm_execpath, 'run', 'build:desktop'], {
  cwd: path.resolve(__dirname, '..'), env, stdio: 'inherit', windowsHide: true,
})
process.exit(build.status ?? 1)
