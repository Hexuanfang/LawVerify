const fs = require('node:fs')
const { createHash } = require('node:crypto')
const { Readable, Transform } = require('node:stream')
const { pipeline } = require('node:stream/promises')

async function downloadInstaller({
  fetch, url, version, sha256, resolveTarget, onProgress = () => {},
  headerTimeoutMs = 30000, idleTimeoutMs = 60000, totalTimeoutMs = 900000,
}) {
  if (!/^[a-f0-9]{64}$/i.test(sha256)) throw new Error('缺少有效的安装包校验值。')
  const controller = new AbortController()
  const abort = () => controller.abort(new Error('更新下载超时，请检查网络后重试。'))
  let idleTimer = setTimeout(abort, headerTimeoutMs)
  const totalTimer = setTimeout(abort, totalTimeoutMs)
  let tempPath
  let response
  try {
    response = await fetch(url, { redirect: 'follow', signal: controller.signal })
    if (!response.ok || !response.body) {
      throw new Error(`更新安装包下载失败（${response.status || 'unknown'}）。`)
    }
    const target = resolveTarget(version, response)
    tempPath = target.tempPath
    const totalBytes = Number(response.headers.get('content-length') || '0')
    const hash = createHash('sha256')
    let receivedBytes = 0
    const resetIdle = () => {
      clearTimeout(idleTimer)
      idleTimer = setTimeout(abort, idleTimeoutMs)
    }
    resetIdle()
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        resetIdle()
        hash.update(chunk)
        receivedBytes += chunk.length
        const progress = totalBytes > 0 ? Math.min(100, Math.round(receivedBytes / totalBytes * 100)) : undefined
        onProgress({ status: 'downloading', version, progress,
          message: progress === undefined ? '正在下载更新安装包…' : `正在下载更新安装包… ${progress}%` })
        callback(null, chunk)
      },
    })
    // Pipeline closes the file before cleanup, including on stream and disk failures.
    await pipeline(Readable.fromWeb(response.body), meter, fs.createWriteStream(tempPath), {
      signal: controller.signal,
    })
    if (receivedBytes === 0 || (totalBytes > 0 && receivedBytes !== totalBytes)) {
      throw new Error('更新安装包下载不完整，请重新下载。')
    }
    if (hash.digest('hex') !== sha256.toLowerCase()) {
      throw new Error('安装包完整性校验失败，请重新下载更新。')
    }
    fs.rmSync(target.targetPath, { force: true })
    fs.renameSync(tempPath, target.targetPath)
    return target.targetPath
  } catch (error) {
    await response?.body?.cancel().catch(() => {})
    if (tempPath) fs.rmSync(tempPath, { force: true })
    if (controller.signal.aborted) throw controller.signal.reason
    throw error
  } finally {
    clearTimeout(idleTimer)
    clearTimeout(totalTimer)
  }
}

module.exports = { downloadInstaller }
