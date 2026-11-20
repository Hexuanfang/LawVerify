export const OFFICIAL_PLATFORM_BASE_URL = 'https://lawverify.zhijing.fun'
const DEV_SERVICE_HOST = typeof window !== 'undefined'
  && window.location.hostname
  && window.location.hostname !== 'localhost'
  && window.location.hostname !== '127.0.0.1'
  ? window.location.hostname
  : '127.0.0.1'
export const ACCOUNT_CENTER_BASE_URL = (
  import.meta.env.VITE_ACCOUNT_CENTER_URL?.trim()
  ?? (import.meta.env.DEV ? `http://${DEV_SERVICE_HOST}:4273` : OFFICIAL_PLATFORM_BASE_URL)
).replace(/\/$/, '')

export function isLocalOriginUrl(url: string) {
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

export async function openExternalUrl(url: string) {
  if (typeof window !== 'undefined' && window.lawVerifyDesktop?.openExternal) {
    await window.lawVerifyDesktop.openExternal(url)
    return
  }

  window.open(url, '_blank', 'noopener,noreferrer')
}

