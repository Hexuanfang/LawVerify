import { config } from '../config.js'
import { AppError } from '../core/app-error.js'

interface Provider {
  base: string
  key: string
  model: string
}

class ProviderFailure extends AppError {
  constructor(readonly retryable: boolean, readonly providerStatus?: number) {
    super('智能分析服务暂不可用，请稍后重试。', 502, 'AI_UPSTREAM_FAILED')
  }
}

async function request(provider: Provider, payload: Record<string, unknown>, timeoutMs: number) {
  const url = `${provider.base.replace(/\/$/, '')}/chat/completions`
  if (!/^https:\/\//.test(url) && !/^http:\/\/(?:127\.0\.0\.1|localhost)(?:[:/])/.test(url)) {
    throw new AppError('模型服务地址必须使用 HTTPS。', 503, 'AI_CONFIG_INVALID')
  }
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.key}` },
      body: JSON.stringify({ ...payload, model: provider.model }),
      signal: AbortSignal.timeout(Math.max(1, Math.floor(timeoutMs))),
      redirect: 'error',
    })
  } catch {
    throw new ProviderFailure(true)
  }
  if (!response.ok) {
    await response.body?.cancel()
    throw new ProviderFailure([408, 429, 500, 502, 503, 504].includes(response.status), response.status)
  }
  return response
}

export async function requestChatProvider(payload: Record<string, unknown>, vision: boolean, explicitModel?: string) {
  const primary = {
    base: vision ? config.LLM_VISION_BASE_URL || config.LLM_BASE_URL : config.LLM_BASE_URL,
    key: vision ? config.LLM_VISION_API_KEY || config.LLM_API_KEY : config.LLM_API_KEY,
    model: vision ? config.LLM_VISION_MODEL || config.LLM_MODEL : explicitModel || config.LLM_MODEL,
  }
  if (!primary.base || !primary.key || !primary.model) {
    throw new AppError('智能分析服务尚未配置。', 503, 'AI_NOT_CONFIGURED')
  }
  const fallback = !vision && !explicitModel && config.LLM_TEXT_FALLBACK_ENABLED
    && config.LLM_VISION_BASE_URL && config.LLM_VISION_API_KEY && config.LLM_VISION_MODEL
    ? { base: config.LLM_VISION_BASE_URL, key: config.LLM_VISION_API_KEY, model: config.LLM_VISION_MODEL }
    : undefined
  const distinctFallback = fallback && (fallback.base !== primary.base || fallback.model !== primary.model)
  // Reserve time for failover before the desktop's request deadline; never replay a started stream.
  const budget = Math.max(1, config.LLM_TIMEOUT_MS - 5000)
  const started = Date.now()
  try {
    return await request(primary as Provider, payload, distinctFallback ? Math.min(45000, budget / 2) : budget)
  } catch (error) {
    if (!distinctFallback || !(error instanceof ProviderFailure) || !error.retryable) throw error
    const remaining = budget - (Date.now() - started)
    if (remaining <= 0) throw error
    console.warn('AI default provider failover:', error.providerStatus ?? 'connection', 'to', fallback.model)
    return request(fallback, payload, remaining)
  }
}
