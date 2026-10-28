export function parseReleaseFileName(fileName: string) {
  const windows = /^(?:LawVerify|LexVerify)-Setup-(\d+\.\d+\.\d+)\.exe$/i.exec(fileName)
  if (windows) return { version: windows[1], platform: 'win32' as const, arch: 'x64' as const }
  // Unsigned test artifacts must never be advertised as public stable releases.
  const mac = /^LawVerify-Mac-(\d+\.\d+\.\d+)-(arm64|x64)\.dmg$/i.exec(fileName)
  if (mac) return { version: mac[1], platform: 'darwin' as const, arch: mac[2].toLowerCase() as 'arm64' | 'x64' }
  return null
}
