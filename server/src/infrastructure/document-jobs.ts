import { copyFile, mkdir, mkdtemp, readFile, rename, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { AppError } from '../core/app-error.js'
import { env } from '../config/env.js'
import { getRuntimeRoot, getWorkspaceDataDir } from '../config/paths.js'
import { parsePdfOnDisk } from './pdf-segments.js'

export interface ParsedDocumentBlock {
  page: number
  bbox: number[]
  coordinateSpace: string
  text: string
  locator?: string
}

export interface ParsedArtifact {
  schemaVersion: number
  engineVersion: string
  text: string
  html?: string
  pages: number
  blocks: ParsedDocumentBlock[]
  layout?: { pages: number; blocks: ParsedDocumentBlock[] }
  warnings: string[]
  reviewRequired: boolean
  chat?: { title: string; group?: boolean; messages: Array<{ sender: string; text: string; bbox: number[]; time_context?: string; display_name?: string }> }
}

export function supportsDocumentParsing(fileName: string, mimeType = '') {
  return /\.(docx?|rtf|pdf|png|jpe?g|webp|bmp|tiff?|txt|md|markdown|csv|tsv|json|log|gif)$/i.test(fileName)
    || /^text\//i.test(mimeType) || /^application\/rtf$/i.test(mimeType)
}

export async function readParsedArtifact(location: string): Promise<ParsedArtifact> {
  if ((await stat(location)).size > 64 * 1024 ** 2) {
    throw new AppError('解析结果过大。', 502, 'PARSER_RESULT_TOO_LARGE')
  }
  const result = JSON.parse(await readFile(location, 'utf8')) as ParsedArtifact
  if (result.schemaVersion !== 1 || typeof result.text !== 'string'
    || (result.html !== undefined && typeof result.html !== 'string')
    || result.text.length + (result.html?.length ?? 0) > 8_000_000
    || !Array.isArray(result.blocks) || !Array.isArray(result.warnings)) throw new Error('解析结果格式无效')
  return result
}

export function documentText(result: ParsedArtifact) {
  return (result.html ? result.blocks.map(block => block.text).join('\n\n') : result.text).trim()
}

export function parserRoot() {
  return path.join(getWorkspaceDataDir(), 'parsing')
}

interface DocumentParserPool {
  run(input: Record<string, unknown>, signal: AbortSignal): Promise<unknown>
  close(): Promise<void>
}

let parserPool: Promise<DocumentParserPool> | undefined

async function createParserPool(): Promise<DocumentParserPool> {
  const bundle = env.PARSER_BUNDLE_ROOT
  const source = !bundle ? [path.resolve(getRuntimeRoot(), '../python-workers'),
    fileURLToPath(new URL('../../../python-workers', import.meta.url))]
    .find(directory => existsSync(path.join(directory, 'worker.py'))) : undefined
  const scripts = bundle ? path.join(bundle, 'python') : source
  const runtime = bundle ?? (source && path.resolve(source, '../tmp'))
  const executable = process.platform === 'win32' ? ['python.exe'] : ['bin', 'python3']
  const bundledPython = runtime && path.join(runtime, 'python-runtime', ...executable)
  const python = (!bundle && env.LAWVERIFY_PYTHON?.trim())
    || (bundledPython && existsSync(bundledPython) ? bundledPython : undefined)
  const models = bundle ? path.join(bundle, 'mineru-home') : env.LAWVERIFY_MINERU_HOME || (source && path.join(source, 'mineru-home'))
  if (!python || !scripts || !existsSync(path.join(scripts, 'worker.py'))) {
    throw new AppError('本机 Python 解析环境尚未就绪，请检查安装或开发配置。', 503, 'PARSER_NOT_CONFIGURED')
  }
  const { HttpWorkerPool } = await import(pathToFileURL(path.join(scripts, 'http-worker-pool.mjs')).href)
  return new HttpWorkerPool({ python, script: path.join(scripts, 'worker.py'), size: env.PARSER_WORKERS,
    desktopResources: { keepWarm: Boolean(bundle), gpu: process.platform === 'win32' && ['auto', 'gpu'].includes(env.PARSER_DEVICE),
      preferGpu: env.PARSER_DEVICE === 'gpu' },
    maxQueued: 16, startupTimeoutMs: 300_000, taskTimeoutMs: env.PARSER_TIMEOUT_MS,
    workerEnv: { LAWVERIFY_PARSER_ROOT: parserRoot(), LAWVERIFY_MINERU_HOME: models,
      MINERU_MODEL_ONNX_DEVICE: env.PARSER_DEVICE, LAWVERIFY_PARSER_BUNDLED: bundle ? '1' : '0',
      PYTHONHOME: undefined, PYTHONPATH: undefined, PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1' },
  })
}

async function getParserPool() {
  const pending = parserPool ??= createParserPool()
  try {
    return await pending
  } catch (error) {
    if (parserPool === pending) parserPool = undefined
    throw error
  }
}

export async function warmupDocumentParser() {
  await (await getParserPool()).run({ action: 'warmup' }, AbortSignal.timeout(env.PARSER_TIMEOUT_MS))
}

export async function closeDocumentParser() {
  const pool = parserPool
  parserPool = undefined
  if (pool) await (await pool).close()
}

function documentSuffix(fileName: string) {
  return path.extname(fileName).replace(/[^.a-z0-9]/gi, '').toLowerCase()
}

export async function runDocumentParsing(inputPath: string, outputPath: string, fileName: string,
  mimeType?: string, mode?: string, cancellation?: AbortSignal, batchSize?: number, pdfCheckpoint?: string) {
  const timeout = AbortSignal.timeout(env.PARSER_TIMEOUT_MS)
  const signal = cancellation ? AbortSignal.any([timeout, cancellation]) : timeout
  let directory: string | undefined
  try {
    signal.throwIfAborted()
    const pool = await getParserPool()
    await mkdir(path.dirname(outputPath), { recursive: true })
    directory = await mkdtemp(path.join(path.dirname(outputPath), '.parse-'))
    const temporary = path.join(directory, 'result.json')
    const suffix = documentSuffix(fileName)
    const input = path.extname(inputPath).toLowerCase() === suffix ? inputPath : path.join(directory, `source${suffix}`)
    if (input !== inputPath) await copyFile(inputPath, input)
    const sizeBytes = (await stat(input).catch(() => undefined))?.size
    const job = { action: 'parse', inputPath: input, outputPath: temporary, fileName,
      mimeType: mimeType || '', mode: mode || 'auto', batchSize, sizeBytes }
    if (suffix === '.pdf' && !/^text\/|^application\/rtf$/i.test(job.mimeType)) {
      await parsePdfOnDisk({ directory, input: job, signal, checkpoint: pdfCheckpoint,
        run: request => pool.run(request, signal), readArtifact: readParsedArtifact })
    } else await pool.run(job, signal)
    const result = await readParsedArtifact(temporary)
    signal.throwIfAborted()
    await rename(temporary, outputPath)
    return result
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (timeout.aborted || code === 'PARSER_TIMEOUT') throw new AppError('本机解析超时，请拆分材料后重试。', 504, 'PARSER_TIMEOUT')
    if (error instanceof Error && code === 'PARSE_FAILED') throw new AppError(error.message, 422, code)
    if (error instanceof Error && code === 'PARSER_QUEUE_FULL') throw new AppError(error.message, 429, code)
    if (error instanceof Error && code === 'PARSER_MEMORY_LIMIT') throw new AppError(error.message, 503, code)
    if (error instanceof Error && code === 'PARSER_RESULT_TOO_LARGE') throw new AppError(error.message, 502, code)
    throw error
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined)
  }
}

export async function parseDocument(source: Buffer | string, fileName: string, mimeType?: string) {
  if (!supportsDocumentParsing(fileName, mimeType)) {
    throw new AppError('当前文件格式尚未接入解析。', 415, 'DOCUMENT_FORMAT_UNSUPPORTED')
  }
  const size = typeof source === 'string' ? (await stat(source)).size : source.length
  if (size > env.MAX_EVIDENCE_FILE_MB * 1024 ** 2) {
    throw new AppError('文件超过解析大小上限。', 413, 'DOCUMENT_TOO_LARGE')
  }
  const root = parserRoot()
  await mkdir(root, { recursive: true })
  const directory = await mkdtemp(path.join(root, 'document-'))
  const output = path.join(directory, 'result.json')
  const input = typeof source === 'string' ? source : path.join(directory, 'source' + documentSuffix(fileName))
  try {
    if (typeof source !== 'string') await writeFile(input, source)
    return await runDocumentParsing(input, output, fileName, mimeType)
  } finally {
    await Promise.allSettled([output, ...(typeof source === 'string' ? [] : [input])].map(file => unlink(file)))
    await rmdir(directory).catch(() => undefined)
  }
}
