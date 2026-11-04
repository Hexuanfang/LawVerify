import { useEffect, useState } from 'react'
import { api } from './api'

export function AccountFeatures() {
  const [referral, setReferral] = useState<Awaited<ReturnType<typeof api.getReferralSummary>> | null>(null)
  const [copied, setCopied] = useState(false)
  const [notice, setNotice] = useState('')
  useEffect(() => {
    let live = true
    api.getReferralSummary().then(r => { if (live) setReferral(r) }).catch(() => { if (live) setNotice('邀请信息加载失败，请刷新重试。') })
    return () => { live = false }
  }, [])
  return <section className="card form-grid account-invitation">
    <h3>邀请好友</h3>
    <div className="account-invitation-code">
      <span>邀请码</span>
      <strong>{referral?.code ?? '加载中...'}</strong>
    </div>
    <button className="primary-button" type="button" disabled={!referral} onClick={async () => {
      if (!referral) return
      setNotice('')
      try {
        await navigator.clipboard.writeText(referral.inviteUrl)
        setCopied(true)
      } catch {
        setCopied(false)
        setNotice('复制失败，请重试。')
      }
    }}>{copied ? '已复制' : '复制邀请链接'}</button>
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
