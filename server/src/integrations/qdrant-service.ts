import { env } from '../config/env.js'

type QdrantSearchHit = {
  id: string | number
  score: number
  payload?: Record<string, unknown>
}

type QdrantCollectionResponse = {
  result?: {
    config?: {
      params?: {
        vectors?: {
          size?: number
          distance?: string
        } | Record<string, unknown>
      }
    }
  }
}

type QdrantSearchResponse = {
  result?: QdrantSearchHit[]
}

function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.replace(/\/$/, '')
}

function getQdrantBaseUrl() {
  return env.QDRANT_URL?.trim() || ''
}

export function isQdrantConfigured() {
  return Boolean(getQdrantBaseUrl())
}

export function getQdrantRuntimeStatus() {
  return {
    configured: isQdrantConfigured(),
    baseUrl: getQdrantBaseUrl() || null,
    collection: env.QDRANT_COLLECTION_KNOWLEDGE,
    timeoutMs: env.QDRANT_TIMEOUT_MS,
  }
}

async function qdrantRequest<T>(requestPath: string, init?: RequestInit, allowNotFound = false) {
  if (!isQdrantConfigured()) {
    throw new Error('Qdrant 尚未配置，请先设置 QDRANT_URL。')
  }

  const headers = new Headers(init?.headers)
  headers.set('Content-Type', 'application/json')

  if (env.QDRANT_API_KEY?.trim()) {
    headers.set('api-key', env.QDRANT_API_KEY.trim())
  }

  const response = await fetch(`${normalizeBaseUrl(getQdrantBaseUrl())}${requestPath}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(env.QDRANT_TIMEOUT_MS),
  })

  if (allowNotFound && response.status === 404) {
    return null
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`Qdrant 调用失败（${response.status}）：${detail || response.statusText}`)
  }

  if (response.status === 204) {
    return {} as T
  }

  return response.json() as Promise<T>
}

export async function ensureKnowledgeCollection(vectorSize: number) {
  const collectionName = encodeURIComponent(env.QDRANT_COLLECTION_KNOWLEDGE)
  const existing = await qdrantRequest<QdrantCollectionResponse>(`/collections/${collectionName}`, undefined, true)

  if (!existing) {
    await qdrantRequest(`/collections/${collectionName}`, {
      method: 'PUT',
      body: JSON.stringify({
        vectors: {
          size: vectorSize,
          distance: 'Cosine',
        },
      }),
    })
    return
  }

  const configuredVectors = existing.result?.config?.params?.vectors
  const existingSize =
    typeof configuredVectors === 'object'
      ? ('size' in configuredVectors ? Number(configuredVectors.size) : Number.NaN)
      : Number.NaN

  if (Number.isFinite(existingSize) && existingSize !== vectorSize) {
    throw new Error(
      `Qdrant collection ${env.QDRANT_COLLECTION_KNOWLEDGE} 已存在，但向量维度为 ${existingSize}，与当前 embedding 维度 ${vectorSize} 不一致。`,
    )
  }
}

export async function upsertKnowledgePoints(points: Array<{
  id: string
  vector: number[]
  payload: Record<string, unknown>
}>) {
  if (!points.length) {
    return
  }

  const collectionName = encodeURIComponent(env.QDRANT_COLLECTION_KNOWLEDGE)
  await qdrantRequest(`/collections/${collectionName}/points?wait=true`, {
    method: 'PUT',
    body: JSON.stringify({
      points,
    }),
  })
}

export async function deleteKnowledgePoints(pointIds: string[]) {
  if (!pointIds.length || !isQdrantConfigured()) {
    return
  }

  const collectionName = encodeURIComponent(env.QDRANT_COLLECTION_KNOWLEDGE)
  await qdrantRequest(`/collections/${collectionName}/points/delete?wait=true`, {
    method: 'POST',
    body: JSON.stringify({
      points: pointIds,
    }),
  })
}

export async function searchKnowledgePoints(input: {
  vector: number[]
  organizationId: string
  limit: number
}) {
  const collectionName = encodeURIComponent(env.QDRANT_COLLECTION_KNOWLEDGE)
  const payload = await qdrantRequest<QdrantSearchResponse>(`/collections/${collectionName}/points/search`, {
    method: 'POST',
    body: JSON.stringify({
      vector: input.vector,
      limit: input.limit,
      with_payload: true,
      filter: {
        must: [
          {
            key: 'organizationId',
            match: {
              value: input.organizationId,
            },
          },
        ],
      },
    }),
  }) ?? {}

  return payload.result ?? []
}
