import { Component, useEffect, useState, type ErrorInfo, type ReactNode } from 'react'
import './stability.css'
import { reportDiagnostic } from './stability-monitor'

export class StabilityBoundary extends Component<{ children: ReactNode; module?: boolean }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(_error: Error, _info: ErrorInfo) { reportDiagnostic('react-boundary') }
  render() {
    if (!this.state.failed) return this.props.children
    return <section className="stability-fallback" role="alert">
      <strong>{this.props.module ? '当前预览暂不可用' : '当前窗口暂不可用'}</strong>
      <p>本地材料和草稿会保留。</p>
      <button type="button" onClick={() => {
        if (this.props.module) this.setState({ failed: false })
        else window.location.reload()
      }}>{this.props.module ? '重试预览' : '恢复窗口'}</button>
    </section>
  }
}

export function ServiceRecoveryNotice() {
  const [state, setState] = useState('idle')
  useEffect(() => {
    let active = true
    const desktop = window.lawVerifyDesktop
    const unsubscribe = desktop?.onServiceStatus?.(status => {
      if (!active) return
      setState(status.state)
      if (status.state === 'ready') window.dispatchEvent(new Event('lawverify:service-ready'))
    })
    void desktop?.getServiceStatus?.().then(status => { if (active) setState(status.state) }).catch(() => {})
    return () => { active = false; unsubscribe?.() }
  }, [])
  if (!['recovering', 'starting', 'failed'].includes(state)) return null
  return <aside className="stability-notice" role="status">
    {state === 'failed' ? '本地服务暂不可用，请重新打开 LawVerify。材料和草稿会保留。' : '正在恢复本地服务，草稿会保留。'}
  </aside>
}
