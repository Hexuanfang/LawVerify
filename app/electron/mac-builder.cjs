const { build } = require('../package.json')

const signed = process.env.LAWVERIFY_MAC_SIGNED === '1'
const signedOnly = signed && process.env.LAWVERIFY_MAC_SIGNED_ONLY === '1'
const notarized = signed && !signedOnly
const suffix = signedOnly ? '-signed-only' : signed ? '' : '-unsigned'
const { electronDist: _electronDist, win: _win, nsis: _nsis, ...shared } = build

// Download the matching Darwin runtime instead of reusing the host's Electron.
module.exports = {
  ...shared,
  extends: null,
  directories: {
    ...shared.directories,
    output: signedOnly ? 'release-mac-signed-only' : signed ? 'release-mac' : 'release-mac-unsigned',
  },
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
    ...(notarized ? ['!electron/mac-test-channel.json'] : []),
  ],
  mac: {
    icon: 'build/icon.icns',
    target: [
      { target: 'dmg', arch: ['arm64', 'x64'] },
      { target: 'zip', arch: ['arm64', 'x64'] },
    ],
    artifactName: `LawVerify-Mac-\${version}-\${arch}${suffix}.\${ext}`,
    category: 'public.app-category.productivity',
    hardenedRuntime: signed,
    identity: signed ? undefined : '-',
    // build-mac.cjs owns durable submissions and bounded, visible status polling.
    notarize: false,
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
