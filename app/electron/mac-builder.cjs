const { build } = require('../package.json')

const signed = process.env.LAWVERIFY_MAC_SIGNED === '1'
if (process.platform === 'darwin') {
  // 正式签名和 ad-hoc 完整性处理均需扫描 Python 文件，统一排队避免耗尽句柄。
  require('graceful-fs').gracefulify(require('node:fs'))
}
const { electronDist: _electronDist, win: _win, nsis: _nsis, ...shared } = build

// Download the matching Darwin runtime instead of reusing the host's Electron.
module.exports = {
  ...shared,
  extends: null,
  directories: { ...shared.directories, output: signed ? 'release-mac' : 'release-mac-unsigned' },
  forceCodeSigning: signed,
  files: [
    ...shared.files,
    '!electron/test-*.cjs',
    '!electron/*builder*.cjs',
    '!electron/build-*.cjs',
    '!electron/verify-*.cjs',
    '!electron/export-*.cjs',
    '!electron/prepare-*.cjs',
    '!electron/*.ps1',
    ...(signed ? ['!electron/mac-test-channel.json'] : []),
  ],
  mac: {
    icon: 'build/icon.icns',
    minimumSystemVersion: '14.0.0',
    target: [
      { target: 'dmg', arch: ['arm64', 'x64'] },
      { target: 'zip', arch: ['arm64', 'x64'] },
    ],
    artifactName: `LawVerify-Mac-\${version}-\${arch}${signed ? '' : '-unsigned'}.\${ext}`,
    category: 'public.app-category.productivity',
    hardenedRuntime: signed,
    identity: signed ? undefined : '-',
    notarize: signed,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    extendInfo: {
      NSMicrophoneUsageDescription: 'LawVerify uses the microphone only when you start voice input.',
      NSDocumentsFolderUsageDescription: 'LawVerify needs access to the case materials you select.',
      NSDownloadsFolderUsageDescription: 'LawVerify needs access to the case materials you select.',
      NSDesktopFolderUsageDescription: 'LawVerify needs access to the case materials you select.',
    },
  },
  dmg: { sign: signed },
}
