import { api } from './api'

const pending = new Map<string, ReturnType<typeof api.getWorkspace>>()

// StrictMode 的初始化与重挂载共用进行中的请求，普通刷新仍读取最新数据。
export function loadInitialWorkspace() {
  const key = JSON.stringify([
    sessionStorage.getItem('lawverify-login-account'),
    sessionStorage.getItem('lawverify-auth-session'),
    localStorage.getItem('lawverify-cloud-token'),
  ])
  let request = pending.get(key)
  if (!request) {
    request = api.getWorkspace()
    pending.set(key, request)
    const current = request
    void request.finally(() => { if (pending.get(key) === current) pending.delete(key) }).catch(() => {})
  }
  return request
}
