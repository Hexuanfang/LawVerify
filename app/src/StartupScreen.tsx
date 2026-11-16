import './startup-screen.css'

export function StartupScreen() {
  return <div className="startup-screen" role="status" aria-live="polite" aria-busy="true">
    <div className="startup-screen-content">
      <img src="/lawverify-icon.svg" alt="" width="40" height="40" />
      <strong>LawVerify</strong>
      <span className="startup-screen-spinner" aria-hidden="true" />
      <p>正在启动 LawVerify…</p>
    </div>
  </div>
}
