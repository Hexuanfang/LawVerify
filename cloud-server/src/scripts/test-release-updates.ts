import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createApp } from '../app.js'
import { config } from '../config.js'

const root = await mkdtemp(path.join(tmpdir(), 'lawverify-update-releases-'))
const originalRoot = config.cloudServerRoot
config.cloudServerRoot = path.join(root, 'cloud-server')
const directory = path.join(root, 'app', 'release')
await mkdir(directory, { recursive: true })
const server = createApp().listen(0, '127.0.0.1')
await once(server, 'listening')
const address = server.address()
assert.ok(address && typeof address === 'object')
const base = `http://127.0.0.1:${address.port}/api/web/releases/latest`
const fixtures = [
  'LawVerify-Mac-0.1.52-arm64-unsigned.dmg',
  'LawVerify-Mac-0.1.56-arm64-unsigned.dmg',
  'LawVerify-Mac-0.1.57-x64-unsigned.dmg',
  'LawVerify-Setup-0.1.58.exe',
]

async function latest(query: string) {
  const response = await fetch(`${base}?${query}`, { signal: AbortSignal.timeout(5000) })
  return { response, payload: await response.json() }
}

try {
  for (const file of fixtures) await writeFile(path.join(directory, file), file)
  const stable = await latest('platform=darwin&arch=arm64')
  assert.equal(stable.response.status, 200)
  assert.equal(stable.response.headers.get('cache-control'), 'no-store')
  assert.equal(stable.payload.data, null, 'Unsigned packages must never silently enter stable updates')
  const test = await latest('platform=darwin&arch=arm64&channel=test')
  assert.equal(test.payload.data.version, '0.1.56')
  assert.equal(test.payload.data.channel, 'test')
  assert.equal(test.payload.data.arch, 'arm64')
  assert.match(test.payload.data.sha256, /^[a-f0-9]{64}$/)
  const intel = await latest('platform=darwin&arch=x64&channel=test')
  assert.equal(intel.payload.data.version, '0.1.57')
  const windows = await latest('')
  assert.equal(windows.payload.data.version, '0.1.58')
  for (const query of ['platform=linux', 'arch=unknown', 'channel=unknown']) {
    assert.equal((await latest(query)).response.status, 400)
  }
  await writeFile(path.join(directory, 'LawVerify-Mac-0.1.55-arm64.dmg'), 'signed fixture')
  assert.equal((await latest('platform=darwin&arch=arm64')).payload.data.version, '0.1.55')
  console.log('PASS stable/test isolation, Mac chip selection, version sorting, SHA256, no-cache and invalid query handling')
} finally {
  server.closeAllConnections()
  server.close()
  config.cloudServerRoot = originalRoot
  await rm(root, { recursive: true, force: true })
}
