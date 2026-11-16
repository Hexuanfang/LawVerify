let pending: Promise<typeof import('./redesign/RedesignApp')> | undefined

export function loadRedesign() {
  pending ??= import('./redesign/RedesignApp').catch(cause => {
    pending = undefined
    throw cause
  })
  return pending
}

export function preloadRedesign() {
  if (new URLSearchParams(location.search).get('ui') === 'legacy') return
  void loadRedesign().catch(() => {
    // 预加载失败由正式进入页面时重试，登录请求继续独立处理。
  })
}
