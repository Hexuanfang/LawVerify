export function reportDiagnostic(event: string, details: { duration?: number; count?: number } = {}) {
  window.lawVerifyDesktop?.reportDiagnostic?.({ event, ...details })
}

export function installStabilityMonitoring() {
  window.addEventListener('error', () => reportDiagnostic('renderer-error'))
  window.addEventListener('unhandledrejection', () => reportDiagnostic('renderer-rejection'))
  if (!PerformanceObserver.supportedEntryTypes.includes('longtask')) return
  let lastReport = 0
  const observer = new PerformanceObserver(list => {
    const entries = list.getEntries().filter(entry => entry.duration >= 100)
    if (!entries.length || performance.now() - lastReport < 10000) return
    lastReport = performance.now()
    reportDiagnostic('renderer-long-task', {
      duration: Math.round(Math.max(...entries.map(entry => entry.duration))), count: entries.length,
    })
  })
  observer.observe({ type: 'longtask', buffered: true })
}
