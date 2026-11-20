import { existsSync, readFileSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile, readFile, rm, rename, stat } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

interface ResourceManifest {
  schemaVersion: number
  platform: string
  arch: string
  engineVersion: string
  sha256: string
  size: number
  url: string
}

interface DownloadOptions {
  fetch?: typeof globalThis.fetch
  headerTimeoutMs?: number
  idleTimeoutMs?: number
  totalTimeoutMs?: number
}

const execute = promisify(execFile)
const pending = new Map<string, Promise<string>>()

function safeResourcePath(entry: string) {
  return !entry.includes('\\') && !entry.includes(':')
    && !entry.split('/').some(part => part === '..' || part === '.')
    && /^(python-runtime|mineru-home)(\/|$)/.test(entry)
}

function resourceError(message: string) {
  return Object.assign(new Error(message), { code: 'PARSER_RESOURCE_UNAVAILABLE' })
}

function readManifest(runtimeRoot: string): ResourceManifest | undefined {
  const file = path.join(runtimeRoot, 'parser-resource.json')
  if (!existsSync(file)) return undefined
  if (statSync(file).size > 16384) throw resourceError('解析资源清单过大。')
  const manifest = JSON.parse(readFileSync(file, 'utf8')) as ResourceManifest
  if (manifest.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(manifest.sha256)
    || !Number.isSafeInteger(manifest.size) || manifest.size <= 0 || manifest.size > 4 * 1024 ** 3
    || typeof manifest.engineVersion !== 'string') throw resourceError('解析资源清单无效。')
  if (manifest.platform !== process.platform || manifest.arch !== process.arch) {
    throw resourceError('解析资源平台或架构与当前客户端不匹配。')
  }
  const url = new URL(manifest.url)
  if (url.protocol !== 'https:' || url.username || url.password) throw resourceError('解析资源下载地址无效。')
  return manifest
}

function validEnvironment(root: string, manifest: ResourceManifest) {
  try {
    const runtime = JSON.parse(readFileSync(path.join(root, 'python-runtime/lawverify-runtime.json'), 'utf8'))
    const arch = ({ AMD64: 'x64', x86_64: 'x64', aarch64: 'arm64' } as Record<string, string>)[runtime.architecture] || runtime.architecture
    return runtime.platform === manifest.platform && arch === manifest.arch && runtime.engineVersion === manifest.engineVersion
      && statSync(path.join(root, 'python-runtime/python.exe')).isFile()
      && statSync(path.join(root, 'mineru-home/models/MinerU-4_models_onnx')).isDirectory()
  } catch {
    return false
  }
}

function isReady(root: string, manifest: ResourceManifest) {
  try {
    const marker = JSON.parse(readFileSync(path.join(root, '.ready.json'), 'utf8'))
    return marker.sha256 === manifest.sha256 && validEnvironment(root, manifest)
  } catch {
    return false
  }
}

async function cacheComplete(root: string, manifest: ResourceManifest) {
  if (!isReady(root, manifest)) return false
  try {
    const marker = JSON.parse(await readFile(path.join(root, '.ready.json'), 'utf8'))
    const files = marker.files as Array<[string, number]>
    if (!Array.isArray(files) || files.length === 0 || files.length > 100000) return false
    // 分批异步检查文件大小，缓存缺失或截断时允许重新获取。
    for (let offset = 0; offset < files.length; offset += 64) {
      const results = await Promise.all(files.slice(offset, offset + 64).map(async ([relative, size]) => {
        if (typeof relative !== 'string' || !safeResourcePath(relative) || !Number.isSafeInteger(size)) return false
        const file = await stat(path.join(root, relative))
        return file.isFile() && file.size === size
      }))
      if (results.some(result => !result)) return false
    }
    return true
  } catch {
    return false
  }
}

function activeResourceRoot(versionRoot: string) {
  try {
    const { generation } = JSON.parse(readFileSync(path.join(versionRoot, 'active.json'), 'utf8'))
    if (!/^[a-f0-9]{12}$/.test(generation)) return undefined
    return path.join(versionRoot, generation)
  } catch {
    return undefined
  }
}

export function downloadedParserRoot(runtimeRoot: string, cacheRoot: string) {
  const manifest = readManifest(runtimeRoot)
  if (!manifest) return undefined
  const target = activeResourceRoot(path.resolve(cacheRoot, manifest.sha256.slice(0, 24)))
  return target && isReady(target, manifest) ? target : undefined
}

async function download(manifest: ResourceManifest, destination: string, options: DownloadOptions) {
  const controller = new AbortController()
  const abort = () => controller.abort(resourceError('首次解析资源下载超时，请检查网络后重试。'))
  let idle = setTimeout(abort, options.headerTimeoutMs ?? 30000)
  const total = setTimeout(abort, options.totalTimeoutMs ?? 3600000)
  let response: Response | undefined
  try {
    console.info('首次使用正在下载本地解析资源，请保持网络连接。')
    response = await (options.fetch ?? globalThis.fetch)(manifest.url, { signal: controller.signal, redirect: 'follow' })
    if (!response.ok || !response.body) throw resourceError(`解析资源下载失败（${response.status}），请稍后重试。`)
    const hash = createHash('sha256')
    let received = 0
    const resetIdle = () => {
      clearTimeout(idle)
      idle = setTimeout(abort, options.idleTimeoutMs ?? 60000)
    }
    resetIdle()
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length
        if (received > manifest.size) {
          callback(resourceError('解析资源大小超过清单限制。'))
          return
        }
        resetIdle()
        hash.update(chunk)
        callback(null, chunk)
      },
    })
    await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), meter,
      createWriteStream(destination, { flags: 'wx' }), { signal: controller.signal })
    if (received !== manifest.size || hash.digest('hex') !== manifest.sha256) {
      throw resourceError('解析资源完整性校验失败，请重新尝试解析。')
    }
  } catch (error) {
    await response?.body?.cancel().catch(() => undefined)
    if (controller.signal.aborted) throw controller.signal.reason
    throw error
  } finally {
    clearTimeout(idle)
    clearTimeout(total)
  }
}

async function publishPointer(source: string, destination: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(source, destination)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (attempt >= 7 || !['EPERM', 'EACCES', 'EBUSY'].includes(code || '')) throw error
      await new Promise(resolve => setTimeout(resolve, Math.min(1600, 100 * 2 ** attempt)))
    }
  }
}

async function installResource(manifest: ResourceManifest, cacheRoot: string, options: DownloadOptions) {
  await mkdir(cacheRoot, { recursive: true })
  // 缩短路径以兼容 Windows 原生 DLL 的 MAX_PATH 限制，完整哈希仍由清单和就绪标记核验。
  const versionRoot = path.resolve(cacheRoot, manifest.sha256.slice(0, 24))
  const active = activeResourceRoot(versionRoot)
  if (active && await cacheComplete(active, manifest)) return active
  const staging = await mkdtemp(path.join(cacheRoot, '.install-'))
  const archive = path.join(staging, 'resource.tar.gz')
  const generation = randomUUID().replaceAll('-', '').slice(0, 12)
  const extracted = path.join(versionRoot, generation)
  let created = false
  let published = false
  try {
    await download(manifest, archive, options)
    const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/tar.exe') : 'tar'
    const runOptions = { windowsHide: true, timeout: 600000, maxBuffer: 16 * 1024 ** 2 }
    const listing = await execute(tar, ['-tzf', archive], runOptions)
    const entries = listing.stdout.trim().split(/\r?\n/)
    if (!entries.length || entries.length > 100000 || !entries.every(safeResourcePath)) {
      throw resourceError('解析资源压缩包包含非法路径。')
    }
    const verbose = await execute(tar, ['-tvzf', archive], runOptions)
    if (!verbose.stdout.trim().split(/\r?\n/).every(line => /^[-d]/.test(line))) {
      throw resourceError('解析资源压缩包包含不支持的链接。')
    }
    await mkdir(versionRoot, { recursive: true })
    // 直接解压到尚未发布的独立目录，避免 Windows 扫描器占用新 DLL 时目录改名失败。
    await mkdir(extracted)
    created = true
    await execute(tar, ['-xzf', archive, '-C', extracted, '--no-same-owner'], runOptions)
    if (!validEnvironment(extracted, manifest)) throw resourceError('解析资源环境不完整或版本不匹配。')
    const files: Array<[string, number]> = []
    for (const entry of entries) {
      const file = await stat(path.join(extracted, entry))
      if (file.isFile()) files.push([entry, file.size])
    }
    await writeFile(path.join(extracted, '.ready.json'), JSON.stringify({ sha256: manifest.sha256, files }))
    const concurrent = activeResourceRoot(versionRoot)
    if (concurrent && await cacheComplete(concurrent, manifest)) return concurrent
    // 每次发布独立目录，只原子替换小型指针，避免跨进程删除正在使用的 DLL 或模型。
    const pointer = path.join(versionRoot, `.active-${generation}.json`)
    await writeFile(pointer, JSON.stringify({ generation }))
    await publishPointer(pointer, path.join(versionRoot, 'active.json'))
    published = true
    console.info('本地解析资源已就绪，后续使用将复用本机缓存。')
    return extracted
  } finally {
    await rm(staging, { recursive: true, force: true })
    if (created && !published) await rm(extracted, { recursive: true, force: true })
  }
}

export async function ensureParserResources(runtimeRoot: string, cacheRoot: string, options: DownloadOptions = {}) {
  const manifest = readManifest(runtimeRoot)
  if (!manifest) return undefined
  const key = path.resolve(cacheRoot, manifest.sha256)
  let task = pending.get(key)
  if (!task) {
    task = installResource(manifest, cacheRoot, options).finally(() => pending.delete(key))
    pending.set(key, task)
  }
  return task
}
