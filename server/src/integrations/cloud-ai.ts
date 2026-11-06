import { env } from '../config/env.js'
import { AppError } from '../core/app-error.js'
import { getCurrentWorkspaceAccount } from '../store.js'
import { randomUUID } from 'node:crypto'

const tokens = new Map<string, string>()
export function rememberCloudAiToken(token: string | undefined) {
  const account = getCurrentWorkspaceAccount()
  if (!account) return
  if (token?.trim()) tokens.set(account, token.trim())
  else tokens.delete(account)
}
export function isCloudAiEnabled() { return env.AI_GATEWAY_MODE === 'cloud' }

// 上游错误要保留真实语义，避免被兜底成 400 Bad Request。
function resolveUpstreamStatus(status: number) {
  if (status === 401 || status === 403 || status === 413 || status === 429 || status === 503) return status
  return status >= 500 ? 502 : 400
}

export async function cloudAiFetch(endpoint: string, payload?: unknown, extraHeaders: Record<string, string> = {}, abortSignal?: AbortSignal) {
  const account = getCurrentWorkspaceAccount()
  const token = account ? tokens.get(account) : undefined
  if (!token) throw new AppError('请登录官网账户后使用智能分析。', 401, 'CLOUD_AI_LOGIN_REQUIRED')
  if (!env.CLOUD_API_BASE_URL) throw new AppError('智能分析服务地址尚未配置。', 503, 'CLOUD_AI_NOT_CONFIGURED')
  const timeoutSignal = AbortSignal.timeout(env.LLM_TIMEOUT_MS)
  const response = await fetch(`${env.CLOUD_API_BASE_URL.replace(/\/$/, '')}/api/ai/${endpoint}`, {
    method: payload === undefined ? 'GET' : 'POST',
    headers: { ...extraHeaders, 'x-ai-request-id': randomUUID(),
      ...(payload instanceof FormData || payload instanceof Uint8Array || payload === undefined ? {} : { 'Content-Type': 'application/json' }),
      Authorization: `Bearer ${token}` },
    body: payload instanceof Uint8Array ? new Uint8Array(payload) : payload instanceof FormData ? payload : JSON.stringify(payload),
    signal: abortSignal ? AbortSignal.any([timeoutSignal, abortSignal]) : timeoutSignal, redirect: 'error',
  }).catch((error) => {
    // 中止信号需要原样抛出，避免把“用户已停止”误报成服务不可用。
    if (abortSignal?.aborted) throw error
    throw new AppError('当前无法连接智能分析服务，请稍后重试。', 502, 'CLOUD_AI_UNREACHABLE')
  })
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: { message?: string } }
    const fallback = response.status === 401 ? '登录状态已失效，请重新登录后重试。'
      : response.status === 413 ? '本次材料过大，请分批处理后重试。'
      : response.status === 429 ? '当前分析任务较多，请稍后重试。'
      : '智能分析服务暂时异常，请稍后重试。'
    throw new AppError(body.error?.message || fallback, resolveUpstreamStatus(response.status), 'CLOUD_AI_UPSTREAM_FAILED')
  }
  return response
}
