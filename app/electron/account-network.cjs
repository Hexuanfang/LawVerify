const ACCOUNT_REQUEST_CHANNEL = 'lawverify:account-request'
const ACCOUNT_BASE_URL = 'https://lawagent.zhijing.fun'
const MAX_BODY_BYTES = 2 * 1024 * 1024
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const allowedHeaders = new Set(['authorization', 'content-type', 'accept', 'x-product-surface'])

function createAccountRequestHandler({ fetch, isTrustedSender, report = () => {}, baseUrl = ACCOUNT_BASE_URL }) {
  const origin = new URL(baseUrl).origin
  let inFlight = 0
  return async (event, payload) => {
    if (!isTrustedSender(event) || !payload || typeof payload.path !== 'string') {
      throw new Error('Untrusted account request')
    }
    if (payload.path.length > 4096 || !payload.path.startsWith('/api/') || /[\\#]/.test(payload.path)) {
      throw new Error('Invalid account request path')
    }
    const url = new URL(payload.path, origin)
    if (url.origin !== origin || !/^\/api\/(?:account|billing|invoices|client|web)(?:\/|$)/.test(url.pathname)) {
      throw new Error('Account request endpoint is not allowed')
    }
    const method = String(payload.method || 'GET').toUpperCase()
    if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      throw new Error('Invalid account request method')
    }
    if (payload.body !== undefined && (typeof payload.body !== 'string' || Buffer.byteLength(payload.body) > MAX_BODY_BYTES)) {
      throw new Error('Account request body exceeds limit')
    }
    const headers = new Headers()
    for (const [name, value] of Object.entries(payload.headers || {})) {
      if (!allowedHeaders.has(name.toLowerCase())) continue
      if (typeof value !== 'string' || value.length > 16384) throw new Error('Invalid account request header')
      headers.set(name, value)
    }
    if (inFlight >= 8) return { status: 429, body: '{"success":false,"error":{"message":"账户请求较多，请稍后重试。","code":"ACCOUNT_BUSY"}}' }
    inFlight++
    const started = Date.now()
    try {
      // No retry of mutations: a lost response may already have created an order.
      const response = await fetch(url.href, {
        method, headers, body: ['GET', 'HEAD'].includes(method) ? undefined : payload.body,
        signal: AbortSignal.timeout(30000), redirect: 'error', credentials: 'omit',
      })
      const chunks = []
      let size = 0
      if (response.body) {
        const reader = response.body.getReader()
        try {
          while (true) {
            const { value, done } = await reader.read()
            if (done) break
            size += value.byteLength
            if (size > MAX_RESPONSE_BYTES) throw Object.assign(new Error('Response too large'), { code: 'ACCOUNT_RESPONSE_TOO_LARGE' })
            chunks.push(value)
          }
        } finally { await reader.cancel().catch(() => {}) }
      }
      report('account-response', { code: `HTTP_${response.status}`, duration: Date.now() - started })
      return { status: response.status, body: Buffer.concat(chunks).toString('utf8') }
    } catch (error) {
      const candidate = error?.cause?.code || error?.code || String(error?.message || '').match(/net::(ERR_[A-Z_]+)/)?.[1]
        || error?.name || 'NETWORK_ERROR'
      const code = /^[a-z0-9_.-]{1,64}$/i.test(String(candidate)) ? String(candidate) : 'NETWORK_ERROR'
      report('account-network-failed', { code, duration: Date.now() - started })
      return { status: 0, body: '', code }
    } finally { inFlight-- }
  }
}

module.exports = { ACCOUNT_REQUEST_CHANNEL, ACCOUNT_BASE_URL, createAccountRequestHandler }
