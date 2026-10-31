function getUpdateFileName(version, platform = process.platform, arch = process.arch) {
  if (platform === 'darwin') return `LawVerify-Mac-${version}-${arch}.dmg`
  if (platform === 'win32') return `LawVerify-Setup-${version}.exe`
  throw new Error('This desktop platform does not support updates.')
}

function validateUpdateFileName(fileName, platform = process.platform, arch = process.arch, version) {
  const expected = platform === 'darwin' ? /\.dmg$/i : platform === 'win32' ? /\.exe$/i : null
  if (!expected?.test(fileName)) throw new Error('安装包与当前操作系统不匹配，请从官网下载正确版本。')
  if (version) {
    const nativeName = getUpdateFileName(version, platform, arch)
    const unsignedName = nativeName.replace(/(\.[^.]+)$/, '-unsigned$1')
    if (fileName !== nativeName && fileName !== unsignedName) {
      throw new Error('安装包版本或芯片类型不匹配，请从官网下载正确版本。')
    }
  }
  return fileName
}

module.exports = { getUpdateFileName, validateUpdateFileName }
