import { useEffect, useState } from 'react'
import { api } from './api'

export function AccountFeatures() {
  const [referral, setReferral] = useState<Awaited<ReturnType<typeof api.getReferralSummary>> | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  useEffect(() => {
    let live = true
    api.getReferralSummary().then(r => { if (live) setReferral(r) }).catch(() => { if (live) setNotice('邀请信息加载失败，请刷新重试。') })
    api.getAnalyticsPreference().then(r => { if (live) { setEnabled(r.enabled); setReady(true) } })
      .catch(() => { if (live) setNotice('隐私偏好暂不可用，请稍后重试。') })
    return () => { live = false }
  }, [])
  return <section className="card form-grid">
    <h3>邀请好友</h3>
    {referral ? <>
      <p>已邀请 {referral.invited} 人，已奖励 {referral.rewarded} 人，累计获得 {referral.earnedPoints} 积分。</p>
      <p>{referral.enabled ? `好友首次真实付款满 ${(referral.minPaymentFen / 100).toFixed(2)} 元，您获 ${referral.inviterPoints} 积分，好友获 ${referral.inviteePoints} 积分。` : '邀请奖励暂未开启。'}</p>
      <label>邀请链接<input readOnly value={referral.inviteUrl} /></label>
      <button className="primary-button" type="button" onClick={() => {
        void navigator.clipboard.writeText(referral.inviteUrl).then(() => setNotice('邀请链接已复制。')).catch(() => setNotice('复制失败，请选中链接后复制。'))
      }}>复制邀请链接</button>
    </> : null}
    <h3>隐私偏好</h3>
    <label><input type="checkbox" checked={enabled} disabled={!ready || busy} onChange={async e => {
      setBusy(true); setNotice('')
      try { const r = await api.setAnalyticsPreference(e.target.checked); setEnabled(r.enabled) }
      catch { setNotice('偏好保存失败，请重试。') }
      finally { setBusy(false) }
    }} />分享功能使用统计</label>
    <p className="muted">不包含案件名、正文或检索内容；关闭后删除已上传记录。</p>
    {notice ? <p role="status">{notice}</p> : null}
  </section>
}

const labels: Record<string, string> = { 'app.open': '打开应用', 'auth.login': '登录', 'document.import': '导入文书',
  'document.generate': '生成文书', 'evidence.link': '证据联动', 'legal.verify': '引用核验', 'case.search': '案例检索', 'payment.completed': '支付完成' }
export function ProductAnalytics() {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.getProductAnalytics>> | null>(null)
  const [error, setError] = useState('')
  useEffect(() => { api.getProductAnalytics().then(setData).catch(() => setError('功能统计加载失败。')) }, [])
  return <section className="card">
    <h3>近 30 天功能使用统计</h3>
    {error ? <p role="alert">{error}</p> : null}
    {data ? <table><thead><tr><th>功能</th><th>来源</th><th>次数</th><th>失败</th><th>平均耗时</th></tr></thead>
      <tbody>{data.items.map(i => <tr key={`${i.name}:${i.surface}`}><td>{labels[i.name] ?? i.name}</td><td>{i.surface === 'desktop' ? '客户端' : '官网'}</td><td>{i.count}</td><td>{i.failures}</td><td>{i.averageDurationMs} ms</td></tr>)}</tbody></table> : <p>加载中...</p>}
    {data?.items.length === 0 ? <p>暂无已授权的使用记录。</p> : null}
  </section>
}
