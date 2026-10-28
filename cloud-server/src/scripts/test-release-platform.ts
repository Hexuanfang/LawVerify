import assert from 'node:assert/strict'
import { parseReleaseFileName } from '../release-platform.js'
import { getLatestPublicRelease } from '../release-service.js'

assert.deepEqual(parseReleaseFileName('LawVerify-Setup-0.1.52.exe'), { version: '0.1.52', platform: 'win32', arch: 'x64' })
assert.deepEqual(parseReleaseFileName('LawVerify-Mac-0.1.52-arm64.dmg'), { version: '0.1.52', platform: 'darwin', arch: 'arm64' })
assert.deepEqual(parseReleaseFileName('LawVerify-Mac-0.1.52-x64.dmg'), { version: '0.1.52', platform: 'darwin', arch: 'x64' })
assert.equal(parseReleaseFileName('LawVerify-Mac-0.1.52-arm64-unsigned.dmg'), null)
assert.equal(parseReleaseFileName('LawVerify-Mac-0.1.52-arm64.zip'), null)
assert.equal(parseReleaseFileName('../LawVerify-Mac-0.1.52-arm64.dmg'), null)
await assert.rejects(getLatestPublicRelease('linux', 'x64'), /不支持/)
await assert.rejects(getLatestPublicRelease('darwin', 'unknown'), /不支持/)
const windows = await getLatestPublicRelease()
assert.ok(!windows || (windows.platform === 'win32' && windows.arch === 'x64'))
const apple = await getLatestPublicRelease('darwin', 'arm64')
assert.ok(!apple || (apple.platform === 'darwin' && apple.arch === 'arm64'))
console.log('PASS platform metadata, unsigned exclusion, input validation and latest-release isolation')
