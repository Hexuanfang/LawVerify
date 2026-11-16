import { getLoginWorkspace } from '../auth-transition'
import { loadInitialWorkspace } from '../workspace-bootstrap'
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, watchWorkspace } from '../api'
import type { AppState } from '../types'
import { endSession, isSessionFailure } from './session'

export function useWorkspace() {
  const [initial] = useState(getLoginWorkspace)
  const [workspace, setWorkspace] = useState<AppState | null>(initial)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(!initial)
  const account = useRef(sessionStorage.getItem('lawverify-login-account'))
  const token = useRef(sessionStorage.getItem('lawverify-auth-session'))
  const live = useRef(true)
  const sequence = useRef(0)
  const mutating = useRef(false)
  const isCurrent = useCallback(
    () =>
      live.current &&
      account.current === sessionStorage.getItem('lawverify-login-account') &&
      token.current === sessionStorage.getItem('lawverify-auth-session'),
    [],
  )
  const refresh = useCallback(async (initialLoad = false) => {
    const request = ++sequence.current
    try {
      const result = await (initialLoad ? loadInitialWorkspace() : api.getWorkspace())
      if (isCurrent() && request === sequence.current && !mutating.current) setWorkspace(result.workspace)
    } catch (cause) {
      if (isCurrent() && isSessionFailure(cause)) endSession(cause instanceof Error ? cause.message : '登录已失效，请重新登录。')
      throw cause
    }
  }, [isCurrent])
  const mutate = useCallback(
    async <T>(operation: () => Promise<T>): Promise<T> => {
      if (mutating.current) throw new Error('上一项操作正在保存，请稍候。')
      if (!isCurrent()) throw new Error('当前登录账号已变化，请重新打开页面。')
      mutating.current = true
      sequence.current++
      setBusy(true)
      setError('')
      try {
        const result = await operation()
        if (!isCurrent())
          throw new Error('当前登录账号已变化，请重新打开页面。')
        const latest = await api.getWorkspace()
        if (isCurrent()) setWorkspace(latest.workspace)
        return result
      } catch (cause) {
        if (isCurrent() && isSessionFailure(cause)) endSession(cause instanceof Error ? cause.message : '登录已失效，请重新登录。')
        // 上传或编辑可能部分完成，错误后仍回读已落盘的数据。
        try {
          const latest = await api.getWorkspace()
          if (isCurrent()) setWorkspace(latest.workspace)
        } catch (refreshError) {
          if (isCurrent() && isSessionFailure(refreshError)) endSession(refreshError instanceof Error ? refreshError.message : '登录已失效，请重新登录。')
          /* 保留原始错误。 */
        }
        if (isCurrent())
          setError(
            cause instanceof Error ? cause.message : '操作失败，请重试。',
          )
        throw cause
      } finally {
        mutating.current = false
        if (live.current) setBusy(false)
      }
    },
    [isCurrent],
  )
  useEffect(() => {
    live.current = true
    void refresh(true)
      .catch((cause) => {
        if (isCurrent() && isSessionFailure(cause)) endSession(cause.message)
        else if (isCurrent()) setError(cause.message)
      })
      .finally(() => {
        if (isCurrent()) setLoading(false)
      })
    let timer: ReturnType<typeof setTimeout> | undefined
    const unsubscribe = watchWorkspace(() => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        if (!mutating.current) void refresh().catch(() => {})
      }, 500)
    })
    return () => {
      live.current = false
      clearTimeout(timer)
      unsubscribe()
    }
  }, [refresh, isCurrent])
  return { workspace, loading, busy, error, setError, refresh, mutate }
}
