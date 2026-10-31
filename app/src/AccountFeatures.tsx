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
    api.getReferralSummary().then(r => { if (live) setReferral(r) }).catch(() => { if (live) setNotice('邀请信息暂不可用。') })
    api.getAnalyticsPreference().then(r => { if (live) { setEnabled(r.enabled); setReady(true) } })
      .catch(() => { if (live) setNotice('隐私偏好暂不可用，请稍后重试。') })
    return () => { live = false }
  }, [])
  return <div className="legal-search-controls">
    <details>
      <summary>邀请好友</summary>
      {referral ? <>
        <p>已邀请 {referral.invited} 人 · 已获 {referral.earnedPoints} 积分</p>
        <p>{referral.enabled ? `好友首次真实付款满 ${(referral.minPaymentFen / 100).toFixed(2)} 元，您获 ${referral.inviterPoints} 积分，好友获 ${referral.inviteePoints} 积分。` : '邀请奖励暂未开启。'}</p>
        <button className="ghost-button" type="button" onClick={() => {
          void navigator.clipboard.writeText(referral.inviteUrl).then(() => setNotice('邀请链接已复制。')).catch(() => setNotice('复制失败，请在账户中心查看邀请链接。'))
        }}>复制邀请链接</button>
      </> : null}
    </details>
    <label><input type="checkbox" checked={enabled} disabled={!ready || busy} onChange={async e => {
      const value = e.target.checked
      setBusy(true); setNotice('')
      try { const r = await api.setAnalyticsPreference(value); setEnabled(r.enabled) }
      catch { setNotice('偏好保存失败，请重试。') }
      finally { setBusy(false) }
    }} />分享功能使用统计</label>
    <small>不包含案件名、正文及检索内容。关闭后删除已上传记录。</small>
    {notice ? <p role="status">{notice}</p> : null}
  </div>
}
