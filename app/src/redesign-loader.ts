let pending: Promise<typeof import('./redesign/RedesignApp')> | undefined

export function loadRedesign() {
  pending ??= import('./redesign/RedesignApp').catch(cause => {
    pending = undefined
    throw cause
  })
  return pending
}

export function preloadRedesign() {
  void loadRedesign().catch(() => {
    // 预加载失败由正式进入页面时重试，登录请求继续独立处理。
  })
}

export function whenUiIdle(task: () => void) {
  if (typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(task)
    return () => window.cancelIdleCallback(id)
  }
  const id = window.setTimeout(task, 0)
  return () => window.clearTimeout(id)
}
