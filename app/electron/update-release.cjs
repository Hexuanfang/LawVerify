function verifyUpdateRelease({ envelope, payload, currentVersion, platform, arch }) {
  const release = envelope?.data
  const version = String(payload?.version || '')
  const channel = payload?.channel === 'test' ? 'test' : 'stable'
  const current = currentVersion.split('.').map(Number)
  const next = version.split('.').map(Number)
  const newer = /^\d+\.\d+\.\d+$/.test(version) && (next[0] > current[0] || next[0] === current[0]
    && (next[1] > current[1] || next[1] === current[1] && next[2] > current[2]))
  let https = false
  try { https = new URL(payload.downloadUrl).protocol === 'https:' } catch {}
  if (!envelope?.success || !release || !newer || !https
    || release.version !== version || release.sha256 !== payload.sha256
    || !/^[a-f0-9]{64}$/i.test(release.sha256)
    || release.downloadUrl !== payload.downloadUrl || release.platform !== platform
    || release.arch !== arch || release.channel !== channel) {
    throw new Error('更新信息已变更或不适用于当前设备，请重新检查更新。')
  }
  return release
}

module.exports = { verifyUpdateRelease }
