const { build } = require('../package.json')

const signed = process.env.LAWVERIFY_MAC_SIGNED === '1'
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
  ],
  mac: {
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
      NSDocumentsFolderUsageDescription: 'LawVerify needs access to the case materials you select.',
      NSDownloadsFolderUsageDescription: 'LawVerify needs access to the case materials you select.',
      NSDesktopFolderUsageDescription: 'LawVerify needs access to the case materials you select.',
    },
  },
  dmg: { sign: signed },
}
