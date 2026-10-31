import { env } from '../config/env.js'
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

export async function cloudAiFetch(endpoint: string, payload?: unknown, extraHeaders: Record<string, string> = {}) {
  const account = getCurrentWorkspaceAccount()
  const token = account ? tokens.get(account) : undefined
  if (!token) throw new Error('请登录官网账户后使用智能分析。')
  if (!env.CLOUD_API_BASE_URL) throw new Error('智能分析服务地址尚未配置。')
  const response = await fetch(`${env.CLOUD_API_BASE_URL.replace(/\/$/, '')}/api/ai/${endpoint}`, {
    method: payload === undefined ? 'GET' : 'POST',
    headers: { ...extraHeaders, 'x-ai-request-id': randomUUID(),
      ...(payload instanceof FormData || payload instanceof Uint8Array || payload === undefined ? {} : { 'Content-Type': 'application/json' }),
      Authorization: `Bearer ${token}` },
    body: payload instanceof Uint8Array ? new Uint8Array(payload) : payload instanceof FormData ? payload : JSON.stringify(payload),
    signal: AbortSignal.timeout(env.LLM_TIMEOUT_MS), redirect: 'error',
  }).catch(() => { throw new Error('当前无法连接智能分析服务，请稍后重试。') })
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: { message?: string } }
    const fallback = response.status === 401 ? '登录状态已失效，请重新登录后重试。'
      : response.status === 413 ? '本次材料过大，请分批处理后重试。'
      : response.status === 429 ? '当前分析任务较多，请稍后重试。'
      : '智能分析服务暂时异常，请稍后重试。'
    throw new Error(body.error?.message || fallback)
  }
  return response
}
