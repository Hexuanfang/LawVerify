import { Router, raw } from 'express'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { MIMEType } from 'node:util'
import { config } from '../config.js'
import { AppError } from '../core/app-error.js'
import { authenticate, requirePermission } from '../middleware/authenticate.js'
import { consumePointAction, refundPointAction } from '../point-service.js'
import type { AuthenticatedActor } from '../commercial/types.js'
import { beginAiRequest, updateAiRequest } from '../ai-request-store.js'

const pending = new Map<string, number>()
const mcpSessions = new Map<string, string>()
const text = z.string().max(150000)
const image = z.string().max(18000000).regex(/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=\r\n]+$/)
const message = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.union([text, z.array(z.union([
    z.object({ type: z.literal('text'), text }),
    z.object({ type: z.literal('image_url'), image_url: z.object({ url: image }) }),
  ])).max(8)]),
})
const chatSchema = z.object({
  messages: z.array(message).min(1).max(40),
  mode: z.enum(['text', 'vision']).default('text'),
  temperature: z.number().min(0).max(1).default(0.1),
  max_tokens: z.number().int().min(1).max(12000).default(3000),
  response_format: z.object({ type: z.enum(['json_object', 'text']) }).optional(),
  stream: z.boolean().default(false),
  model: z.string().trim().min(1).max(200).optional(),
})

function chatModels() {
  return config.LLM_BASE_URL && config.LLM_API_KEY
    ? [...new Set([config.LLM_MODEL, ...(config.LLM_CHAT_MODELS ?? '').split(',')]
      .map(s => s?.trim()).filter((s): s is string => Boolean(s)))] : []
}

async function upstream(url: string, key: string, body: unknown, extra: Record<string, string> = {}) {
  if (!/^https:\/\//.test(url) && !/^http:\/\/(?:127\.0\.0\.1|localhost)(?:[:/])/.test(url)) {
    throw new AppError('模型服务地址必须使用 HTTPS。', 503, 'AI_CONFIG_INVALID')
  }
  const response = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, ...extra },
    body: JSON.stringify(body), signal: AbortSignal.timeout(config.LLM_TIMEOUT_MS), redirect: 'error',
  })
  if (!response.ok) {
    console.error('AI provider request failed:', new URL(url).hostname, response.status)
    await response.body?.cancel()
    throw new AppError('智能分析服务暂不可用，请稍后重试。', 502, 'AI_UPSTREAM_FAILED')
  }
  return response
}

export async function billedAiRequest<T>(actor: AuthenticatedActor, actionType: 'evidence_summary' | 'document_parse' | 'case_reference', task: () => Promise<T>, requestId: string = randomUUID()) {
  const key = `${actor.organizationId}:${actor.userId}`
  if ((pending.get(key) ?? 0) >= 3) throw new AppError('当前分析任务较多，请稍后再试。', 429, 'AI_CONCURRENCY_LIMIT')
  pending.set(key, (pending.get(key) ?? 0) + 1)
  let entryId: string | undefined
  let started = false
  try {
    await beginAiRequest(requestId, actor)
    started = true
    const consumed = await consumePointAction(actor, {
      actionType, idempotencyKey: `ai:${requestId}`, resourceType: 'cloud_ai', note: '云端智能分析',
    })
    entryId = consumed.entry.id
    await updateAiRequest(requestId, 'running', entryId)
    const result = await task()
    await updateAiRequest(requestId, 'succeeded')
    return result
  } catch (error) {
    if (started) {
      await updateAiRequest(requestId, 'refund_pending', entryId)
      try {
        await refundPointAction(actor, {
          sourceOperationKey: `ai:${requestId}`, refundOperationKey: `ai-refund:${requestId}`, note: '智能分析失败退回',
        })
        await updateAiRequest(requestId, 'refunded')
      } catch { console.error('AI refund requires reconciliation:', requestId) }
    }
    throw error
  } finally {
    const next = (pending.get(key) ?? 1) - 1
    if (next) pending.set(key, next)
    else pending.delete(key)
  }
}

export const aiRouter = Router()
aiRouter.use(authenticate, requirePermission('account.read'))
aiRouter.use((_request, _response, next) => {
  if (!config.AI_GATEWAY_ENABLED) {
    next(new AppError('智能分析服务正在准备中，请稍后重试。', 503, 'AI_GATEWAY_DISABLED'))
    return
  }
  next()
})
aiRouter.use((request, _response, next) => {
  if (request.method === 'POST') {
    const result = z.string().uuid().safeParse(request.header('x-ai-request-id'))
    if (!result.success) { next(new AppError('缺少有效的分析请求编号。', 400, 'AI_REQUEST_ID_REQUIRED')); return }
  }
  next()
})
aiRouter.get('/status', (_request, response) => response.json({
  chat: Boolean(config.LLM_BASE_URL && config.LLM_API_KEY && config.LLM_MODEL),
  embedding: Boolean(config.EMBEDDING_BASE_URL && config.EMBEDDING_API_KEY && config.EMBEDDING_MODEL),
  cases: { yuandian: Boolean(config.YUANDIAN_API_KEY), wk: Boolean(config.WK_API_KEY), pkulaw: Boolean(config.PKULAW_API_KEY) },
}))

aiRouter.get('/assistant/capabilities', (_request, response) => response.json({
  models: chatModels().map(id => ({ id, label: id })),
  voice: Boolean(config.ASR_BASE_URL && config.ASR_API_KEY && config.ASR_MODEL),
}))

aiRouter.post('/audio/transcriptions', raw({ type: ['audio/webm', 'audio/mp4', 'audio/ogg', 'audio/wav'], limit: '8mb' }), async (request, response) => {
  if (!Buffer.isBuffer(request.body) || !request.body.length) throw new AppError('语音文件无效。', 400, 'INVALID_AUDIO')
  if (!config.ASR_BASE_URL || !config.ASR_API_KEY || !config.ASR_MODEL) throw new AppError('语音输入尚未启用。', 503, 'ASR_NOT_CONFIGURED')
  const url = `${config.ASR_BASE_URL.replace(/\/$/, '')}/audio/transcriptions`
  if (!/^https:\/\//.test(url) && !/^http:\/\/(?:127\.0\.0\.1|localhost)(?:[:/])/.test(url)) {
    throw new AppError('语音服务地址必须使用 HTTPS。', 503, 'ASR_CONFIG_INVALID')
  }
  await billedAiRequest(request.actor!, 'document_parse', async () => {
    const form = new FormData()
    const mime = request.get('content-type')?.split(';')[0] || 'audio/webm'
    form.set('file', new Blob([new Uint8Array(request.body)], { type: mime }), mime === 'audio/mp4' ? 'speech.m4a' : 'speech.webm')
    form.set('model', config.ASR_MODEL!)
    form.set('language', 'zh')
    const result = await fetch(url, {
      method: 'POST', headers: { Authorization: `Bearer ${config.ASR_API_KEY}` }, body: form,
      signal: AbortSignal.timeout(config.LLM_TIMEOUT_MS), redirect: 'error',
    })
    if (!result.ok) throw new AppError('语音识别失败，请重试。', 502, 'ASR_FAILED')
    const data = await result.json() as { text?: string }
    if (!data.text?.trim()) throw new AppError('未识别到语音，请重试。', 502, 'ASR_EMPTY')
    response.json({ text: data.text.trim().slice(0, 6000) })
  }, z.string().uuid().parse(request.header('x-ai-request-id')))
})

aiRouter.post('/chat/completions', async (request, response) => {
  const parsed = chatSchema.parse(request.body)
  const vision = parsed.mode === 'vision'
  const base = vision ? config.LLM_VISION_BASE_URL || config.LLM_BASE_URL : config.LLM_BASE_URL
  const key = vision ? config.LLM_VISION_API_KEY || config.LLM_API_KEY : config.LLM_API_KEY
  if (parsed.model && (vision || !chatModels().includes(parsed.model))) {
    throw new AppError('所选模型不可用。', 400, 'AI_MODEL_NOT_ALLOWED')
  }
  const model = vision ? config.LLM_VISION_MODEL || config.LLM_MODEL : parsed.model || config.LLM_MODEL
  if (!base || !key || !model) throw new AppError('智能分析服务尚未配置。', 503, 'AI_NOT_CONFIGURED')
  await billedAiRequest(request.actor!, 'evidence_summary', async () => {
    const { mode: _mode, ...payload } = parsed
    const upstreamResponse = await upstream(`${base.replace(/\/$/, '')}/chat/completions`, key, { ...payload, model })
    if (!parsed.stream) {
      const result = await upstreamResponse.json() as { choices?: Array<{ message?: { content?: string } }> }
      if (!result.choices?.[0]?.message?.content?.trim()) throw new AppError('分析未返回有效内容。', 502, 'AI_EMPTY_RESPONSE')
      response.json({ choices: result.choices })
      return
    }
    if (!upstreamResponse.body) throw new AppError('分析未返回内容。', 502, 'AI_EMPTY_RESPONSE')
    response.status(200).set({
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no',
    })
    const reader = upstreamResponse.body.getReader()
    const decoder = new TextDecoder()
    let tail = ''
    let completed = false
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (response.destroyed) throw new Error('Client disconnected')
        tail = (tail + decoder.decode(value, { stream: true })).slice(-256)
        if (tail.includes('[DONE]')) completed = true
        response.write(value)
        response.flush?.()
      }
      if (!completed) throw new AppError('分析输出中断，请重试。', 502, 'AI_STREAM_INTERRUPTED')
      response.end()
    } finally { await reader.cancel().catch(() => {}) }
  }, z.string().uuid().parse(request.header('x-ai-request-id')))
})

aiRouter.post('/embeddings', async (request, response) => {
  const payload = z.object({ input: z.array(z.string().min(1).max(20000)).min(1).max(32) }).parse(request.body)
  if (!config.EMBEDDING_BASE_URL || !config.EMBEDDING_API_KEY || !config.EMBEDDING_MODEL) {
    throw new AppError('材料检索服务尚未配置。', 503, 'EMBEDDING_NOT_CONFIGURED')
  }
  await billedAiRequest(request.actor!, 'document_parse', async () => {
    const result = await upstream(`${config.EMBEDDING_BASE_URL!.replace(/\/$/, '')}/embeddings`, config.EMBEDDING_API_KEY!, {
      input: payload.input, model: config.EMBEDDING_MODEL, dimensions: config.EMBEDDING_DIMENSION, encoding_format: 'float',
    })
    const vectors = await result.json() as { data?: unknown[] }
    if (!vectors.data || vectors.data.length !== payload.input.length) throw new AppError('检索结果不完整。', 502, 'EMBEDDING_INVALID_RESPONSE')
    response.json({ data: vectors.data })
  }, z.string().uuid().parse(request.header('x-ai-request-id')))
})

aiRouter.post('/mcp/:provider', async (request, response) => {
  const provider = z.enum(['yuandian', 'wk', 'pkulaw']).parse(request.params.provider)
  const rpc = z.object({
    jsonrpc: z.literal('2.0'), id: z.union([z.string(), z.number()]).optional(),
    method: z.enum(['initialize', 'notifications/initialized', 'tools/list', 'tools/call']),
    params: z.record(z.string(), z.unknown()).optional(),
  }).parse(request.body)
  const allowedTools = ['search_case', 'search_case_keyword', 'yuandian_semantic_search_cases',
    'yuandian_case_vector_search__v2', 'yuandian_rh_qwal_search__v3', 'yuandian_search_authoritative_cases']
  if (rpc.method === 'tools/call' && !allowedTools.includes(String(rpc.params?.name ?? ''))) {
    throw new AppError('仅允许案例检索操作。', 403, 'MCP_TOOL_FORBIDDEN')
  }
  const credentials = {
    yuandian: [config.YUANDIAN_MCP_URL, config.YUANDIAN_API_KEY],
    wk: [config.WK_MCP_URL, config.WK_API_KEY], pkulaw: [config.PKULAW_MCP_URL, config.PKULAW_API_KEY],
  }[provider]
  if (!credentials[0] || !credentials[1]) throw new AppError('案例检索服务未配置。', 503, 'MCP_NOT_CONFIGURED')
  await billedAiRequest(request.actor!, 'case_reference', async () => {
    const headers: Record<string, string> = { Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2024-11-05' }
    const sessionKey = `${request.actor!.organizationId}:${request.actor!.userId}:${provider}`
    const session = mcpSessions.get(sessionKey)
    if (session) headers['Mcp-Session-Id'] = session
    const result = await upstream(credentials[0]!, credentials[1]!, rpc, headers)
    const sessionId = result.headers.get('mcp-session-id')
    if (sessionId) {
      mcpSessions.set(sessionKey, sessionId)
      response.setHeader('mcp-session-id', sessionId)
    }
    const contentType = result.headers.get('content-type') || 'application/json'
    let safeContentType = 'application/json'
    try {
      const parsed = new MIMEType(contentType)
      if (parsed.essence === 'application/json' || parsed.essence === 'text/event-stream') {
        safeContentType = parsed.toString()
      }
    } catch {
      console.error('MCP invalid response media type:', provider, JSON.stringify(contentType.slice(0, 200)))
    }
    response.setHeader('content-type', safeContentType)
    response.send(Buffer.from(await result.arrayBuffer()))
  }, z.string().uuid().parse(request.header('x-ai-request-id')))
})
