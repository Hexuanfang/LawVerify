import { useEffect, useState } from 'react'
import { api } from './api'

export function AccountFeatures() {
  const [referral, setReferral] = useState<Awaited<ReturnType<typeof api.getReferralSummary>> | null>(null)
  const [copied, setCopied] = useState(false)
  const [notice, setNotice] = useState('')
  useEffect(() => {
    let live = true
    api.getReferralSummary().then(r => { if (live) setReferral(r) }).catch(() => { if (live) setNotice('邀请信息暂不可用。') })
    return () => { live = false }
  }, [])
  return <div className="account-invitation">
    <div className="account-invitation-code">
      <span>邀请码</span>
      <strong>{referral?.code ?? '加载中...'}</strong>
    </div>
    <button className="ghost-button" type="button" disabled={!referral} onClick={async () => {
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
  </div>
}
