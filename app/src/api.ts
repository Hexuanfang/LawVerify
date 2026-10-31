import { cloudErrorMessage } from './cloud-errors'
import { boundedFetch } from './bounded-fetch'
import type {
  AppState,
  CasePositionDraft,
  CertificateParagraph,
  CollaboraSession,
  EvidenceType,
  LoginPayload,
  PaymentProvider,
  PaymentProviderStatus,
  PointActionType,
  RechargeOrder,
  RechargePackage,
  ReleaseItem,
  RoleType,
} from './types'

function getDevServiceHost() {
  if (typeof window !== 'undefined' && window.location.hostname) {
    const hostname = window.location.hostname
    if (hostname !== 'localhost' && hostname !== '127.0.0.1') {
      return hostname
    }
  }

  return '127.0.0.1'
}

const DEV_SERVICE_HOST = getDevServiceHost()

const API_BASE_URL = (
  (import.meta.env.DEV ? import.meta.env.VITE_API_BASE_URL?.trim() : '')
  || (import.meta.env.DEV ? `http://${DEV_SERVICE_HOST}:8787` : '')
).replace(/\/$/, '')

const OFFICIAL_PLATFORM_BASE_URL = 'https://lawagent.zhijing.fun'
const ACCOUNT_CENTER_BASE_URL = (
  (import.meta.env.DEV ? import.meta.env.VITE_ACCOUNT_CENTER_URL?.trim() : '')
  || (import.meta.env.DEV ? `http://${DEV_SERVICE_HOST}:4273` : OFFICIAL_PLATFORM_BASE_URL)
).replace(/\/$/, '')

const CLOUD_API_BASE_URL = (
  (import.meta.env.DEV ? import.meta.env.VITE_CLOUD_API_BASE_URL?.trim() : '')
  || ACCOUNT_CENTER_BASE_URL
  || (import.meta.env.DEV ? 'http://127.0.0.1:8788' : '')
).replace(/\/$/, '')
const CLOUD_TOKEN_STORAGE_KEY = 'lawverify-cloud-token'
const LOGIN_ACCOUNT_STORAGE_KEY = 'lawverify-login-account'

function applyWorkspaceAccountHeader(headers: Headers) {
  const workspaceAccount = typeof window !== 'undefined'
    ? sessionStorage.getItem(LOGIN_ACCOUNT_STORAGE_KEY)?.trim().toLowerCase()
    : ''

  if (workspaceAccount && !headers.has('x-workspace-account')) {
    headers.set('x-workspace-account', workspaceAccount)
  }
  const token = typeof window !== 'undefined' ? localStorage.getItem(CLOUD_TOKEN_STORAGE_KEY) : null
  if (token) headers.set('x-case-agent-token', token)
}

function isLocalOriginUrl(url: string) {
  try {
    const parsed = new URL(url)
    const { protocol, hostname } = parsed
    if (!/^https?:$/i.test(protocol)) {
      return false
    }

    if (hostname === 'localhost' || hostname === '127.0.0.1') {
      return true
    }

    if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(hostname)) {
      return true
    }

    if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) {
      return true
    }

    const match = hostname.match(/^172\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/)
    if (match) {
      const secondOctet = Number(match[1])
      return secondOctet >= 16 && secondOctet <= 31
    }

    return false
  } catch {
    return false
  }
}

function shouldUseLocalCloudProxy() {
  if (typeof window === 'undefined') {
    return false
  }

  if (window.lawVerifyDesktop?.channel === 'electron') {
    return true
  }

  const pageOrigin = window.location.origin?.trim() ?? ''
  if (!pageOrigin) {
    return false
  }

  if (API_BASE_URL && API_BASE_URL === pageOrigin) {
    return true
  }

  return !API_BASE_URL && isLocalOriginUrl(pageOrigin)
}

export function getEvidenceSourceUrl(evidenceId: string, workspaceAccount?: string | null) {
  const normalizedAccount = workspaceAccount?.trim().toLowerCase()
    || (typeof window !== 'undefined'
      ? sessionStorage.getItem(LOGIN_ACCOUNT_STORAGE_KEY)?.trim().toLowerCase()
      : '')
  const baseUrl = `${API_BASE_URL}/api/evidences/${evidenceId}/source`

  if (!normalizedAccount) {
    return baseUrl
  }

  const params = new URLSearchParams({
    workspaceAccount: normalizedAccount,
  })

  return `${baseUrl}?${params.toString()}`
}

interface WorkspaceResponse {
  workspace: AppState
}

interface EvidenceSourceUploadResponse {
  assets: Array<{
    relativePath: string
    fileName: string
    storageKey: string
    contentHash: string
    storageUrl: string
    sourceMimeType?: string
  }>
}

interface LoginResponse extends WorkspaceResponse {
  token: string
}

interface V1Envelope<T> {
  success: boolean
  requestId: string
  data: T
  meta?: Record<string, unknown>
}

interface ErrorResponseBody {
  message?: string
  code?: string
  error?: {
    message?: string
    code?: string
  }
}

export class CloudApiError extends Error {
  status: number
  code: string

  constructor(message: string, status = 0, code = 'CLOUD_API_ERROR') {
    super(message)
    this.name = 'CloudApiError'
    this.status = status
    this.code = code
  }
}

interface CertificateStreamMetaEvent {
  type: 'meta'
  title?: string
  focus?: string
}

interface CertificateStreamParagraphEvent {
  type: 'paragraph'
  index: number
  text: string
  evidenceNumbers: string[]
}

interface CertificateStreamDonePayload extends WorkspaceResponse {
  certificate: { id: string; title: string; focus: string; paragraphs: Array<{ id: string }> }
  agentReply?: string
}

type CertificateStreamHandlers<T = CertificateStreamDonePayload> = {
  onMeta?: (event: CertificateStreamMetaEvent) => void
  onParagraph?: (event: CertificateStreamParagraphEvent) => void
  onProgress?: (event: { text: string }) => void
  onDone: (payload: T) => void
}

let analyticsToken = ''
function recordProductEvent(name: string, outcome: 'success' | 'failure', started: number, id: string = crypto.randomUUID()) {
  if (!analyticsToken || analyticsToken !== localStorage.getItem(CLOUD_TOKEN_STORAGE_KEY)) return
  void requestCloudEnvelope('/api/account/events', {
    method: 'POST', body: JSON.stringify({ events: [{
      id, name, surface: 'desktop', outcome,
      durationMs: Math.min(3600000, Math.max(0, Math.round(performance.now() - started))),
    }] }),
  }).catch(() => {})
}
function eventForPath(path: string, init?: RequestInit) {
  if (path === '/api/v1/verification/legal') {
    try { return typeof init?.body === 'string' && JSON.parse(init.body).online === true ? 'legal.verify' : '' }
    catch { return '' }
  }
  if (path === '/api/v1/knowledge/cases/search') return 'case.search'
  if (path === '/api/certificates/import') return 'document.import'
  if (/\/certificates\/[^/]+\/auto-link/.test(path)) return 'evidence.link'
  if (/\/certificates\/(?:[^/]+\/)?(?:generate|rewrite)/.test(path)) return 'document.generate'
  return ''
}
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const started = performance.now(), name = eventForPath(path, init)
  try {
    const result = await baseRequest<T>(path, init)
    if (name) recordProductEvent(name, 'success', started)
    return result
  } catch (error) {
    if (name) recordProductEvent(name, 'failure', started)
    throw error
  }
}
async function baseRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers ?? {})
  if (!(init?.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  applyWorkspaceAccountHeader(headers)

  const response = await boundedFetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers,
  }).catch((error) => {
    if (init?.signal?.aborted) throw error
    throw new Error('本地材料服务暂不可用或请求超时。材料会保留，请确认操作结果后再重试。')
  })

  if (!response.ok) {
    const errorText = await response.text().catch(() => '')
    let errorBody: ErrorResponseBody | null = null

    if (errorText) {
      try {
        errorBody = JSON.parse(errorText) as ErrorResponseBody
      } catch {
        errorBody = null
      }
    }

    if (response.status === 413) {
      throw new Error('所选文件夹内容过大，请拆分后再导入。')
    }

    const upstreamMessage = errorBody?.message ?? errorBody?.error?.message ?? ''
    if (upstreamMessage === 'Legacy API route not found') {
      throw new Error('当前本地服务版本过旧或尚未重启，桌面端登录链路未同步完成。请重启本地服务或重新打开桌面端后再试。')
    }

    throw new Error(upstreamMessage || '请求失败')
  }

  return response.json() as Promise<T>
}

async function requestV1<T>(path: string, init?: RequestInit): Promise<T> {
  const payload = await request<V1Envelope<T>>(path, init)
  return payload.data
}

async function requestCloud<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers ?? {})
  headers.set('x-product-surface', 'desktop')
  if (!(init?.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  const cloudToken = localStorage.getItem(CLOUD_TOKEN_STORAGE_KEY)?.trim()
  if (cloudToken && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${cloudToken}`)
  }

  const getErrorMessage = (error: unknown) => error instanceof Error ? error.message || '' : ''
  const isNetworkErrorMessage = (message: string) => {
    const lower = message.toLowerCase()
    const networkKeywords = ['fetch failed', 'failed to fetch', 'networkerror', 'econnrefused', 'enotfound', 'getaddrinfo', 'timeout', 'timed out', 'network error']
    return networkKeywords.some((keyword) => lower.includes(keyword))
  }

  const buildUserFacingConnectionError = (error: unknown, origin: string) => {
    if (!CLOUD_API_BASE_URL) {
      return '当前桌面端尚未配置 LawVerify 账户服务地址，请更新至官网下载最新安装包。'
    }

    if (isLocalOriginUrl(CLOUD_API_BASE_URL)) {
      return `当前安装包仍使用本地联调账户服务 ${CLOUD_API_BASE_URL}，请改用已发布至官网下载正式版本。`
    }

    const raw = getErrorMessage(error)
    if (isNetworkErrorMessage(raw)) {
      return origin === 'local-proxy'
        ? '当前无法连接 LawVerify 账户服务，请检查网络后重试，或稍后再登录。'
        : '当前无法连接 LawVerify 账户服务，请检查网络后重试，或稍后再登录。'
    }

    return origin === 'local-proxy'
      ? `账户服务暂不可用，请稍后再试。${raw ? `详情：${raw}` : ''}`
      : `当前无法连接平台账户服务：${CLOUD_API_BASE_URL}。${raw ? `详情：${raw}` : ''}`
  }

  if (!import.meta.env.DEV && window.lawVerifyDesktop?.requestAccount) {
    if (init?.signal?.aborted) throw init.signal.reason
    let result: { status: number; body: string; code?: string }
    try {
      result = await window.lawVerifyDesktop.requestAccount({
        path, method: init?.method ?? 'GET', headers: Object.fromEntries(headers.entries()),
        body: typeof init?.body === 'string' ? init.body : undefined,
      })
    } catch {
      throw new CloudApiError('当前无法连接 LawVerify 账户服务，请检查网络或代理设置后重试。', 0, 'ACCOUNT_NETWORK_ERROR')
    }
    if (result.status === 0) {
      throw new CloudApiError('当前无法连接 LawVerify 账户服务，请检查网络或代理设置后重试。', 0, result.code || 'ACCOUNT_NETWORK_ERROR')
    }
    let payload: unknown
    try { payload = JSON.parse(result.body) } catch {
      throw new CloudApiError(cloudErrorMessage(result.status, '账户服务返回异常，请稍后重试。'), result.status, 'ACCOUNT_RESPONSE_INVALID')
    }
    if (result.status < 200 || result.status >= 300) {
      const errorBody = payload as ErrorResponseBody
      throw new CloudApiError(cloudErrorMessage(result.status, errorBody?.message ?? errorBody?.error?.message),
        result.status, errorBody?.code ?? errorBody?.error?.code ?? 'CLOUD_API_ERROR')
    }
    return payload as T
  }

  if (shouldUseLocalCloudProxy()) {
    const nextHeaders = Object.fromEntries(headers.entries())
    if (CLOUD_API_BASE_URL) {
      nextHeaders['x-cloud-base-url'] = CLOUD_API_BASE_URL
    }

    let proxiedResponse: Response
    try {
      proxiedResponse = await boundedFetch(`${API_BASE_URL}/api/cloud${path}`, {
        method: init?.method ?? 'GET',
        headers: nextHeaders,
        body: init?.body,
        signal: init?.signal,
      })
    } catch (error) {
      throw new Error(buildUserFacingConnectionError(error, 'local-proxy'))
    }

    if (!proxiedResponse.ok) {
      const errorText = await proxiedResponse.text().catch(() => '')
      let errorBody: ErrorResponseBody | null = null

      if (errorText) {
        try {
          errorBody = JSON.parse(errorText) as ErrorResponseBody
        } catch {
          errorBody = null
        }
      }

      throw new CloudApiError(
        cloudErrorMessage(proxiedResponse.status, errorBody?.message ?? errorBody?.error?.message),
        proxiedResponse.status,
        errorBody?.code ?? errorBody?.error?.code ?? 'CLOUD_API_ERROR',
      )
    }

    return proxiedResponse.json() as Promise<T>
  }

  let response: Response
  try {
    response = await boundedFetch(`${CLOUD_API_BASE_URL}${path}`, {
      ...init,
      headers,
    })
  } catch (error) {
    throw new Error(buildUserFacingConnectionError(error, 'direct'))
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => '')
    let errorBody: ErrorResponseBody | null = null

    if (errorText) {
      try {
        errorBody = JSON.parse(errorText) as ErrorResponseBody
      } catch {
        errorBody = null
      }
    }

    throw new CloudApiError(
      cloudErrorMessage(response.status, errorBody?.message ?? errorBody?.error?.message),
      response.status,
      errorBody?.code ?? errorBody?.error?.code ?? 'CLOUD_API_ERROR',
    )
  }

  return response.json() as Promise<T>
}

async function requestCloudEnvelope<T>(path: string, init?: RequestInit): Promise<T> {
  const started = performance.now()
  const payload = await requestCloud<{ success: boolean; data: T; error?: { message?: string } }>(path, init)
  if (!payload.success) {
    throw new CloudApiError(cloudErrorMessage(0, payload.error?.message))
  }

  if (/^\/api\/billing\/orders\/[^/]+$/.test(path)) {
    const order = (payload.data as { order?: { id: string; status: string } })?.order
    if (order?.status === 'paid') recordProductEvent('payment.completed', 'success', started, order.id)
  }
  return payload.data
}

export function isCloudAuthApiError(error: unknown): error is CloudApiError {
  return error instanceof CloudApiError
    && error.status === 401
    && ['UNAUTHORIZED', 'INVALID_TOKEN', 'INVALID_SESSION', 'SESSION_REPLACED'].includes(error.code)
}

export async function fetchWithWorkspaceAccount(input: string | URL, init?: RequestInit) {
  const headers = new Headers(init?.headers ?? {})
  applyWorkspaceAccountHeader(headers)
  return boundedFetch(input, {
    ...init,
    headers,
  })
}

export function watchWorkspace(onChange: () => void) {
  const account = sessionStorage.getItem(LOGIN_ACCOUNT_STORAGE_KEY)?.trim().toLowerCase() ?? ''
  const source = new EventSource(`${API_BASE_URL}/api/workspace/events?${new URLSearchParams({ workspaceAccount: account })}`)
  source.addEventListener('connected', onChange)
  source.addEventListener('changed', onChange)
  return () => source.close()
}

async function streamRequest<T = CertificateStreamDonePayload>(path: string, init: RequestInit, handlers: CertificateStreamHandlers<T>) {
  const started = performance.now(), name = eventForPath(path, init)
  try {
    await baseStreamRequest(path, init, handlers)
    if (name) recordProductEvent(name, 'success', started)
  } catch (error) {
    if (name) recordProductEvent(name, 'failure', started)
    throw error
  }
}
async function baseStreamRequest<T = CertificateStreamDonePayload>(path: string, init: RequestInit, handlers: CertificateStreamHandlers<T>) {
  const headers = new Headers(init.headers ?? {})
  if (!(init.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  applyWorkspaceAccountHeader(headers)

  const response = await boundedFetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers,
  }, 15 * 60 * 1000).catch(() => {
    throw new Error('暂时无法连接服务，请检查连接后重试。')
  })

  if (!response.ok) {
    const errorText = await response.text().catch(() => '')
    throw new Error(errorText || '请求失败')
  }

  if (!response.body) {
    throw new Error('服务端未返回可读取的流式内容。')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let receivedDone = false

  const handleEventBlock = (block: string) => {
    const lines = block.split(/\r?\n/)
    let eventName = 'message'
    const dataLines: string[] = []

    for (const line of lines) {
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim()
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trim())
      }
    }

    if (!dataLines.length) {
      return
    }

    const payload = JSON.parse(dataLines.join('\n')) as
      | CertificateStreamMetaEvent
      | CertificateStreamParagraphEvent
      | CertificateStreamDonePayload
      | { message?: string }
      | { text: string }

    if (eventName === 'progress') {
      const progress = payload as { text?: unknown }
      if (typeof progress.text === 'string') handlers.onProgress?.({ text: progress.text })
      return
    }

    if (eventName === 'meta') {
      handlers.onMeta?.(payload as CertificateStreamMetaEvent)
      return
    }

    if (eventName === 'paragraph') {
      handlers.onParagraph?.(payload as CertificateStreamParagraphEvent)
      return
    }

    if (eventName === 'error') {
      throw new Error((payload as { message?: string }).message || '流式生成失败')
    }

    if (eventName === 'done') {
      receivedDone = true
      handlers.onDone(payload as T)
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read().catch(() => {
        throw new Error('处理连接已中断，请稍后重试。')
      })
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done })
      if (buffer.length > 16 * 1024 * 1024) throw new Error('返回内容过大，已停止接收。请检查已有结果。')

      let separator = /\r?\n\r?\n/.exec(buffer)
      while (separator) {
        const block = buffer.slice(0, separator.index)
        buffer = buffer.slice(separator.index + separator[0].length)
        handleEventBlock(block)
        separator = /\r?\n\r?\n/.exec(buffer)
      }

      if (done) {
        break
      }
    }
    if (buffer.trim()) handleEventBlock(buffer)
    if (!receivedDone) throw new Error('处理连接已中断，请稍后重试。')
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export const api = {
  recordAppOpen() { recordProductEvent('app.open', 'success', performance.now()) },
  getReferralSummary() {
    return requestCloudEnvelope<{ code: string; inviteUrl: string; invited: number; rewarded: number; earnedPoints: number;
      enabled: boolean; inviterPoints: number; inviteePoints: number; minPaymentFen: number }>('/api/account/referrals')
  },
  async getAnalyticsPreference() {
    const token = localStorage.getItem(CLOUD_TOKEN_STORAGE_KEY) ?? ''
    const result = await requestCloudEnvelope<{ enabled: boolean }>('/api/account/analytics-preference')
    if (token === localStorage.getItem(CLOUD_TOKEN_STORAGE_KEY)) analyticsToken = result.enabled ? token : ''
    return result
  },
  async setAnalyticsPreference(enabled: boolean) {
    analyticsToken = ''
    const token = localStorage.getItem(CLOUD_TOKEN_STORAGE_KEY) ?? ''
    const result = await requestCloudEnvelope<{ enabled: boolean }>('/api/account/analytics-preference', {
      method: 'PUT', body: JSON.stringify({ enabled }),
    })
    if (token === localStorage.getItem(CLOUD_TOKEN_STORAGE_KEY)) analyticsToken = result.enabled ? token : ''
    return result
  },
  verifyLegalText(text: string, online = false) {
    return requestV1<{ findings: import('./LegalReview').LegalFinding[]; truncated: boolean; timedOut?: boolean }>(
      '/api/v1/verification/legal', { method: 'POST', body: JSON.stringify({ text, online }) })
  },
  searchWeightedCases(payload: { keyword?: string; courtName?: string; judgeName?: string; courtWeight?: number; judgeWeight?: number }) {
    return requestV1<{ items: AppState['knowledgeCases']; configuredProviders: number; failedProviders: number }>(
      '/api/v1/knowledge/cases/search', { method: 'POST', body: JSON.stringify(payload) })
  },
  trackEvents(events: Array<{ id: string; name: string; surface: 'desktop' | 'web'; outcome: 'success' | 'failure'; durationMs: number }>) {
    return requestCloudEnvelope('/api/account/events', { method: 'POST', body: JSON.stringify({ events }) })
  },
  login(payload: LoginPayload) {
    return request<LoginResponse>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  },
  bindWorkspaceCloudAccount(payload: {
    email: string
    name?: string
    organization?: string
    role?: string
  }) {
    return request<WorkspaceResponse>('/api/auth/cloud-bind', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  },
  createCloudWorkspaceSession(payload: {
    email: string
    name?: string
    organization?: string
    role?: string
  }) {
    return request<LoginResponse>('/api/auth/cloud-session', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  },
  getWorkspace(signal?: AbortSignal) {
    return request<WorkspaceResponse>('/api/workspace', { signal })
  },
  recharge(amount = 100) {
    return request<WorkspaceResponse>('/api/billing/recharge', {
      method: 'POST',
      body: JSON.stringify({ amount }),
    })
  },
  getBillingCatalog() {
    return requestV1<{
      providers: PaymentProviderStatus[]
      packages: RechargePackage[]
    }>('/api/v1/billing/catalog')
  },
  createRechargeOrder(payload: {
    channel: PaymentProvider
    packageId: string
  }) {
    return requestV1<WorkspaceResponse & {
      order: RechargeOrder
      providers: PaymentProviderStatus[]
      packages: RechargePackage[]
    }>(
      '/api/v1/billing/orders',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
    )
  },
  getRechargeOrder(orderId: string) {
    return requestV1<WorkspaceResponse & {
      order: RechargeOrder
    }>(`/api/v1/billing/orders/${orderId}`)
  },
  getCloudDesktopSync(email: string) {
    return requestCloudEnvelope<{
      account: {
        id: string
        displayName: string
        email: string
        tierName: string
        pointsBalance: number
        subscriptionExpiresAt: string
      }
      ledger: {
        items: Array<{
          id: string
          createdAt: string
          description: string
          delta: number
          balanceAfter: number
          entryType?: 'recharge' | 'consume' | 'refund' | 'adjust' | 'freeze' | 'unfreeze'
          actionType?: PointActionType
          operationKey?: string
        }>
      }
    }>(`/api/client/desktop-sync?email=${encodeURIComponent(email)}`)
  },
  loginCloudAccount(payload: {
    email: string
    password: string
  }) {
    return requestCloudEnvelope<{
      token: string
      user: {
        id: string
        email: string
        name: string
      }
      organization: {
        id: string
        name: string
        role: string
      }
    }>('/api/account/login', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  },
  registerCloudAccount(payload: {
    organizationName: string
    ownerName: string
    email: string
    password: string
    inviteCode?: string
  }) {
    return requestCloudEnvelope<{
      token: string
      user: {
        id: string
        email: string
        name: string
      }
      organization: {
        id: string
        name: string
        role: string
      }
    }>('/api/account/register', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  },
  getCloudProfile() {
    return requestCloudEnvelope<{
      user: {
        email: string
        name: string
      }
      organization: {
        id: string
        name: string
        membershipId: string
        role: string
      }
    }>('/api/account/profile')
  },
  logoutCloudAccount() {
    return requestCloudEnvelope<{ ok: boolean }>('/api/account/logout', {
      method: 'POST',
    })
  },
  getCloudAccountSummary() {
    return requestCloudEnvelope<{
      id: string
      displayName: string
      email: string
      tierName: string
      pointsBalance: number
      subscriptionExpiresAt: string
    }>('/api/account/me')
  },
  getCloudPointPolicies() {
    return requestCloudEnvelope<{
      items: Array<{
        actionType: PointActionType
        label: string
        description: string
        unitLabel: string
        pointsPerUnit: number
      }>
    }>('/api/account/points/policies')
  },
  getCloudPointLedger() {
    return requestCloudEnvelope<{
      items: Array<{
        id: string
        createdAt: string
        description: string
        delta: number
        balanceAfter: number
        entryType?: 'recharge' | 'consume' | 'refund' | 'adjust' | 'freeze' | 'unfreeze'
        actionType?: PointActionType
        operationKey?: string
      }>
    }>('/api/account/point-ledger')
  },
  getLatestPublicRelease(channel: 'stable' | 'test' = 'stable') {
    const desktop = window.lawVerifyDesktop
    const query = new URLSearchParams({
      platform: desktop?.platform ?? 'win32',
      arch: desktop?.arch ?? 'x64',
      channel,
    })
    return requestCloudEnvelope<ReleaseItem | null>(`/api/web/releases/latest?${query}`)
  },
  submitCloudFeedback(payload: {
    feedbackType: 'bug' | 'suggestion' | 'experience' | 'other'
    title: string
    content: string
    contact?: string
    appVersion?: string
    clientPlatform?: string
    pageContext?: string
    caseName?: string
  }) {
    return requestCloudEnvelope<{
      item: {
        id: string
        status: 'pending' | 'reviewing' | 'resolved' | 'ignored'
        createdAt: string
      }
    }>('/api/account/feedback', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  },
  consumeCloudPointAction(payload: {
    actionType: PointActionType
    units?: number
    idempotencyKey: string
    workspaceId?: string
    resourceType?: string
    resourceId?: string
    note?: string
  }) {
    return requestCloudEnvelope<{
      entry: {
        id: string
        createdAt: string
        description: string
        delta: number
        balanceAfter: number
        entryType?: 'recharge' | 'consume' | 'refund' | 'adjust' | 'freeze' | 'unfreeze'
        actionType?: PointActionType
        operationKey?: string
      }
      policy: {
        actionType: PointActionType
        label: string
        description: string
        unitLabel: string
        pointsPerUnit: number
      }
      units: number
      requiredPoints: number
      pointsBalance: number
      duplicated: boolean
    }>('/api/account/points/consume', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  },
  refundCloudPointAction(payload: {
    refundOperationKey: string
    sourceOperationKey?: string
    sourceEntryId?: string
    note?: string
  }) {
    return requestCloudEnvelope<{
      entry: {
        id: string
        createdAt: string
        description: string
        delta: number
        balanceAfter: number
        entryType?: 'recharge' | 'consume' | 'refund' | 'adjust' | 'freeze' | 'unfreeze'
        actionType?: PointActionType
        operationKey?: string
      }
      pointsBalance: number
      duplicated: boolean
    }>('/api/account/points/refund', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  },
  createCase(name: string) {
    return request<WorkspaceResponse & { caseFolder: { id: string } }>('/api/cases', {
      method: 'POST',
      body: JSON.stringify({ name }),
    })
  },
  updateCase(caseId: string, patch: Record<string, unknown>) {
    return request<WorkspaceResponse>(`/api/cases/${caseId}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    })
  },
  rebuildCaseMemory(caseId: string) {
    return request<WorkspaceResponse>(`/api/cases/${caseId}/rebuild-memory`, {
      method: 'POST',
    })
  },
  assistantCapabilities() {
    return request<{ models: Array<{ id: string; label: string }>; voice: boolean }>('/api/assistant/capabilities')
  },
  transcribeAssistantAudio(audio: Blob, signal?: AbortSignal) {
    const form = new FormData()
    form.set('file', audio, audio.type === 'audio/mp4' ? 'speech.m4a' : 'speech.webm')
    return request<{ text: string }>('/api/assistant/transcriptions', { method: 'POST', body: form, signal })
  },
  caseAgentMessage(caseId: string, message: string, intent: 'position' | 'question',
    options?: import('./AssistantControls').AssistantSelection) {
    return request<WorkspaceResponse & { reply: string; proposal?: CasePositionDraft; positionVersion: number }>(
      `/api/cases/${caseId}/agent/message`, { method: 'POST', body: JSON.stringify({ message, intent, options }) },
    )
  },
  confirmCasePosition(caseId: string, position: CasePositionDraft, expectedVersion: number) {
    return request<WorkspaceResponse>(`/api/cases/${caseId}/agent/position`, {
      method: 'PUT', body: JSON.stringify({ position, expectedVersion }),
    })
  },
  retryCaseAgent(caseId: string, autoAnalyze?: boolean) {
    return request<WorkspaceResponse>(`/api/cases/${caseId}/agent/retry`, {
      method: 'POST', body: JSON.stringify({ autoAnalyze }),
    })
  },
  deleteCase(caseId: string) {
    return request<WorkspaceResponse>(`/api/cases/${caseId}`, {
      method: 'DELETE',
    })
  },
  importEvidences(payload: {
    caseId: string
    processInBackground?: boolean
    deferUnderstanding?: boolean
    files: Array<{
      fileName: string
      relativePath?: string
      contentHash?: string
      directoryId?: string
      name: string
      type: EvidenceType
      ocrText: string
      previewDataUrl?: string
      sourceDataUrl?: string
      storageKey?: string
      storageUrl?: string
      pageImageDataUrls?: string[]
      sourceMimeType?: string
      pages?: number
      anchorHint?: string
      summaryText?: string
      summaryStatus?: 'idle' | 'processing' | 'ready' | 'failed'
      summaryError?: string
      summaryUpdatedAt?: string
      summaryCacheKey?: string
    }>
  }) {
    return request<WorkspaceResponse>('/api/evidences/import', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  },
  uploadEvidenceSourceFiles(files: Array<File & { webkitRelativePath?: string }>) {
    const formData = new FormData()
    const manifest = files.map((file) => ({
      relativePath: file.webkitRelativePath || file.name,
      fileName: file.name,
      sourceMimeType: file.type,
    }))

    files.forEach((file) => {
      formData.append('files', file, file.name)
    })
    formData.append('manifest', JSON.stringify(manifest))

    return request<EvidenceSourceUploadResponse>('/api/evidences/assets/upload', {
      method: 'POST',
      body: formData,
    })
  },
  syncDirectoryEvidences(payload: {
    caseId: string
    processInBackground: boolean
    deferUnderstanding?: boolean
    files: Array<{
      fileName: string
      relativePath: string
      contentHash?: string
      sourceFingerprint?: string
      storageKey?: string
      storageUrl?: string
      sourceMimeType?: string
      directoryId: string
      name: string
      type: EvidenceType
      ocrText: string
    }>
  }) {
    return request<{ imported: number }>('/api/evidences/import?response=compact', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  },
  deleteDirectoryEvidence(evidenceId: string) {
    return request<{ deleted: boolean }>(`/api/evidences/${evidenceId}?response=compact`, {
      method: 'DELETE',
    })
  },
  clearCaseDirectoryEvidences(caseId: string) {
    return request<WorkspaceResponse>(`/api/cases/${caseId}/directory-evidences`, { method: 'DELETE' })
  },
  replaceEvidences(payload: {
    caseId: string
    files: Array<{
      fileName: string
      relativePath?: string
      name: string
      type: EvidenceType
      ocrText: string
      previewDataUrl?: string
      sourceDataUrl?: string
      storageKey?: string
      storageUrl?: string
      pageImageDataUrls?: string[]
      sourceMimeType?: string
      pages?: number
      anchorHint?: string
      summaryText?: string
      summaryStatus?: 'idle' | 'processing' | 'ready' | 'failed'
      summaryError?: string
      summaryUpdatedAt?: string
      summaryCacheKey?: string
    }>
  }) {
    return request<WorkspaceResponse>('/api/evidences/replace', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  },
  updateEvidence(evidenceId: string, patch: Record<string, unknown>) {
    return request<WorkspaceResponse>(`/api/evidences/${evidenceId}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    })
  },
  summarizeEvidence(evidenceId: string, options?: { force?: boolean; cacheOnly?: boolean }) {
    return request<WorkspaceResponse & {
      reusedCachedSummary?: boolean
      processing?: boolean
    }>(`/api/evidences/${evidenceId}/summarize`, {
      method: 'POST',
      body: options ? JSON.stringify(options) : undefined,
    })
  },
  deleteEvidence(evidenceId: string) {
    return request<WorkspaceResponse>(`/api/evidences/${evidenceId}`, {
      method: 'DELETE',
    })
  },
  generateCertificate(payload: {
    model?: string
    caseId: string
    evidenceIds: string[]
    role: RoleType
    focus: string
    prompt?: string
  }) {
    return request<WorkspaceResponse & {
      certificate: { id: string; title: string; focus: string; paragraphs: Array<{ id: string }> }
      agentReply?: string
    }>(
      '/api/certificates/generate',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
    )
  },
  generateCertificateStream(payload: {
    model?: string
    caseId: string
    evidenceIds: string[]
    role: RoleType
    focus: string
    prompt?: string
  }, handlers: CertificateStreamHandlers) {
    return streamRequest('/api/certificates/generate/stream', {
      method: 'POST',
      body: JSON.stringify(payload),
    }, handlers)
  },
  rewriteCertificate(payload: {
    model?: string
    certificateId: string
    evidenceIds: string[]
    prompt: string
  }) {
    return request<WorkspaceResponse & {
      certificate: { id: string; title: string; focus: string; paragraphs: Array<{ id: string }> }
      agentReply?: string
    }>(
      `/api/certificates/${payload.certificateId}/rewrite`,
      {
        method: 'POST',
        body: JSON.stringify({
          model: payload.model,
          evidenceIds: payload.evidenceIds,
          prompt: payload.prompt,
        }),
      },
    )
  },
  rewriteCertificateStream(payload: {
    model?: string
    certificateId: string
    evidenceIds: string[]
    prompt: string
  }, handlers: CertificateStreamHandlers) {
    return streamRequest(`/api/certificates/${payload.certificateId}/rewrite/stream`, {
      method: 'POST',
      body: JSON.stringify({
        model: payload.model,
        evidenceIds: payload.evidenceIds,
        prompt: payload.prompt,
      }),
    }, handlers)
  },
  importCertificate(payload: {
    caseId: string
    title: string
    content: string
    sourceFileName: string
    paragraphs?: Array<{
      text: string
      richText?: string
    }>
  }) {
    return request<WorkspaceResponse & { certificate: { id: string; paragraphs: Array<{ id: string }> } }>(
      '/api/certificates/import',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
    )
  },
  updateParagraph(
    certificateId: string,
    paragraphId: string,
    patch: Partial<CertificateParagraph>,
    expected?: { text: string; richText?: string },
  ) {
    return request<WorkspaceResponse>(
      `/api/certificates/${certificateId}/paragraphs/${paragraphId}`,
      {
        method: 'PATCH',
          body: JSON.stringify({ ...patch, ...(expected ? { expectedContent: expected } : {}) }),
      },
    )
  },
  async autoLinkCertificate(certificateId: string, onProgress?: (text: string) => void) {
    type LinkageResult = WorkspaceResponse & {
      linkedParagraphCount: number
      evidenceLinkCount: number
      statuteReferenceCount: number
      caseReferenceCount: number
    }
    let result: LinkageResult | undefined
    await streamRequest<LinkageResult>(`/api/certificates/${certificateId}/auto-link/stream`, {
      method: 'POST',
    }, {
      onProgress: (event) => onProgress?.(event.text),
      onDone: (payload) => { result = payload },
    })
    if (!result) throw new Error('证据联动未完成，请稍后重试。')
    return result
  },
  reviewParagraph(certificateId: string, paragraphId: string) {
    return request<WorkspaceResponse & { reviewedCount: number }>(
      `/api/certificates/${certificateId}/paragraphs/${paragraphId}/ai-review`,
      {
        method: 'POST',
      },
    )
  },
  getCollaboraSession(certificateId: string) {
    return requestV1<CollaboraSession>(`/api/v1/integrations/collabora/certificates/${certificateId}/session`, {
      method: 'POST',
    })
  },
  importKnowledgeStatutes(payload: {
    items: AppState['knowledgeStatutes']
  }) {
    return requestV1<WorkspaceResponse & { importedCount: number }>(
      '/api/v1/knowledge/statutes/import',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
    )
  },
  importKnowledgeCases(payload: {
    items: AppState['knowledgeCases']
  }) {
    return requestV1<WorkspaceResponse & { importedCount: number }>(
      '/api/v1/knowledge/cases/import',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
    )
  },
  importKnowledgeFiles(payload: {
    files: Array<{
      title?: string
      fileName: string
      mimeType?: string
      fileSize?: number
      extractedText?: string
      extractionStatus?: 'ready' | 'pending' | 'failed'
      extractionError?: string
      linkedStatuteIds?: string[]
    }>
  }) {
    return requestV1<WorkspaceResponse & { importedCount: number }>(
      '/api/v1/knowledge/files/import',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
    )
  },
  uploadKnowledgeFiles(files: File[]) {
    const formData = new FormData()
    const manifest = files.map((file) => ({
      title: file.name.replace(/\.[^.]+$/, ''),
      relativePath:
        'webkitRelativePath' in file && typeof file.webkitRelativePath === 'string' && file.webkitRelativePath.trim()
          ? file.webkitRelativePath.replace(/\\/g, '/')
          : file.name,
    }))

    for (const file of files) {
      formData.append('files', file)
    }

    formData.append('manifest', JSON.stringify(manifest))

    return requestV1<WorkspaceResponse & {
      importedCount: number
      files: AppState['knowledgeFiles']
    }>(
      '/api/v1/knowledge/files/upload',
      {
        method: 'POST',
        body: formData,
      },
    )
  },
  reindexKnowledgeFile(fileId: string) {
    return requestV1<WorkspaceResponse & { file: AppState['knowledgeFiles'][number] }>(
      `/api/v1/knowledge/files/${fileId}/reindex`,
      {
        method: 'POST',
      },
    )
  },
  recommendKnowledgeCases(payload: {
    caseId?: string
    paragraphText?: string
    focus?: string
  }) {
    return requestV1<{ items: AppState['knowledgeCases'] }>(
      '/api/v1/knowledge/recommend/cases',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
    )
  },
  recommendKnowledgeStatutes(payload: {
    caseId?: string
    paragraphText?: string
    focus?: string
  }) {
    return requestV1<{ items: AppState['knowledgeStatutes'] }>(
      '/api/v1/knowledge/recommend/statutes',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
    )
  },
}
