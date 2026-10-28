const API_BASE = (
  (import.meta.env.DEV ? (import.meta.env.VITE_CLOUD_API_BASE as string | undefined)?.trim() : '')
  || (import.meta.env.DEV ? 'http://127.0.0.1:8788' : '')
).replace(/\/$/, '')
const TOKEN_STORAGE_KEY = 'lawverify-cloud-token'
const DESKTOP_TOKEN_QUERY_KEY = 'desktopToken'

export class ApiError extends Error {
  status: number
  code: string

  constructor(message: string, status = 0, code = 'API_ERROR') {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

type Envelope<T> = {
  success: boolean
  data: T
  error?: {
    message?: string
    code?: string
  }
}

function getDefaultHttpErrorMessage(response: Response) {
  if (response.status === 503) {
    return '账户中心服务正在维护，请稍后重试。'
  }

  if (response.status >= 500) {
    return '账户中心服务暂时不可用，请稍后重试。'
  }

  return `Request failed: ${response.status} ${response.statusText}`.trim()
}

function getAuthToken() {
  return window.localStorage.getItem(TOKEN_STORAGE_KEY) ?? ''
}

function setAuthToken(token: string) {
  if (!token.trim()) {
    window.localStorage.removeItem(TOKEN_STORAGE_KEY)
    return
  }

  window.localStorage.setItem(TOKEN_STORAGE_KEY, token)
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers ?? {})
  if (!headers.has('Content-Type') && !(init?.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json')
  }

  const token = getAuthToken()
  if (token) {
    headers.set('Authorization', `Bearer ${token}`)
  }

  let response: Response
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : '网络请求失败，请稍后重试。'
    throw new ApiError(message, 0, 'NETWORK_ERROR')
  }

  let payload: Envelope<T> | null = null
  try {
    payload = await response.json() as Envelope<T>
  } catch {
    payload = null
  }

  if (!response.ok || !payload?.success) {
    throw new ApiError(
      payload?.error?.message || getDefaultHttpErrorMessage(response),
      response.status,
      payload?.error?.code || 'API_ERROR',
    )
  }

  return payload.data
}

export function isAuthApiError(error: unknown): error is ApiError {
  return error instanceof ApiError
    && error.status === 401
    && ['UNAUTHORIZED', 'INVALID_TOKEN', 'INVALID_SESSION', 'SESSION_REPLACED'].includes(error.code)
}

export const authStorage = {
  getToken: getAuthToken,
  setToken: setAuthToken,
  clear() {
    window.localStorage.removeItem(TOKEN_STORAGE_KEY)
  },
}

export function consumeDesktopTokenFromUrl() {
  const currentUrl = new URL(window.location.href)
  const desktopToken = currentUrl.searchParams.get(DESKTOP_TOKEN_QUERY_KEY)?.trim() ?? ''
  if (!desktopToken) {
    return ''
  }

  setAuthToken(desktopToken)
  currentUrl.searchParams.delete(DESKTOP_TOKEN_QUERY_KEY)
  const nextUrl = `${currentUrl.pathname}${currentUrl.search ? currentUrl.search : ''}${currentUrl.hash}`
  window.history.replaceState({}, '', nextUrl)
  return desktopToken
}

export const api = {
  register(payload: {
    organizationName: string
    ownerName: string
    email: string
    password: string
  }) {
    return request<{
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
  login(payload: {
    email: string
    password: string
  }) {
    return request<{
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
  logout() {
    return request<{ ok: boolean }>('/api/account/logout', {
      method: 'POST',
    })
  },
  getProfile() {
    return request<{
      user: {
        id: string
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
  getSiteConfig() {
    return request<{
      siteName: string
      appName: string
      webOrigin: string
      supportEmail: string
      accountCenterUrl: string
    }>('/api/web/site/config')
  },
  getPlans() {
    return request<{
      items: Array<{
        id: string
        name: string
        priceLabel: string
        billingCycle: string
        description: string
        highlights: string[]
        points: number
        recommended?: boolean
      }>
    }>('/api/web/plans')
  },
  getReleases() {
    return request<{
      items: Array<{
        id: string
        version: string
        platform?: 'win32' | 'darwin'
        arch?: 'x64' | 'arm64'
        channel: string
        sizeLabel: string
        publishedAt: string
        sha256: string
        notes: string[]
        downloadUrl: string
        checksumUrl?: string
      }>
    }>('/api/web/releases')
  },
  getAccountSummary() {
    return request<{
      id: string
      displayName: string
      email: string
      tierName: string
      pointsBalance: number
      subscriptionExpiresAt: string
    }>('/api/account/me')
  },
  getUsageSummary() {
    return request<{
      items: Array<{
        label: string
        value: string
      }>
    }>('/api/account/usage/summary')
  },
  getPointPolicies() {
    return request<{
      items: Array<{
        actionType: string
        label: string
        description: string
        unitLabel: string
        pointsPerUnit: number
      }>
    }>('/api/account/points/policies')
  },
  getPointLedger() {
    return request<{
      items: Array<{
        id: string
        createdAt: string
        description: string
        delta: number
        balanceAfter: number
        entryType?: 'recharge' | 'consume' | 'refund' | 'adjust' | 'freeze' | 'unfreeze'
        actionType?: string
        operationKey?: string
      }>
    }>('/api/account/point-ledger')
  },
  getAdminDashboard() {
    return request<{
      totalUsers: number
      totalOrganizations: number
      totalPointsConsumed: number
      userGrowthTrend: Array<{
        date: string
        label: string
        value: number
      }>
      tokenConsumptionTrend: Array<{
        date: string
        label: string
        value: number
      }>
    }>('/api/admin/dashboard')
  },
  getAdminUsers() {
    return request<{
      users: Array<{
        id: string
        email: string
        name: string
        createdAt: string
        pointsBalance: number
      }>
    }>('/api/admin/users')
  },
  getAdminUsage() {
    return request<{
      users: Array<{
        name: string
        email: string
        totalConsumed: number
        actionCount: number
        lastConsumedAt: string
      }>
      logs: Array<{
        id: string
        name: string
        email: string
        actionType: string
        changePoints: number
        note: string
        createdAt: string
      }>
    }>('/api/admin/usage')
  },
  getAdminFeedback() {
    return request<{
      overview: {
        totalCount: number
        pendingCount: number
        reviewingCount: number
        resolvedCount: number
        ignoredCount: number
        last7DaysCount: number
        bugCount: number
        suggestionCount: number
      }
      trend: Array<{
        date: string
        label: string
        value: number
      }>
      typeStats: Array<{
        key: 'bug' | 'suggestion' | 'experience' | 'other'
        label: string
        count: number
      }>
      statusStats: Array<{
        key: 'pending' | 'reviewing' | 'resolved' | 'ignored'
        label: string
        count: number
      }>
      versionStats: Array<{
        version: string
        count: number
      }>
      topUsers: Array<{
        name: string
        email: string
        count: number
        lastSubmittedAt: string
      }>
      topKeywords: Array<{
        keyword: string
        count: number
      }>
      items: Array<{
        id: string
        userEmail: string
        userName: string
        feedbackType: 'bug' | 'suggestion' | 'experience' | 'other'
        feedbackTypeLabel: string
        title: string
        content: string
        contact?: string
        appVersion?: string
        clientPlatform?: string
        pageContext?: string
        caseName?: string
        status: 'pending' | 'reviewing' | 'resolved' | 'ignored'
        statusLabel: string
        adminNote?: string
        createdAt: string
        updatedAt: string
        handledAt?: string
        handledByEmail?: string
      }>
    }>('/api/admin/feedback')
  },
  updateAdminFeedback(payload: {
    id: string
    status: 'pending' | 'reviewing' | 'resolved' | 'ignored'
    adminNote?: string
  }) {
    return request<{
      item: {
        id: string
        status: 'pending' | 'reviewing' | 'resolved' | 'ignored'
        statusLabel: string
        updatedAt: string
        handledAt?: string
        handledByEmail?: string
      }
    }>(`/api/admin/feedback/${encodeURIComponent(payload.id)}`, {
      method: 'PATCH',
      body: JSON.stringify({
        status: payload.status,
        adminNote: payload.adminNote,
      }),
    })
  },
  getBillingOrders() {
    return request<{
      items: Array<{
        id: string
        orderNo: string
        packageId: string
        packageName: string
        amountFen: number
        points: number
        channel: 'alipay' | 'wechat'
        status: 'pending' | 'paid' | 'closed' | 'failed'
        qrCodeContent: string
        paymentUrl?: string
        providerOrderId?: string
        createdAt: string
        paidAt?: string
      }>
      summary: {
        total: number
        paid: number
        pending: number
      }
    }>('/api/billing/orders')
  },
  getBillingOrder(orderId: string) {
    return request<{
      order: {
        id: string
        orderNo: string
        packageId: string
        packageName: string
        amountFen: number
        points: number
        channel: 'alipay' | 'wechat'
        status: 'pending' | 'paid' | 'closed' | 'failed'
        qrCodeContent: string
        paymentUrl?: string
        providerOrderId?: string
        createdAt: string
        paidAt?: string
      }
    }>(`/api/billing/orders/${encodeURIComponent(orderId)}`)
  },
  getBillingCatalog() {
    return request<{
      providers: Array<{
        id: 'alipay' | 'wechat'
        label: string
        enabled: boolean
        reason?: string
      }>
      packages: Array<{
        id: string
        name: string
        amountFen: number
        points: number
        description: string
      }>
    }>('/api/billing/catalog')
  },
  createBillingOrder(payload: {
    packageId: string
    channel: 'alipay' | 'wechat'
  }) {
    return request<{
      order: {
        id: string
        orderNo: string
        packageId: string
        packageName: string
        amountFen: number
        points: number
        channel: 'alipay' | 'wechat'
        status: 'pending' | 'paid' | 'closed' | 'failed'
        qrCodeContent: string
        paymentUrl?: string
        providerOrderId?: string
        createdAt: string
        paidAt?: string
      }
      providers: Array<{
        id: 'alipay' | 'wechat'
        label: string
        enabled: boolean
        reason?: string
      }>
      packages: Array<{
        id: string
        name: string
        amountFen: number
        points: number
        description: string
      }>
    }>('/api/billing/orders', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  },
  completeBillingOrderForDevelopment(orderId: string) {
    return request<{
      order: {
        id: string
        orderNo: string
        packageId: string
        packageName: string
        amountFen: number
        points: number
        channel: 'alipay' | 'wechat'
        status: 'pending' | 'paid' | 'closed' | 'failed'
        qrCodeContent: string
        paymentUrl?: string
        providerOrderId?: string
        createdAt: string
        paidAt?: string
      }
    }>(`/api/billing/orders/${encodeURIComponent(orderId)}/dev-complete`, {
      method: 'POST',
    })
  },
  getInvoiceRequests() {
    return request<{
      items: Array<{
        id: string
        orderId: string
        title: string
        taxNo: string
        registeredAddress: string
        registeredPhone: string
        bankName: string
        bankAccount: string
        recipientEmail?: string
        amountLabel: string
        status: 'draft' | 'submitted' | 'issued'
      }>
    }>('/api/invoices/requests')
  },
  createInvoiceRequest(payload?: {
    orderId?: string
    title: string
    taxNo: string
    registeredAddress: string
    registeredPhone: string
    bankName: string
    bankAccount: string
    recipientEmail?: string
  }) {
    return request<{
      request: {
        id: string
        orderId: string
        title: string
        taxNo: string
        registeredAddress: string
        registeredPhone: string
        bankName: string
        bankAccount: string
        recipientEmail?: string
        amountLabel: string
        status: 'draft' | 'submitted' | 'issued'
      }
    }>('/api/invoices/requests', {
      method: 'POST',
      body: JSON.stringify(payload ?? {}),
    })
  },
}
