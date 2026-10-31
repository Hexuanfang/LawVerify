export function parseReleaseFileName(fileName: string) {
  const windows = /^(?:LawVerify|LexVerify)-Setup-(\d+\.\d+\.\d+)(-unsigned)?\.exe$/i.exec(fileName)
  if (windows) return {
    version: windows[1], platform: 'win32' as const, arch: 'x64' as const,
    channel: windows[2] ? 'test' : 'stable',
  }
  // Test packages can be downloaded, but must stay outside stable auto-updates.
  const mac = /^LawVerify-Mac-(\d+\.\d+\.\d+)-(arm64|x64)(-unsigned)?\.dmg$/i.exec(fileName)
  if (mac) return {
    version: mac[1],
    platform: 'darwin' as const,
    arch: mac[2].toLowerCase() as 'arm64' | 'x64',
    channel: mac[3] ? 'test' : 'stable',
  }
  return null
}
