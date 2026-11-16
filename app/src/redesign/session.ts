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

export function useSession(onLeaving: () => void) {
  useEffect(() => {
    const account = sessionStorage.getItem(ACCOUNT)
    const token = localStorage.getItem(CLOUD)
    let live = true, checking = false
    const sameAccount = () => account === sessionStorage.getItem(ACCOUNT) && token === localStorage.getItem(CLOUD)
    const check = async () => {
      if (!sameAccount() || !sessionStorage.getItem(AUTH)) {
        onLeaving()
        leaveLocalSession('登录账号已变化，请重新登录。')
        return
      }
      if (!token || checking) return
      checking = true
      try {
        const profile = await api.getCloudProfile()
        if (live && sameAccount() && profile.user.email.trim().toLowerCase() !== account?.trim().toLowerCase()) {
          onLeaving(); leaveLocalSession('云端账号与当前工作区不一致，请重新登录。')
        }
      } catch (cause) {
        // 断网不退出；只处理服务端明确返回的认证失效。
        if (live && sameAccount() && isSessionFailure(cause)) {
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
  }, [onLeaving])
}
