import { env } from '../config/env.js'
import { cloudAiFetch, isCloudAiEnabled } from './cloud-ai.js'

interface OpenAiEmbeddingResponse {
  data?: Array<{
    embedding?: number[]
    index?: number
  }>
}

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

export function getEmbeddingRuntimeStatus() {
  return {
    configured: isEmbeddingConfigured(),
    provider: env.EMBEDDING_PROVIDER,
    model: env.EMBEDDING_MODEL ?? null,
    baseUrl: resolveEmbeddingBaseUrl() || null,
    batchSize: env.EMBEDDING_BATCH_SIZE,
    timeoutMs: env.EMBEDDING_TIMEOUT_MS,
    dimension: env.EMBEDDING_DIMENSION ?? null,
  }
}

async function requestEmbeddings(input: string[]) {
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

  const response = isCloudAiEnabled() ? await cloudAiFetch('embeddings', { input }) : await fetch(`${normalizeBaseUrl(resolveEmbeddingBaseUrl())}/embeddings`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: env.EMBEDDING_MODEL,
      input,
      dimensions: env.EMBEDDING_DIMENSION,
      encoding_format: 'float',
    }),
    signal: AbortSignal.timeout(env.EMBEDDING_TIMEOUT_MS),
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

export async function createEmbeddings(input: string[]) {
  if (!input.length) {
    return [] as number[][]
  }

  const normalized = input.map((item) => item.trim())
  const results: number[][] = []

  for (let index = 0; index < normalized.length; index += env.EMBEDDING_BATCH_SIZE) {
    const batch = normalized.slice(index, index + env.EMBEDDING_BATCH_SIZE)
    const vectors = await requestEmbeddings(batch)
    results.push(...vectors)
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
