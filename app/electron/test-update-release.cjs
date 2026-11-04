const { test } = require('node:test')
const assert = require('node:assert/strict')
const { verifyUpdateRelease } = require('./update-release.cjs')

const release = {
  version: '0.1.60', platform: 'darwin', arch: 'arm64', channel: 'test',
  downloadUrl: 'https://lawagent.zhijing.fun/api/web/releases/test/download', sha256: 'a'.repeat(64),
}
const options = {
  envelope: { success: true, data: release }, payload: release,
  currentVersion: '0.1.59', platform: 'darwin', arch: 'arm64',
}

test('only newer server-authoritative metadata is accepted', () => {
  assert.deepEqual(verifyUpdateRelease(options), release)
  for (const change of [
    { version: '0.1.59' }, { version: '0.1.58' }, { version: 'bad' },
    { sha256: 'b'.repeat(64) }, { downloadUrl: 'https://attacker.example/install' }, { channel: 'stable' },
  ]) {
    assert.throws(() => verifyUpdateRelease({ ...options, payload: { ...release, ...change } }), /更新信息/)
  }
  assert.throws(() => verifyUpdateRelease({ ...options, arch: 'x64' }), /更新信息/)
  assert.throws(() => verifyUpdateRelease({ ...options, platform: 'win32' }), /更新信息/)
  assert.throws(() => verifyUpdateRelease({ ...options, envelope: { success: false } }), /更新信息/)
})

test('even matching metadata cannot authorize insecure HTTP or an invalid checksum', () => {
  for (const change of [{ downloadUrl: 'http://example.test/update' }, { sha256: '' }]) {
    const item = { ...release, ...change }
    assert.throws(() => verifyUpdateRelease({ ...options, payload: item, envelope: { success: true, data: item } }), /更新信息/)
  }
})
