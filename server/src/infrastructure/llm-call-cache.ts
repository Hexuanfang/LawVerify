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

interface LlmCallCacheFile {
  version: number
  entries: LlmCallCacheEntry[]
}

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

function readCacheFile(): LlmCallCacheFile {
  try {
    const raw = readFileSync(resolveCacheFile(), 'utf8')
    const parsed = JSON.parse(raw) as LlmCallCacheFile
    if (parsed?.version !== CACHE_VERSION || !Array.isArray(parsed.entries)) {
      return { version: CACHE_VERSION, entries: [] }
    }
    return parsed
  } catch {
    return { version: CACHE_VERSION, entries: [] }
  }
}

function writeCacheFile(file: LlmCallCacheFile) {
  try {
    const filePath = resolveCacheFile()
    mkdirSync(path.dirname(filePath), { recursive: true })
    const tempPath = `${filePath}.tmp`
    writeFileSync(tempPath, JSON.stringify(file), 'utf8')
    renameSync(tempPath, filePath)
  } catch (error) {
    // 缓存写入失败不应影响主流程。
    console.error('LLM call cache write failed:', error instanceof Error ? error.message : String(error))
  }
}

function pruneEntries(entries: LlmCallCacheEntry[]) {
  const byNamespace = new Map<string, LlmCallCacheEntry[]>()
  for (const entry of entries) {
    const list = byNamespace.get(entry.namespace) ?? []
    list.push(entry)
    byNamespace.set(entry.namespace, list)
  }

  const pruned: LlmCallCacheEntry[] = []
  for (const [namespace, list] of byNamespace) {
    const sorted = [...list].sort((left, right) => right.savedAt.localeCompare(left.savedAt))
    pruned.push(...sorted.slice(0, MAX_ENTRIES_PER_NAMESPACE))
  }

  return pruned
    .sort((left, right) => right.savedAt.localeCompare(left.savedAt))
    .slice(0, MAX_TOTAL_ENTRIES)
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
  const file = readCacheFile()
  const cached = file.entries.find((entry) => entry.key === key)
  if (cached) {
    hitCount += 1
    return { value: cached.value as T, reused: true }
  }

  const value = await run()

  await new Promise<void>((resolve) => {
    scheduleCacheWrite(() => {
      try {
        const latest = readCacheFile()
        const entries = pruneEntries([
          ...latest.entries.filter((entry) => entry.key !== key),
          { key, namespace, value, savedAt: new Date().toISOString() },
        ])
        writeCacheFile({ version: CACHE_VERSION, entries })
      } catch (error) {
        // 缓存写入失败不应影响主流程。
        console.error('LLM call cache update failed:', error instanceof Error ? error.message : String(error))
      }
      resolve()
    })
  })

  return { value, reused: false }
}
