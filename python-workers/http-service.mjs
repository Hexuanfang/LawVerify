import { createServer } from 'node:http'
import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { HttpWorkerPool } from './http-worker-pool.mjs'
import { createParserAuthenticator } from './parser-auth.mjs'

function serviceError(status, code, message) {
  return Object.assign(new Error(message), { status, code })
}

export function createParserServer({ pool, root, token, publicKey, maxBytes = 512 * 1024 ** 2, maxPending = 16,
  maxAccountPending = 2, maxInFlightBytes = 1024 ** 3, maxAccountInFlightBytes = maxBytes,
  timeoutMs = 900000, isReady = () => true }) {
  if (![maxBytes, maxPending, maxAccountPending, maxInFlightBytes, maxAccountInFlightBytes, timeoutMs]
    .every(value => Number.isSafeInteger(value) && value > 0)) {
    throw new Error('解析服务的容量和超时配置必须为正整数')
  }
  const authenticate = createParserAuthenticator({ token, publicKey })
  const accounts = new Map()
  let pending = 0
  let inFlightBytes = 0
  const server = createServer(async (request, response) => {
    let directory
    let account
    let usage
    let accepted = false
    let reservedBytes = 0
    const release = () => {
      if (!accepted) return
      accepted = false
      pending--
      inFlightBytes -= reservedBytes
      if (!usage) return
      usage.bytes -= reservedBytes
      if (--usage.pending === 0) accounts.delete(account)
    }
    const reserve = bytes => {
      if (usage && usage.bytes + bytes > maxAccountInFlightBytes) {
        throw serviceError(429, 'PARSER_ACCOUNT_UPLOAD_LIMIT', '当前账号在途材料过大，请稍后重试')
      }
      if (inFlightBytes + bytes > maxInFlightBytes) throw serviceError(429, 'PARSER_UPLOAD_LIMIT', '在途材料较多，请稍后重试')
      reservedBytes += bytes
      inFlightBytes += bytes
      if (usage) usage.bytes += bytes
    }
    const disconnected = new AbortController()
    const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), disconnected.signal])
    response.once('close', () => {
      if (!response.writableEnded) disconnected.abort(new Error('解析请求连接已断开'))
    })
    try {
      const url = new URL(request.url, 'http://parser')
      if (request.method === 'GET' && url.pathname === '/health') {
        response.writeHead(isReady() ? 200 : 503, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ status: isReady() ? 'ok' : 'starting', pending }))
        return
      }
      if (request.method !== 'POST' || url.pathname !== '/parse') {
        throw serviceError(404, 'NOT_FOUND', '接口不存在')
      }
      const identity = authenticate(request.headers.authorization)
      if (!identity) throw serviceError(401, 'UNAUTHORIZED', '解析服务凭据无效或已过期')
      account = identity.userId
      if (!isReady()) throw serviceError(503, 'PARSER_STARTING', '解析模型正在启动')
      const fileName = url.searchParams.get('fileName') || ''
      const mimeType = url.searchParams.get('mimeType') || ''
      const mode = url.searchParams.get('mode') || 'auto'
      if (!fileName || fileName.length > 255 || /[\\/\x00-\x1f]/.test(fileName)
        || mimeType.length > 200 || !['auto', 'document', 'chat'].includes(mode)) {
        throw serviceError(400, 'INVALID_INPUT', '文件名或解析模式无效')
      }
      const declaredBytes = Number(request.headers['content-length'] ?? 0)
      if (declaredBytes > maxBytes) {
        throw serviceError(413, 'DOCUMENT_TOO_LARGE', '文件超过解析大小上限')
      }
      if (account) usage = accounts.get(account) ?? { pending: 0, bytes: 0 }
      if (usage && usage.pending >= maxAccountPending) {
        throw serviceError(429, 'PARSER_ACCOUNT_LIMIT', '当前账号的解析任务较多，请稍后重试')
      }
      if (pending >= maxPending) throw serviceError(429, 'PARSER_QUEUE_FULL', '解析任务较多，请稍后重试')
      reserve(declaredBytes)
      pending++
      accepted = true
      if (usage) {
        usage.pending++
        accounts.set(account, usage)
      }
      const taskId = randomUUID()
      await mkdir(root, { recursive: true })
      directory = await mkdtemp(path.join(root, `request-${taskId}-`))
      const inputPath = path.join(directory, `source${path.extname(fileName).replace(/[^.a-z0-9]/gi, '')}`)
      const outputPath = path.join(directory, 'result.json')
      let bytes = 0
      const limit = new Transform({ transform(chunk, _encoding, callback) {
        bytes += chunk.length
        try {
          if (bytes > maxBytes) throw serviceError(413, 'DOCUMENT_TOO_LARGE', '文件超过解析大小上限')
          if (bytes > reservedBytes) reserve(bytes - reservedBytes)
          callback(null, chunk)
        } catch (error) { callback(error) }
      } })
      // 请求流与 pipeline 分离，超限时仍能向客户端返回结构化错误。
      const aborted = () => limit.destroy(serviceError(400, 'UPLOAD_INTERRUPTED', '文件上传中断'))
      request.once('aborted', aborted)
      request.pipe(limit)
      try {
        await pipeline(limit, createWriteStream(inputPath), { signal })
      } finally {
        request.unpipe(limit)
        request.removeListener('aborted', aborted)
        request.resume()
      }
      if (!bytes) throw serviceError(400, 'EMPTY_DOCUMENT', '文件内容为空')
      await pool.run({ action: 'parse', inputPath, outputPath, fileName, mimeType, mode }, signal, account)
      const size = (await stat(outputPath)).size
      if (size > 64 * 1024 ** 2) throw serviceError(422, 'PARSER_RESULT_TOO_LARGE', '解析结果过大，请拆分材料')
      // 原件可在 worker 完成后删除，读取结果期间继续保留请求目录。
      const result = await readFile(outputPath)
      await rm(directory, { recursive: true, force: true })
      directory = undefined
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': size,
        'Cache-Control': 'no-store', 'X-Parser-Task-Id': taskId })
      await new Promise(resolve => {
        response.once('close', resolve)
        response.end(result, resolve)
      })
    } catch (error) {
      if (directory) {
        await rm(directory, { recursive: true, force: true }).catch(() => undefined)
        directory = undefined
      }
      release()
      const status = error.status || (signal.aborted ? 504 : error.code === 'PARSER_QUEUE_FULL' ? 429
        : /TIMEOUT/.test(error.code || '') ? 504 : 422)
      const message = error.status ? error.message : status === 504 ? '材料解析超时，请拆分后重试' : '材料解析失败，请检查原件或人工审核'
      if (!response.headersSent && !response.destroyed) {
        response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
          ...(status === 429 ? { 'Retry-After': '2' } : {}) })
        response.end(JSON.stringify({ error: { code: error.code || 'PARSE_FAILED', message } }))
      }
      request.resume()
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined)
      release()
    }
  })
  server.requestTimeout = timeoutMs
  server.headersTimeout = Math.min(60000, timeoutMs)
  return server
}

async function start() {
  const root = process.env.LAWVERIFY_PARSER_ROOT || '/data/parsing'
  const timeoutMs = Number(process.env.PARSER_TIMEOUT_MS || 900000)
  const workers = Number(process.env.PARSER_WORKERS || 1)
  if (!Number.isInteger(workers) || workers < 1 || workers > 4) throw new Error('PARSER_WORKERS 须为 1 到 4 的整数')
  const pool = new HttpWorkerPool({
    python: process.env.LAWVERIFY_PYTHON || 'python3',
    script: fileURLToPath(new URL('worker.py', import.meta.url)),
    size: workers,
    startupTimeoutMs: 300000, taskTimeoutMs: timeoutMs,
    workerEnv: { LAWVERIFY_PARSER_ROOT: root, LAWVERIFY_MINERU_HOME: process.env.LAWVERIFY_MINERU_HOME || '/models',
      MINERU_MODEL_ONNX_DEVICE: process.env.PARSER_DEVICE || 'cpu' },
  })
  let ready = false
  const server = createParserServer({ pool, root, token: process.env.PARSER_SERVICE_TOKEN,
    publicKey: process.env.PARSER_TICKET_PUBLIC_KEY, timeoutMs, maxPending: Number(process.env.PARSER_MAX_PENDING || 16),
    maxAccountPending: Number(process.env.PARSER_MAX_ACCOUNT_PENDING || 2),
    maxInFlightBytes: Number(process.env.PARSER_MAX_IN_FLIGHT_MB || 1024) * 1024 ** 2,
    maxAccountInFlightBytes: Number(process.env.PARSER_MAX_ACCOUNT_IN_FLIGHT_MB || 512) * 1024 ** 2, isReady: () => ready })
  server.listen(Number(process.env.PARSER_PORT || 8790), '0.0.0.0')
  await mkdir(root, { recursive: true })
  const warmup = await mkdtemp(path.join(root, 'warmup-'))
  try {
    const inputPath = path.join(warmup, 'ready.txt')
    await writeFile(inputPath, 'ready')
    await pool.run({ action: 'parse', inputPath, outputPath: path.join(warmup, 'result.json'), fileName: 'ready.txt' })
    ready = true
    console.log('解析模型已就绪')
  } finally {
    await rm(warmup, { recursive: true, force: true })
  }
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
    ready = false
    server.close(async () => { await pool.close(); process.exit(0) })
  })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  start().catch(error => { console.error('解析服务启动失败', error.code || error.name); process.exit(1) })
}
