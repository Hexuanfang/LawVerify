import type { AppState } from './types'

export const AUTH_CHANGED = 'lawverify-auth-changed'
type LoginWorkspace = { account: string; token: string; workspace: AppState; createdAt: number }
let loginWorkspace: LoginWorkspace | null = null

export function usesRedesign() {
  return new URLSearchParams(location.search).get('ui') !== 'legacy'
}

export function notifyAuthChanged() {
  window.dispatchEvent(new Event(AUTH_CHANGED))
}

export function handoffLoginWorkspace(account: string, token: string, workspace: AppState) {
  if (!usesRedesign()) return false
  // 只在当前页面内交接，工作区不写入浏览器持久存储。
  loginWorkspace = { account: account.trim().toLowerCase(), token, workspace, createdAt: Date.now() }
  notifyAuthChanged()
  return true
}

export function getLoginWorkspace() {
  if (!loginWorkspace) return null
  const account = sessionStorage.getItem('lawverify-login-account')?.trim().toLowerCase()
  const token = sessionStorage.getItem('lawverify-auth-session')
  if (account !== loginWorkspace.account || token !== loginWorkspace.token
    || loginWorkspace.workspace.user.email?.trim().toLowerCase() !== account
    || Date.now() - loginWorkspace.createdAt > 60_000) {
    loginWorkspace = null
    return null
  }
  return loginWorkspace.workspace
}
