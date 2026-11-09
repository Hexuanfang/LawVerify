import { env } from '../config/env.js'
import { AppError } from '../core/app-error.js'
import { getCurrentWorkspaceAccount } from '../store.js'
import { createSemaphore } from '../infrastructure/concurrency.js'
import { randomUUID } from 'node:crypto'

const tokens = new Map<string, string>()
// 云端网关按「组织 + 用户」限制并发请求数，桌面端按同一上限排队，
// 避免自己把在途请求顶到网关上限之外，反被网关判为「当前分析任务较多」。
const cloudAiLimiter = createSemaphore(env.CLOUD_AI_MAX_CONCURRENCY)
// 网关限流发生在扣费之前，重试不会重复计费。
const MAX_CLOUD_AI_ATTEMPTS = 3
const CLOUD_AI_RETRY_BASE_DELAY_MS = 2000

export function rememberCloudAiToken(token: string | undefined) {
  const account = getCurrentWorkspaceAccount()
  if (!account) return
  // 只有真正带上凭据的请求才更新凭据：缺少该请求头（例如事件流）不代表退出登录，
  // 若在这里清空，后续智能分析会以「请登录官网账户」失败。
  if (token?.trim()) tokens.set(account, token.trim())
}
export function forgetCloudAiToken(account?: string | null) {
  const target = (account ?? getCurrentWorkspaceAccount())?.trim().toLowerCase()
  if (target) tokens.delete(target)
}
export function isCloudAiEnabled() { return env.AI_GATEWAY_MODE === 'cloud' }

export function hasCloudAiToken() {
  const account = getCurrentWorkspaceAccount()
  return Boolean(account && tokens.get(account))
}

// 上游错误要保留真实语义，避免被兜底成 400 Bad Request。
function resolveUpstreamStatus(status: number) {
  if (status === 401 || status === 403 || status === 413 || status === 429 || status === 503) return status
  return status >= 500 ? 502 : 400
}

export function waitBeforeRetry(delayMs: number, abortSignal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortSignal?.reason ?? new Error('已取消。'))
    }
    const timer = setTimeout(() => {
      abortSignal?.removeEventListener('abort', onAbort)
      resolve()
    }, delayMs)
    if (abortSignal?.aborted) { onAbort(); return }
    abortSignal?.addEventListener('abort', onAbort, { once: true })
  })
}

export async function cloudAiFetch(endpoint: string, payload?: unknown, extraHeaders: Record<string, string> = {}, abortSignal?: AbortSignal) {
  const account = getCurrentWorkspaceAccount()
  const token = account ? tokens.get(account) : undefined
  if (!token) throw new AppError('请登录官网账户后使用智能分析。', 401, 'CLOUD_AI_LOGIN_REQUIRED')
  // 先取到局部常量：属性访问的类型收窄在回调内会失效，闭包中无法再判定为非空。
  const baseUrl = env.CLOUD_API_BASE_URL
  if (!baseUrl) throw new AppError('智能分析服务地址尚未配置。', 503, 'CLOUD_AI_NOT_CONFIGURED')

  return cloudAiLimiter.run(async () => {
    const timeoutSignal = AbortSignal.timeout(env.LLM_TIMEOUT_MS)
    const signal = abortSignal ? AbortSignal.any([timeoutSignal, abortSignal]) : timeoutSignal
    const url = `${baseUrl.replace(/\/$/, '')}/api/ai/${endpoint}`
    const requestBody = payload instanceof Uint8Array
      ? new Uint8Array(payload)
      : payload instanceof FormData ? payload : JSON.stringify(payload)

    for (let attempt = 1; ; attempt += 1) {
      const response = await fetch(url, {
        method: payload === undefined ? 'GET' : 'POST',
        headers: { ...extraHeaders, 'x-ai-request-id': randomUUID(),
          ...(payload instanceof FormData || payload instanceof Uint8Array || payload === undefined ? {} : { 'Content-Type': 'application/json' }),
          Authorization: `Bearer ${token}` },
        body: requestBody,
        signal, redirect: 'error',
      }).catch((error) => {
        // 中止信号需要原样抛出，避免把“用户已停止”误报成服务不可用。
        if (abortSignal?.aborted) throw error
        throw new AppError('当前无法连接智能分析服务，请稍后重试。', 502, 'CLOUD_AI_UNREACHABLE')
      })
      if (response.ok) {
        return response
      }

      const errorBody = await response.json().catch(() => ({})) as { error?: { message?: string } }
      // 网关并发已满：退避后重试，避免一次限流直接让整轮分析失败。
      // 重试必须换新的请求编号，否则云端会按重复请求拒绝。
      if (response.status === 429 && attempt < MAX_CLOUD_AI_ATTEMPTS) {
        await waitBeforeRetry(CLOUD_AI_RETRY_BASE_DELAY_MS * attempt, abortSignal)
        continue
      }
      // 上游判定登录态失效时丢弃本地凭据，下一次会明确提示重新登录官网账户。
      if (response.status === 401) {
        forgetCloudAiToken(account)
      }
      const fallback = response.status === 401 ? '登录状态已失效，请重新登录后重试。'
        : response.status === 413 ? '本次材料过大，请分批处理后重试。'
        : response.status === 429 ? '当前分析任务较多，请稍后重试。'
        : '智能分析服务暂时异常，请稍后重试。'
      throw new AppError(errorBody.error?.message || fallback, resolveUpstreamStatus(response.status), 'CLOUD_AI_UPSTREAM_FAILED')
    }
  })
}
