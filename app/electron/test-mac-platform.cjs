const assert = require('node:assert/strict')
const { test } = require('node:test')
const { getUpdateFileName, validateUpdateFileName } = require('./update-platform.cjs')

test('updates select a native installer for each supported platform', () => {
  assert.equal(getUpdateFileName('0.1.52', 'win32', 'x64'), 'LawVerify-Setup-0.1.52.exe')
  assert.equal(getUpdateFileName('0.1.52', 'darwin', 'arm64'), 'LawVerify-Mac-0.1.52-arm64.dmg')
  assert.equal(getUpdateFileName('0.1.52', 'darwin', 'x64'), 'LawVerify-Mac-0.1.52-x64.dmg')
  assert.throws(() => getUpdateFileName('0.1.52', 'linux', 'x64'))
  assert.throws(() => validateUpdateFileName('LawVerify-Setup-0.1.52.exe', 'darwin'))
  assert.throws(() => validateUpdateFileName('LawVerify-Mac-0.1.52-arm64.dmg', 'win32'))
  assert.equal(validateUpdateFileName('LawVerify-Mac-0.1.52-arm64.dmg', 'darwin'), 'LawVerify-Mac-0.1.52-arm64.dmg')
  assert.equal(validateUpdateFileName('LawVerify-Mac-0.1.56-arm64-unsigned.dmg', 'darwin', 'arm64', '0.1.56'),
    'LawVerify-Mac-0.1.56-arm64-unsigned.dmg')
  assert.throws(() => validateUpdateFileName('LawVerify-Mac-0.1.56-x64.dmg', 'darwin', 'arm64', '0.1.56'))
  assert.throws(() => validateUpdateFileName('LawVerify-Mac-0.1.52-arm64.dmg', 'darwin', 'arm64', '0.1.56'))
})

test('Mac builder does not reuse Windows runtimes or expose unsigned packages as stable', () => {
  const config = require('./mac-builder.cjs')
  assert.equal(config.extends, null)
  assert.equal(config.electronDist, undefined)
  assert.equal(config.win, undefined)
  assert.equal(config.nsis, undefined)
  assert.equal(config.forceCodeSigning, false)
  assert.equal(config.mac.identity, '-')
  assert.equal(config.mac.notarize, false)
  assert.ok(config.mac.artifactName.includes('-unsigned'))
  assert.deepEqual(config.mac.target[0].arch, ['arm64', 'x64'])
  process.env.LAWVERIFY_MAC_SIGNED = '1'
  delete require.cache[require.resolve('./mac-builder.cjs')]
  const signed = require('./mac-builder.cjs')
  assert.equal(signed.forceCodeSigning, true)
  assert.equal(signed.mac.notarize, true)
  assert.equal(signed.mac.artifactName.includes('-unsigned'), false)
  delete process.env.LAWVERIFY_MAC_SIGNED
})
