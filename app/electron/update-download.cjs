const fs = require('node:fs')
const { createHash } = require('node:crypto')
const { Readable, Transform } = require('node:stream')
const { pipeline } = require('node:stream/promises')

function isConnectionInterrupted(error) {
  const code = error?.cause?.code || error?.code || /^net::(ERR_[A-Z_]+)$/.exec(error?.message)?.[1]
  return [
    'ERR_CONNECTION_CLOSED', 'ERR_CONNECTION_RESET', 'ERR_CONNECTION_ABORTED',
    'ERR_CONTENT_LENGTH_MISMATCH', 'ERR_INCOMPLETE_CHUNKED_ENCODING', 'ERR_NETWORK_CHANGED',
    'ECONNRESET', 'UND_ERR_SOCKET',
  ].includes(code)
}

async function* readResumableBody(response, request, totalBytes, etag, signal) {
  let offset = 0
  for (let retries = 0; ; retries++) {
    try {
      if (retries > 0) {
        response = await request({ Range: `bytes=${offset}-`, 'If-Range': etag })
        const expectedRange = `bytes ${offset}-${totalBytes - 1}/${totalBytes}`
        if (response.status !== 206 || !response.body || response.headers.get('content-range') !== expectedRange
          || response.headers.get('etag') !== etag || response.headers.has('content-encoding')) {
          await response.body?.cancel().catch(() => {})
          throw new Error('服务器未返回匹配的安装包数据，无法续传，请重新下载。')
        }
      }
      for await (const chunk of response.body) {
        offset += chunk.byteLength
        yield chunk
      }
      return
    } catch (error) {
      if (retries >= 2 || offset >= totalBytes || signal.aborted || !isConnectionInterrupted(error)) throw error
    }
  }
}

async function downloadInstaller({
  fetch, url, version, sha256, resolveTarget, onProgress = () => {}, resume = false,
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
    const request = (headers) => fetch(url, { headers, redirect: 'follow', signal: controller.signal })
    response = await request().catch(error => {
      if (!resume || controller.signal.aborted || !isConnectionInterrupted(error)) throw error
      return request()
    })
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
    const etag = response.headers.get('etag')
    const canResume = resume && response.status === 200 && Number.isSafeInteger(totalBytes) && totalBytes > 0
      && response.headers.get('accept-ranges') === 'bytes' && /^"[^"]*"$/.test(etag)
      && !response.headers.has('content-encoding')
    const source = canResume
      ? Readable.from(readResumableBody(response, headers => {
        resetIdle()
        return request(headers)
      }, totalBytes, etag, controller.signal), { objectMode: false })
      : Readable.fromWeb(response.body)
    await pipeline(source, meter, fs.createWriteStream(tempPath), {
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
    if (resume && isConnectionInterrupted(error)) {
      throw new Error('更新下载连接中断，请重试，或从官网下载安装包。', { cause: error })
    }
    throw error
  } finally {
    clearTimeout(idleTimer)
    clearTimeout(totalTimer)
  }
}

module.exports = { downloadInstaller }
