import { env } from '../config/env.js'
import { AsyncLocalStorage } from 'node:async_hooks'
import { z } from 'zod'
import { cloudAiFetch, hasCloudAiToken, isCloudAiEnabled, waitBeforeRetry } from './cloud-ai.js'

export interface LlmChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | Array<
    | {
      type: 'text'
      text: string
    }
    | {
      type: 'image_url'
      image_url: {
        url: string
      }
    }
  >
}

interface ChatCompletionOptions {
  messages: LlmChatMessage[]
  baseUrl?: string
  apiKey?: string
  model?: string
  temperature?: number
  maxTokens?: number
  responseFormat?: 'text' | 'json_object'
}

const assistantModel = new AsyncLocalStorage<string>()
// 请求级中止信号：客户端断开或用户点击“停止”后，让正在进行的 LLM 调用立即中断。
const requestAbort = new AsyncLocalStorage<AbortSignal>()
// 直连模式的上游限流退避：并发理解时一次 429 会让整份材料整理失败。
const MAX_LLM_ATTEMPTS = 3

export async function withRequestAbortSignal<T>(signal: AbortSignal | undefined, action: () => T): Promise<T> {
  if (!signal) return action()
  return requestAbort.run(signal, action)
}

function currentRequestAbortSignal() {
  return requestAbort.getStore()
}

export async function withAssistantModel<T>(model: unknown, action: () => T): Promise<T> {
  if (model === undefined || model === '') return action()
  if (typeof model !== 'string') throw new Error('所选模型不可用，请重新选择。')
  const capabilities = await getAssistantCapabilities()
  // 模型目录为空说明上游网关未启用或未配置模型，交由上游返回准确错误，不再本地拦截。
  if (capabilities.models.length > 0 && !capabilities.models.some(m => m.id === model)) {
    throw new Error('所选模型不可用，请重新选择。')
  }
  return assistantModel.run(model, action)
}

interface OpenAiCompatibleResponse {
  choices?: Array<{
    message?: {
      content?: string | null
    }
  }>
}

interface OpenAiCompatibleStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string | null
    }
  }>
}

function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.replace(/\/$/, '')
}

export function isLlmConfigured() {
  return isCloudAiEnabled() || Boolean(env.LLM_BASE_URL && env.LLM_API_KEY && env.LLM_MODEL)
}

export function configuredChatModels() {
  return env.LLM_BASE_URL && env.LLM_API_KEY
    ? [...new Set([env.LLM_MODEL, ...(env.LLM_CHAT_MODELS ?? '').split(',')].map(s => s?.trim()).filter((s): s is string => Boolean(s)))]
    : []
}

export async function getAssistantCapabilities(): Promise<{ models: Array<{ id: string; label: string }>; voice: boolean }> {
  if (isCloudAiEnabled()) {
    // 网关已启用但当前账号未登录时直接返回空目录，避免探测请求触发 401。
    if (!hasCloudAiToken()) return { models: [], voice: false }
    try {
      return z.object({
        models: z.array(z.object({ id: z.string(), label: z.string() })), voice: z.boolean(),
      }).parse(await (await cloudAiFetch('assistant/capabilities')).json())
    } catch (error) {
      // 上游网关未启用或不可用时返回空目录：能力探测失败不应让整个请求报错。
      console.error('Assistant capabilities unavailable:', error instanceof Error ? error.message : String(error))
      return { models: [], voice: false }
    }
  }
  return { models: configuredChatModels().map(id => ({ id, label: id })),
    voice: Boolean(env.ASR_BASE_URL && env.ASR_API_KEY && env.ASR_MODEL) }
}

export async function transcribeAssistantAudio(buffer: Buffer, mime: string) {
  const capabilities = await getAssistantCapabilities()
  if (!capabilities.voice) throw new Error('语音输入尚未启用，请联系管理员配置语音识别服务。')
  const form = new FormData()
  form.set('file', new Blob([new Uint8Array(buffer)], { type: mime }), mime.includes('mp4') ? 'speech.m4a' : 'speech.webm')
  if (isCloudAiEnabled()) return (await cloudAiFetch('audio/transcriptions', buffer, { 'Content-Type': mime })).json() as Promise<{ text: string }>
  form.set('model', env.ASR_MODEL!)
  form.set('language', 'zh')
  const url = `${normalizeBaseUrl(env.ASR_BASE_URL!)}/audio/transcriptions`
  if (!/^https:\/\//.test(url) && !/^http:\/\/(?:127\.0\.0\.1|localhost)(?:[:/])/.test(url)) {
    throw new Error('语音服务地址必须使用 HTTPS。')
  }
  const response = await fetch(url, {
    method: 'POST', headers: { Authorization: `Bearer ${env.ASR_API_KEY}` }, body: form,
    signal: AbortSignal.timeout(env.LLM_TIMEOUT_MS), redirect: 'error',
  })
  if (!response.ok) throw new Error('语音识别失败，请稍后重试。')
  const result = await response.json() as { text?: string }
  if (!result.text?.trim()) throw new Error('未识别到语音，请重试。')
  return { text: result.text.trim().slice(0, 6000) }
}

async function requestChat(options: ChatCompletionOptions, stream: boolean) {
  const hasImages = options.messages.some(m => Array.isArray(m.content) && m.content.some(c => c.type === 'image_url'))
  const selectedModel = options.model || (!hasImages ? assistantModel.getStore() : undefined)
  const requestedMaxTokens = options.maxTokens ?? 3000
  // 推理模型（thinking）会把 max_tokens 优先消耗在推理阶段，正文可能被挤为空。
  // LLM_MIN_MAX_TOKENS 为推理模型预留出正文的 token 预算。
  const maxTokens = env.LLM_MIN_MAX_TOKENS
    ? Math.max(requestedMaxTokens, env.LLM_MIN_MAX_TOKENS)
    : requestedMaxTokens
  const payload = {
    messages: options.messages, temperature: options.temperature ?? 0.1,
    max_tokens: maxTokens, stream,
    response_format: options.responseFormat === 'json_object' ? { type: 'json_object' } : undefined,
    // 仅在显式配置时下发，兼容支持 reasoning.effort 的供应商。
    reasoning: env.LLM_REASONING_EFFORT ? { effort: env.LLM_REASONING_EFFORT } : undefined,
  }
  if (isCloudAiEnabled()) return cloudAiFetch('chat/completions', {
    ...payload, model: selectedModel, mode: hasImages ? 'vision' : 'text',
  }, {}, currentRequestAbortSignal())
  const baseUrl = options.baseUrl || env.LLM_BASE_URL
  const apiKey = options.apiKey || env.LLM_API_KEY
  const model = selectedModel || env.LLM_MODEL
  if (!baseUrl || !apiKey || !model) throw new Error('LLM 请求缺少 baseUrl、apiKey 或 model。')
  const timeoutSignal = AbortSignal.timeout(env.LLM_TIMEOUT_MS)
  const abortSignal = currentRequestAbortSignal()
  const url = `${normalizeBaseUrl(baseUrl)}/chat/completions`
  const body = JSON.stringify({ ...payload, model })
  // 直连模式没有网关的退避重试：上游限流时退避后重试，
  // 避免多份材料并发理解把一次限流放大成整案整理失败。
  for (let attempt = 1; ; attempt += 1) {
    const response = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body,
      signal: abortSignal ? AbortSignal.any([timeoutSignal, abortSignal]) : timeoutSignal,
    })
    if (response.ok) {
      return response
    }
    await response.body?.cancel().catch(() => {})
    if (response.status === 429 && attempt < MAX_LLM_ATTEMPTS) {
      await waitBeforeRetry(env.LLM_RETRY_BASE_DELAY_MS * attempt, abortSignal)
      continue
    }
    // 只记录状态码与模型名，不记录请求内容与响应正文。
    console.error(`LLM request failed: status=${response.status} model=${model}`)
    throw new Error(`智能分析服务暂不可用（${response.status}），请稍后重试。`)
  }
}

export function getLlmRuntimeStatus() {
  return {
    configured: isLlmConfigured(),
    provider: env.LLM_PROVIDER,
    model: env.LLM_MODEL ?? null,
    visionBaseUrl: env.LLM_VISION_BASE_URL ?? null,
    visionModel: env.LLM_VISION_MODEL ?? null,
    baseUrl: env.LLM_BASE_URL ?? null,
    timeoutMs: env.LLM_TIMEOUT_MS,
  }
}

export async function createChatCompletion(options: ChatCompletionOptions) {
  const response = await requestChat(options, false)

  const payload = await response.json() as OpenAiCompatibleResponse
  const content = payload.choices?.[0]?.message?.content?.trim()

  if (!content) {
    throw new Error('LLM 未返回有效内容。')
  }

  return {
    content,
    model: env.LLM_MODEL!,
    provider: env.LLM_PROVIDER,
  }
}

export async function* createChatCompletionStream(options: ChatCompletionOptions): AsyncGenerator<string> {
  const response = await requestChat(options, true)

  if (!response.body) {
    throw new Error('LLM 未返回可读取的流式响应。')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done })

    let separator = /\r?\n\r?\n/.exec(buffer)
    while (separator) {
      const separatorIndex = separator.index
      const eventBlock = buffer.slice(0, separatorIndex)
      buffer = buffer.slice(separatorIndex + separator[0].length)

      const payload = eventBlock
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('')

      if (payload === '[DONE]') {
        return
      }

      if (payload) {
        const chunk = JSON.parse(payload) as OpenAiCompatibleStreamChunk
        const content = chunk.choices?.[0]?.delta?.content
        if (content) {
          yield content
        }
      }

      separator = /\r?\n\r?\n/.exec(buffer)
    }

    if (done) {
      throw new Error('分析输出中断，请重试。')
    }
  }
}

export async function pingLlm() {
  const startedAt = Date.now()
  const result = await createChatCompletion({
    messages: [
      {
        role: 'system',
        content: '你是法律证据匹配系统的模型联调助手。请简短回复“ok”。',
      },
      {
        role: 'user',
        content: '请回复 ok',
      },
    ],
    maxTokens: 20,
    temperature: 0,
  })

  return {
    ...result,
    latencyMs: Date.now() - startedAt,
  }
}
