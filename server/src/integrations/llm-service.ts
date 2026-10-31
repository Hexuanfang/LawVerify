import { env } from '../config/env.js'
import { AsyncLocalStorage } from 'node:async_hooks'
import { z } from 'zod'
import { cloudAiFetch, isCloudAiEnabled } from './cloud-ai.js'

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
export async function withAssistantModel<T>(model: unknown, action: () => T): Promise<T> {
  if (model === undefined || model === '') return action()
  if (typeof model !== 'string' || !(await getAssistantCapabilities()).models.some(m => m.id === model)) {
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
  if (isCloudAiEnabled()) return z.object({
    models: z.array(z.object({ id: z.string(), label: z.string() })), voice: z.boolean(),
  }).parse(await (await cloudAiFetch('assistant/capabilities')).json())
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
  const payload = {
    messages: options.messages, temperature: options.temperature ?? 0.1,
    max_tokens: options.maxTokens ?? 3000, stream,
    response_format: options.responseFormat === 'json_object' ? { type: 'json_object' } : undefined,
  }
  if (isCloudAiEnabled()) return cloudAiFetch('chat/completions', {
    ...payload, model: selectedModel, mode: hasImages ? 'vision' : 'text',
  })
  const baseUrl = options.baseUrl || env.LLM_BASE_URL
  const apiKey = options.apiKey || env.LLM_API_KEY
  const model = selectedModel || env.LLM_MODEL
  if (!baseUrl || !apiKey || !model) throw new Error('LLM 请求缺少 baseUrl、apiKey 或 model。')
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ ...payload, model }), signal: AbortSignal.timeout(env.LLM_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error('智能分析服务暂不可用，请稍后重试。')
  return response
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
