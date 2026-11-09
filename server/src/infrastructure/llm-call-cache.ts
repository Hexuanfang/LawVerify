import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { getWorkspaceDataDir } from '../config/paths.js'
import { getCurrentWorkspaceAccount } from '../store.js'

// 模型调用缓存：让被用户中断的长任务（证据联动、生成改写）可以在下次执行时
// 直接复用已经完成的模型结果，而不是从头再跑一遍。
// key 由「命名空间 + 请求内容」哈希得到，提示词或输入变化会自动失效。

const CACHE_VERSION = 1
const MAX_ENTRIES_PER_NAMESPACE = 200
const MAX_TOTAL_ENTRIES = 600

interface LlmCallCacheEntry {
  key: string
  namespace: string
  value: unknown
  savedAt: string
}

// 缓存索引常驻内存：命中判断不需要读回文件再逐条比较，模型调用前后的等待不再
// 受缓存文件大小影响。每个缓存文件一份索引，进程内懒加载，落盘仍写回同样的文件。
const memoryIndexes = new Map<string, Map<string, LlmCallCacheEntry>>()

let hitCount = 0
// 写回串行队列：并发模型调用同时回写缓存时，避免相互覆盖导致缓存条目丢失。
let cacheWriteChain: Promise<void> = Promise.resolve()

function scheduleCacheWrite(task: () => void) {
  cacheWriteChain = cacheWriteChain.then(task, task)
}

function resolveCacheFile() {
  const account = getCurrentWorkspaceAccount()?.trim().toLowerCase()
  const slug = account
    ? account.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'default'
    : 'default'
  return path.join(getWorkspaceDataDir(), 'llm-cache', `${slug}.json`)
}

function loadCacheIndex(filePath: string) {
  const loaded = memoryIndexes.get(filePath)
  if (loaded) {
    return loaded
  }
  const index = new Map<string, LlmCallCacheEntry>()
  try {
    const raw = readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(raw) as { version?: number; entries?: LlmCallCacheEntry[] }
    if (parsed?.version === CACHE_VERSION && Array.isArray(parsed.entries)) {
      for (const entry of parsed.entries) {
        if (entry && typeof entry.key === 'string' && typeof entry.namespace === 'string') {
          index.set(entry.key, entry)
        }
      }
    }
  } catch {
    // 缓存文件缺失或损坏时按空缓存处理，不影响主流程。
  }
  memoryIndexes.set(filePath, index)
  return index
}

function writeCacheFile(filePath: string, index: Map<string, LlmCallCacheEntry>) {
  try {
    mkdirSync(path.dirname(filePath), { recursive: true })
    const tempPath = `${filePath}.tmp`
    writeFileSync(tempPath, JSON.stringify({ version: CACHE_VERSION, entries: [...index.values()] }), 'utf8')
    renameSync(tempPath, filePath)
  } catch (error) {
    // 缓存写入失败不应影响主流程。
    console.error('LLM call cache write failed:', error instanceof Error ? error.message : String(error))
  }
}

function pruneIndex(index: Map<string, LlmCallCacheEntry>) {
  const byNamespace = new Map<string, LlmCallCacheEntry[]>()
  for (const entry of index.values()) {
    const list = byNamespace.get(entry.namespace) ?? []
    list.push(entry)
    byNamespace.set(entry.namespace, list)
  }

  const kept = new Set<string>()
  for (const [namespace, list] of byNamespace) {
    const sorted = [...list].sort((left, right) => right.savedAt.localeCompare(left.savedAt))
    for (const entry of sorted.slice(0, MAX_ENTRIES_PER_NAMESPACE)) {
      kept.add(entry.key)
    }
  }

  const survivors = [...index.values()]
    .filter((entry) => kept.has(entry.key))
    .sort((left, right) => right.savedAt.localeCompare(left.savedAt))
    .slice(0, MAX_TOTAL_ENTRIES)
  const survivorKeys = new Set(survivors.map((entry) => entry.key))
  // 就地淘汰，避免替换索引对象时丢掉其它并发调用刚写入的条目。
  for (const key of [...index.keys()]) {
    if (!survivorKeys.has(key)) {
      index.delete(key)
    }
  }
}

function buildCacheKey(namespace: string, payload: unknown) {
  let serialized = ''
  try {
    serialized = JSON.stringify(payload) ?? ''
  } catch {
    serialized = String(payload)
  }
  return createHash('sha256').update(`${namespace}::${serialized}`).digest('hex')
}

/** 进程内命中的缓存次数，用于向前端提示“已复用模型结果”。 */
export function getLlmCallCacheHitCount() {
  return hitCount
}

export function resetLlmCallCacheHitCount() {
  hitCount = 0
}

/**
 * 复用已完成的模型调用结果；未命中时执行 run() 并写入缓存。
 * 缓存键包含完整请求内容，输入或提示词变化会自动失效。
 */
export async function withLlmCallCache<T>(
  namespace: string,
  payload: unknown,
  run: () => Promise<T>,
): Promise<{ value: T; reused: boolean }> {
  const key = buildCacheKey(namespace, payload)
  const filePath = resolveCacheFile()
  const index = loadCacheIndex(filePath)
  const cached = index.get(key)
  if (cached) {
    hitCount += 1
    return { value: cached.value as T, reused: true }
  }

  const value = await run()

  // 内存索引立即写入：并发调用之间也能看到对方刚完成的条目。
  index.set(key, { key, namespace, value, savedAt: new Date().toISOString() })
  pruneIndex(index)
  // 落盘不阻塞调用方：缓存只用于加速，进程退出前没写完也不影响结果。
  scheduleCacheWrite(() => writeCacheFile(filePath, index))

  return { value, reused: false }
}
