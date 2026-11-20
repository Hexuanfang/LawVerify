import { createHash } from 'node:crypto'
import { env } from '../config/env.js'
import { cloudAiFetch, isCloudAiEnabled } from './cloud-ai.js'
import { currentModelRedaction } from './model-redaction.js'

interface OpenAiEmbeddingResponse {
  data?: Array<{
    embedding?: number[]
    index?: number
  }>
}

const PASSAGE_CACHE_MAX_BYTES = 32 * 1024 * 1024
const PASSAGE_CACHE_MAX_ENTRIES = 4096
const PASSAGE_CACHE_TTL_MS = 30 * 60 * 1000
const passageCache = new Map<string, { vector: Float32Array; expiresAt: number }>()
let passageCacheBytes = 0

function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.replace(/\/$/, '')
}

function resolveEmbeddingBaseUrl() {
  return env.EMBEDDING_BASE_URL?.trim() || env.LLM_BASE_URL?.trim() || ''
}

function resolveEmbeddingApiKey() {
  return env.EMBEDDING_API_KEY?.trim() || env.LLM_API_KEY?.trim() || ''
}

export function isEmbeddingConfigured() {
  return isCloudAiEnabled() || Boolean(resolveEmbeddingBaseUrl() && env.EMBEDDING_MODEL?.trim())
}

export function getEmbeddingBatchSize() {
  return isCloudAiEnabled() ? Math.min(env.EMBEDDING_BATCH_SIZE, 32) : env.EMBEDDING_BATCH_SIZE
}

export function getEmbeddingRuntimeStatus() {
  return {
    configured: isEmbeddingConfigured(),
    provider: env.EMBEDDING_PROVIDER,
    model: env.EMBEDDING_MODEL ?? null,
    baseUrl: resolveEmbeddingBaseUrl() || null,
    batchSize: getEmbeddingBatchSize(),
    timeoutMs: env.EMBEDDING_TIMEOUT_MS,
    dimension: env.EMBEDDING_DIMENSION ?? null,
  }
}

function prepareEmbeddingInputs(input: string[]) {
  const redaction = currentModelRedaction()
  if (!redaction) return input
  input.forEach(text => redaction.learnText(text))
  return input.map(text => redaction.redact(text))
}

export function maskTextForEvidenceEmbedding(text: string) {
  const redaction = currentModelRedaction()
  redaction?.learnText(text)
  return redaction?.maskForEmbedding(text) ?? text
}

async function requestEmbeddings(input: string[], signal?: AbortSignal) {
  signal?.throwIfAborted()
  if (!isEmbeddingConfigured()) {
    throw new Error('Embedding 尚未配置，请先设置 EMBEDDING_BASE_URL 与 EMBEDDING_MODEL。')
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }

  const apiKey = resolveEmbeddingApiKey()
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`
  }

  const timeout = AbortSignal.timeout(env.EMBEDDING_TIMEOUT_MS)
  const response = isCloudAiEnabled() ? await cloudAiFetch('embeddings', { input }, undefined, signal) : await fetch(`${normalizeBaseUrl(resolveEmbeddingBaseUrl())}/embeddings`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: env.EMBEDDING_MODEL,
      input,
      dimensions: env.EMBEDDING_DIMENSION,
      encoding_format: 'float',
    }),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`Embedding 调用失败（${response.status}）：${detail || response.statusText}`)
  }

  const payload = await response.json() as OpenAiEmbeddingResponse
  const data = [...(payload.data ?? [])].sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
  const embeddings = data.map((item) => item.embedding ?? [])

  if (embeddings.length !== input.length || embeddings.some((item) => !item.length)) {
    throw new Error('Embedding 服务未返回完整向量结果。')
  }

  return embeddings
}

export async function createEmbeddings(input: string[], signal?: AbortSignal) {
  if (!input.length) {
    return [] as number[][]
  }

  const normalized = input.map((item) => item.trim())
  const results: number[][] = []
  const batchSize = getEmbeddingBatchSize()

  for (let index = 0; index < normalized.length; index += batchSize) {
    const batch = normalized.slice(index, index + batchSize)
    const vectors = await requestEmbeddings(prepareEmbeddingInputs(batch), signal)
    results.push(...vectors)
  }

  return results
}

function deletePassageVector(key: string) {
  const entry = passageCache.get(key)
  if (!entry) return
  passageCacheBytes -= entry.vector.byteLength
  passageCache.delete(key)
}

export async function createEvidencePassageEmbeddings(scope: string, input: string[], signal?: AbortSignal) {
  signal?.throwIfAborted()
  const texts = input.map(text => text.trim())
  const redaction = currentModelRedaction()
  texts.forEach(text => redaction?.learnText(text))
  const prepared = texts.map(text => redaction?.maskForEmbedding(text) ?? text)
  // 网关选择的实际模型版本不在本地配置中，无法确认版本时只在本次请求内去重。
  const reuse = !isCloudAiEnabled()
  const modelKey = JSON.stringify([scope, resolveEmbeddingBaseUrl(),
    env.EMBEDDING_PROVIDER, env.EMBEDDING_MODEL, env.EMBEDDING_DIMENSION])
  const results: Float32Array[] = new Array(texts.length)
  const missing = new Map<string, { positions: number[]; key?: string }>()
  for (const [index, text] of prepared.entries()) {
    const key = reuse ? createHash('sha256').update(modelKey).update('\0').update(text).digest('hex') : undefined
    const entry = key ? passageCache.get(key) : undefined
    if (entry && key && entry.expiresAt > Date.now()) {
      passageCache.delete(key)
      passageCache.set(key, entry)
      results[index] = entry.vector
      continue
    }
    if (entry && key) deletePassageVector(key)
    const pending = missing.get(text) ?? { positions: [], key }
    pending.positions.push(index)
    missing.set(text, pending)
  }

  const pending = [...missing]
  const batchSize = getEmbeddingBatchSize()
  for (let offset = 0; offset < pending.length; offset += batchSize) {
    const batch = pending.slice(offset, offset + batchSize)
    const vectors = await requestEmbeddings(batch.map(([text]) => text), signal)
    signal?.throwIfAborted()
    for (const [index, [, { key, positions }]] of batch.entries()) {
      const vector = Float32Array.from(vectors[index])
      for (const position of positions) results[position] = vector
      if (!key || vector.byteLength > PASSAGE_CACHE_MAX_BYTES) continue
      deletePassageVector(key)
      passageCache.set(key, { vector, expiresAt: Date.now() + PASSAGE_CACHE_TTL_MS })
      passageCacheBytes += vector.byteLength
    }
    while (passageCacheBytes > PASSAGE_CACHE_MAX_BYTES || passageCache.size > PASSAGE_CACHE_MAX_ENTRIES) {
      const oldest = passageCache.keys().next().value
      if (oldest === undefined) break
      deletePassageVector(oldest)
    }
  }
  return results
}

export async function createEmbedding(input: string) {
  const [embedding] = await createEmbeddings([input])

  if (!embedding?.length) {
    throw new Error('Embedding 服务未返回有效向量。')
  }

  return embedding
}
