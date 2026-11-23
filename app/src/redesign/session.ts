import { useEffect } from 'react'
import { api, isCloudAuthApiError } from '../api'

const AUTH = 'lawverify-auth-session'
const ACCOUNT = 'lawverify-login-account'
const CLOUD = 'lawverify-cloud-token'
export const SESSION_NOTICE = 'lawverify-session-notice'

export function isSessionFailure(cause: unknown) {
  return isCloudAuthApiError(cause) || (cause instanceof Error && 'status' in cause && cause.status === 401)
}

let endingSession = false
let rotatingToken: string | null = null
let profileRevision = 0

export async function saveSessionProfile(payload: Parameters<typeof api.updateCloudProfile>[0]) {
  const profile = await api.updateCloudProfile(payload)
  profileRevision += 1
  return profile
}

export async function changeSessionPassword(payload: { currentPassword: string; newPassword: string }) {
  const account = sessionStorage.getItem(ACCOUNT)
  const auth = sessionStorage.getItem(AUTH)
  const token = localStorage.getItem(CLOUD)
  if (!auth || !token || rotatingToken) throw new Error('当前账号无法修改密码，请稍后重试。')
  rotatingToken = token
  try {
    const result = await api.changeCloudPassword(payload)
    if (account !== sessionStorage.getItem(ACCOUNT) || auth !== sessionStorage.getItem(AUTH)
      || token !== localStorage.getItem(CLOUD)) return false
    localStorage.setItem(CLOUD, result.token)
    void api.getAnalyticsPreference().catch(() => {})
    return true
  } finally {
    rotatingToken = null
  }
}

export function endSession(message = '') {
  if (endingSession) return
  endingSession = true
  if (localStorage.getItem(CLOUD)) void api.logoutCloudAccount().catch(() => {})
  sessionStorage.removeItem(AUTH)
  sessionStorage.removeItem(ACCOUNT)
  localStorage.removeItem(AUTH)
  localStorage.removeItem('lawverify-auth-token')
  localStorage.removeItem(CLOUD)
  if (message) sessionStorage.setItem(SESSION_NOTICE, message)
  location.reload()
}

function leaveLocalSession(message: string) {
  sessionStorage.removeItem(AUTH)
  sessionStorage.removeItem(ACCOUNT)
  sessionStorage.setItem(SESSION_NOTICE, message)
  location.reload()
}

export function useSession(onLeaving: () => void, onProfile: (profile: Awaited<ReturnType<typeof api.getCloudProfile>>) => void) {
  useEffect(() => {
    const account = sessionStorage.getItem(ACCOUNT)
    const auth = sessionStorage.getItem(AUTH)
    let hadCloudToken = Boolean(localStorage.getItem(CLOUD))
    let live = true, checking = false
    const sameAccount = () => account === sessionStorage.getItem(ACCOUNT) && auth === sessionStorage.getItem(AUTH)
    const check = async () => {
      const token = localStorage.getItem(CLOUD)
      if (!sameAccount() || !auth || (hadCloudToken && !token)) {
        onLeaving()
        leaveLocalSession('登录账号已变化，请重新登录。')
        return
      }
      hadCloudToken ||= Boolean(token)
      if (!token || token === rotatingToken || checking) return
      const isCurrent = () => live && sameAccount() && token === localStorage.getItem(CLOUD)
      const revision = profileRevision
      checking = true
      try {
        const profile = await api.getCloudProfile()
        if (!isCurrent()) return
        if (profile.user.email.trim().toLowerCase() !== account?.trim().toLowerCase()) {
          onLeaving(); leaveLocalSession('云端账号与当前工作区不一致，请重新登录。')
        } else if (revision === profileRevision) onProfile(profile)
      } catch (cause) {
        // 断网不退出；只处理服务端明确返回的认证失效。
        if (isCurrent() && token !== rotatingToken && isSessionFailure(cause)) {
          onLeaving()
          endSession(cause instanceof Error ? cause.message : '登录已失效，请重新登录。')
        }
      } finally { checking = false }
    }
    void check()
    const timer = setInterval(() => void check(), 60000)
    const focus = () => void check()
    window.addEventListener('focus', focus)
    window.addEventListener('storage', focus)
    return () => { live = false; clearInterval(timer); window.removeEventListener('focus', focus); window.removeEventListener('storage', focus) }
  }, [onLeaving, onProfile])
}
