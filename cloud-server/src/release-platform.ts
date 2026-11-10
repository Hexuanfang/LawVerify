export function parseReleaseFileName(fileName: string) {
  const windows = /^(?:LawVerify|LexVerify)-Setup-(\d+\.\d+\.\d+)(-unsigned)?\.exe$/i.exec(fileName)
  if (windows) return {
    version: windows[1], platform: 'win32' as const, arch: 'x64' as const,
    channel: windows[2] ? 'test' : 'stable',
  }
  // Unsigned and signed-only packages lack notarization and stay outside stable updates.
  const mac = /^LawVerify-Mac-(\d+\.\d+\.\d+)-(arm64|x64)(-(?:unsigned|signed-only))?\.dmg$/i.exec(fileName)
  if (mac) return {
    version: mac[1],
    platform: 'darwin' as const,
    arch: mac[2].toLowerCase() as 'arm64' | 'x64',
    channel: mac[3] ? 'test' : 'stable',
    ...(mac[3]?.toLowerCase() === '-signed-only' ? { signingStatus: 'signed' as const } : {}),
  }
  return null
}
