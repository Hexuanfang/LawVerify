import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { api } from '../api'
import { useApp } from './AppContext'
import { changeSessionPassword, saveSessionProfile } from './session'
import { Button } from './components/ui/button'
import { Input } from './components/ui/input'
import { Textarea } from './components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './components/ui/select'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './components/ui/dialog'
import './account-services.css'

type Referral = Awaited<ReturnType<typeof api.getReferralSummary>>
type Ledger = Awaited<ReturnType<typeof api.getCloudPointLedger>>['items']
type FeedbackType = Parameters<typeof api.submitCloudFeedback>[0]['feedbackType']
const feedbackTypes: { value: FeedbackType; label: string }[] = [
  { value: 'bug', label: '问题反馈' },
  { value: 'suggestion', label: '功能建议' },
  { value: 'experience', label: '体验反馈' },
  { value: 'other', label: '其他' },
]
const number = new Intl.NumberFormat('zh-CN')
const emptyPassword = { current: '', next: '', confirmation: '' }
function message(cause: unknown, fallback: string) {
  return cause instanceof Error && cause.message ? cause.message : fallback
}
function date(value: string) {
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString('zh-CN', { hour12: false })
}

export function AccountServices() {
  const { workspace } = useApp()
  if (!workspace) return null
  const identity = JSON.stringify([workspace.user.id, workspace.user.email,
    sessionStorage.getItem('lawverify-login-account'), sessionStorage.getItem('lawverify-auth-session'),
    localStorage.getItem('lawverify-cloud-token')])
  return <AccountServicesContent key={identity} />
}

function AccountServicesContent() {
  const app = useApp()
  const profile = app.cloudProfile
  const user = app.workspace!.user
  const email = user.email?.trim() ?? ''
  const displayName = profile?.user.name ?? user.name ?? ''
  const organization = profile?.organization.name ?? user.organization ?? ''
  const [session] = useState(() => ({
    account: sessionStorage.getItem('lawverify-login-account'),
    auth: sessionStorage.getItem('lawverify-auth-session'),
    token: localStorage.getItem('lawverify-cloud-token'),
  }))
  const live = useRef(true)
  const sequence = useRef(0)
  const submitting = useRef(false)
  const openingBilling = useRef(false)
  const [balance, setBalance] = useState<number | null>(null)
  const [ledger, setLedger] = useState<Ledger | null>(null)
  const [referral, setReferral] = useState<Referral | null>(null)
  const [loading, setLoading] = useState(true)
  const [syncError, setSyncError] = useState('')
  const [referralError, setReferralError] = useState('')
  const [actionError, setActionError] = useState('')
  const [updatedAt, setUpdatedAt] = useState('')
  const [ledgerOpen, setLedgerOpen] = useState(false)
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [feedbackType, setFeedbackType] = useState<FeedbackType>('bug')
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [contact, setContact] = useState(email)
  const [feedbackError, setFeedbackError] = useState('')
  const [sending, setSending] = useState(false)
  const [billingBusy, setBillingBusy] = useState(false)
  const [profileDraft, setProfileDraft] = useState<{ name?: string; organization?: string }>({})
  const [password, setPassword] = useState(emptyPassword)
  const [profileError, setProfileError] = useState('')
  const [passwordError, setPasswordError] = useState('')
  const [logoutOpen, setLogoutOpen] = useState(false)
  const [settingsBusy, setSettingsBusy] = useState(false)
  const savingSettings = useRef(false)
  const sameSession = useCallback(() => session.account === sessionStorage.getItem('lawverify-login-account')
    && session.auth === sessionStorage.getItem('lawverify-auth-session')
    && session.token === localStorage.getItem('lawverify-cloud-token'), [session])
  const isCurrent = useCallback(() => live.current && sameSession(), [sameSession])
  const canEditProfile = Boolean(profile && session.token?.trim())
  const canRenameOrganization = canEditProfile && profile?.organization.role === 'owner'
  const draftName = profileDraft.name ?? displayName
  const draftOrganization = profileDraft.organization ?? organization
  const organizationChanged = canRenameOrganization && draftOrganization.trim() !== organization.trim()
  const nameChanged = draftName.trim() !== displayName.trim()
  const canSaveProfile = (nameChanged || organizationChanged) && (!nameChanged || Boolean(draftName.trim()))

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!isCurrent() || !canEditProfile || !canSaveProfile || savingSettings.current) return
    if (organizationChanged && draftOrganization.trim().length < 2) {
      setProfileError('律所 / 单位名称至少 2 个字。')
      return
    }
    savingSettings.current = true
    setSettingsBusy(true)
    setProfileError('')
    try {
      const updated = await saveSessionProfile({
        displayName: nameChanged ? draftName.trim() : undefined,
        organizationName: organizationChanged ? draftOrganization.trim() : undefined,
      })
      if (!sameSession()) return
      app.setCloudProfile(updated)
      if (live.current) setProfileDraft({})
      app.toast('账号资料已保存。')
    } catch (cause) {
      if (isCurrent()) setProfileError(message(cause, '账号资料保存失败，请稍后重试。'))
    } finally {
      savingSettings.current = false
      if (isCurrent()) setSettingsBusy(false)
    }
  }

  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!isCurrent() || !session.token?.trim() || !password.current || !password.next || !password.confirmation || savingSettings.current) return
    setPasswordError('')
    if (password.next.length < 8) { setPasswordError('新密码至少 8 位。'); return }
    if (new TextEncoder().encode(password.next).length > 72) { setPasswordError('新密码长度超过 72 字节。'); return }
    if (password.next !== password.confirmation) { setPasswordError('两次输入的新密码不一致。'); return }
    if (password.next === password.current) { setPasswordError('新密码不能与当前密码相同。'); return }
    savingSettings.current = true
    setSettingsBusy(true)
    try {
      if (!await changeSessionPassword({ currentPassword: password.current, newPassword: password.next })) return
      if (live.current) setPassword(emptyPassword)
      app.toast('密码已修改。')
    } catch (cause) {
      if (isCurrent()) setPasswordError(message(cause, '密码修改失败，请稍后重试。'))
    } finally {
      savingSettings.current = false
      if (live.current) setSettingsBusy(false)
    }
  }

  const refresh = useCallback(async () => {
    if (!isCurrent()) return
    const request = ++sequence.current
    setLoading(true)
    // 余额和流水作为同一快照更新，失败时保留最近一次完整结果。
    const points = async () => {
      if (session.token?.trim()) {
        const [account, logs] = await Promise.all([api.getCloudAccountSummary(), api.getCloudPointLedger()])
        if (account.email?.trim().toLowerCase() !== email.toLowerCase())
          throw new Error('云端账号与当前工作区不一致，请重新登录。')
        return { account, ledger: logs }
      }
      if (!email) throw new Error('当前账号缺少邮箱，请重新登录后同步积分。')
      const result = await api.getCloudDesktopSync(email)
      if (result.account.email?.trim().toLowerCase() !== email.toLowerCase())
        throw new Error('云端账号与当前工作区不一致，请重新登录。')
      return result
    }
    const [pointsResult, inviteResult] = await Promise.allSettled([points(), api.getReferralSummary()])
    if (!isCurrent() || request !== sequence.current) return
    if (pointsResult.status === 'fulfilled') {
      setBalance(pointsResult.value.account.pointsBalance)
      setLedger(pointsResult.value.ledger.items)
      setUpdatedAt(new Date().toLocaleTimeString('zh-CN', { hour12: false }))
      setSyncError('')
    } else setSyncError(message(pointsResult.reason, '积分同步失败，请稍后重试。'))
    if (inviteResult.status === 'fulfilled') {
      setReferral(inviteResult.value)
      setReferralError('')
    } else setReferralError(message(inviteResult.reason, '邀请信息暂不可用，请稍后重试。'))
    setLoading(false)
  }, [email, isCurrent, session.token])

  useEffect(() => {
    live.current = true
    const initialRefresh = window.setTimeout(() => void refresh(), 0)
    const focus = () => { void refresh() }
    const visible = () => { if (document.visibilityState === 'visible') void refresh() }
    window.addEventListener('focus', focus)
    window.addEventListener('lawverify-points-changed', focus)
    document.addEventListener('visibilitychange', visible)
    return () => {
      live.current = false
      window.clearTimeout(initialRefresh)
      sequence.current += 1
      window.removeEventListener('focus', focus)
      window.removeEventListener('lawverify-points-changed', focus)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [refresh])

  async function recharge() {
    if (!isCurrent() || openingBilling.current) return
    setActionError('')
    if (!session.token?.trim()) {
      setActionError('当前桌面端尚未同步到账户中心登录态，请重新登录后再试。')
      return
    }
    openingBilling.current = true
    setBillingBusy(true)
    try {
      const host = window.location.hostname && !['localhost', '127.0.0.1'].includes(window.location.hostname)
        ? window.location.hostname : '127.0.0.1'
      const base = (import.meta.env.VITE_ACCOUNT_CENTER_URL?.trim()
        ?? (import.meta.env.DEV ? `http://${host}:4273` : 'https://lawverify.zhijing.fun')).replace(/\/$/, '')
      const url = new URL(`${base}/console/billing`)
      url.searchParams.set('desktopToken', session.token.trim())
      if (window.lawVerifyDesktop?.openExternal) await window.lawVerifyDesktop.openExternal(url.toString())
      else window.open(url.toString(), '_blank', 'noopener,noreferrer')
      if (isCurrent()) app.toast('已打开账户中心，完成充值后返回即可刷新积分。')
    } catch {
      // 不回显可能包含 desktopToken 的异常地址。
      if (isCurrent()) setActionError('无法打开账户中心，请稍后重试。')
    } finally {
      openingBilling.current = false
      if (isCurrent()) setBillingBusy(false)
    }
  }

  async function copy(value: string, label: string) {
    if (!isCurrent()) return
    setActionError('')
    try {
      await navigator.clipboard.writeText(value)
      if (isCurrent()) app.toast(`${label}已复制`)
    } catch {
      if (isCurrent()) setActionError('复制失败，请选中文字手动复制。')
    }
  }

  async function submitFeedback() {
    if (!isCurrent() || submitting.current) return
    setFeedbackError('')
    if (!title.trim()) { setFeedbackError('请先填写反馈标题。'); return }
    if (content.trim().length < 10) { setFeedbackError('请尽量详细描述问题或建议，至少填写 10 个字。'); return }
    if (!session.token?.trim()) {
      setFeedbackError('当前桌面端尚未同步到账户中心登录态，请重新登录后再试。')
      return
    }
    submitting.current = true
    setSending(true)
    try {
      await api.submitCloudFeedback({
        feedbackType, title: title.trim(), content: content.trim(), contact: contact.trim(),
        appVersion: __APP_VERSION__,
        clientPlatform: window.lawVerifyDesktop?.channel === 'electron'
          ? `electron / ${navigator.platform || 'unknown'}` : (navigator.userAgent || 'browser'),
        pageContext: 'lib', caseName: app.project?.name ?? '',
      })
      if (!isCurrent()) return
      setTitle('')
      setContent('')
      setContact(email)
      setFeedbackType('bug')
      setFeedbackOpen(false)
      app.toast('反馈已提交，我们会在管理员后台统一查看与跟进。')
    } catch (cause) {
      if (isCurrent()) setFeedbackError(message(cause, '反馈提交失败，请稍后重试。'))
    } finally {
      submitting.current = false
      if (isCurrent()) setSending(false)
    }
  }

  function ledgerTable(items: Ledger) {
    return <div className="account-services-table-wrap"><table className="account-services-table">
      <thead><tr><th scope="col">时间</th><th scope="col">项目</th><th scope="col">变动</th><th scope="col">余额</th></tr></thead>
      <tbody>{items.map(item => <tr key={item.id}>
        <td>{date(item.createdAt)}</td><td>{item.description || '积分变动'}</td>
        <td className={item.delta > 0 ? 'account-services-credit' : ''}>{item.delta > 0 ? '+' : ''}{number.format(item.delta)}</td>
        <td>{number.format(item.balanceAfter)}</td>
      </tr>)}</tbody>
    </table></div>
  }

  const services = <div className="account-services">
    <section className="account-services-card account-services-points" aria-labelledby="account-services-points-heading">
      <div className="account-services-heading"><h3 id="account-services-points-heading">积分与支付</h3>
        <Button variant="ghost" size="sm" disabled={loading} onClick={() => void refresh()}>{loading ? '同步中…' : '刷新'}</Button></div>
      <div className="account-services-balance"><strong>{balance === null ? '—' : number.format(balance)}</strong><span>云端可用积分</span></div>
      <div className="account-services-actions"><Button onClick={() => void recharge()} disabled={billingBusy}>{billingBusy ? '正在打开…' : '前往充值'}</Button>
        <Button variant="outline" disabled={ledger === null} onClick={() => setLedgerOpen(true)}>查看积分流水</Button></div>
      <p className="account-services-note">{updatedAt ? `最近同步 ${updatedAt}。` : loading ? '正在获取云端余额。' : '尚未成功同步云端余额。'} 在账户中心完成支付，返回后自动同步。</p>
      {syncError && <p className="account-services-error" role="alert">{syncError}{balance !== null ? ' 当前显示最近一次同步结果。' : ''}</p>}
      {ledger && ledger.length > 0 ? ledgerTable(ledger.slice(0, 5)) : ledger && <p className="account-services-note">暂无积分流水</p>}
    </section>
    <section className="account-services-card" aria-labelledby="account-services-referral-heading">
      <div className="account-services-heading"><h3 id="account-services-referral-heading">邀请好友</h3></div>
      <label className="account-services-field">邀请码<Input readOnly value={referral?.code ?? ''} placeholder={loading ? '加载中…' : '暂不可用'} /></label>
      <label className="account-services-field">邀请链接<Input readOnly value={referral?.inviteUrl ?? ''} placeholder={loading ? '加载中…' : '暂不可用'} /></label>
      <div className="account-services-actions"><Button variant="outline" disabled={!referral?.code} onClick={() => referral && void copy(referral.code, '邀请码')}>复制邀请码</Button>
        <Button variant="outline" disabled={!referral?.inviteUrl} onClick={() => referral && void copy(referral.inviteUrl, '邀请链接')}>复制邀请链接</Button></div>
      {referral && <p className="account-services-note">已邀请 {number.format(referral.invited)} 人 · 已获奖励 {number.format(referral.earnedPoints)} 积分</p>}
      {referralError && <p className="account-services-error" role="alert">{referralError}</p>}
    </section>
    <section className="account-services-card account-services-feedback">
      <div><h3>反馈与建议</h3><p className="account-services-note">描述遇到的问题或功能建议，我们会统一查看与跟进。</p></div>
      <Button variant="outline" onClick={() => setFeedbackOpen(true)}>提交反馈</Button>
    </section>
    {actionError && <p className="account-services-error account-services-wide" role="alert">{actionError}</p>}
    <Dialog open={ledgerOpen} onOpenChange={setLedgerOpen}>
      <DialogContent className="account-services-dialog account-services-ledger-dialog"><DialogHeader><DialogTitle>积分流水</DialogTitle>
        <DialogDescription>云端账户的充值、消耗与退款记录。{updatedAt && `最近同步 ${updatedAt}。`}</DialogDescription></DialogHeader>
        <Button variant="outline" disabled={loading} onClick={() => void refresh()}>{loading ? '同步中…' : '刷新流水'}</Button>
        {syncError && <p className="account-services-error" role="alert">{syncError}</p>}
        {ledger?.length ? ledgerTable(ledger) : <p className="account-services-note">暂无积分流水</p>}
      </DialogContent>
    </Dialog>
    <Dialog open={feedbackOpen} onOpenChange={setFeedbackOpen}>
      <DialogContent className="account-services-dialog"><DialogHeader><DialogTitle>提交反馈</DialogTitle>
        <DialogDescription>请填写标题，并用至少 10 个字描述问题或建议。</DialogDescription></DialogHeader>
        <form className="account-services-form" onSubmit={event => { event.preventDefault(); void submitFeedback() }}>
          <label className="account-services-field">反馈类型<Select value={feedbackType} disabled={sending} onValueChange={value => setFeedbackType(value as FeedbackType)}>
            <SelectTrigger aria-label="反馈类型"><SelectValue /></SelectTrigger><SelectContent>{feedbackTypes.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent>
          </Select></label>
          <label className="account-services-field">标题<Input value={title} onChange={event => setTitle(event.target.value)} disabled={sending} placeholder="简要描述问题或建议" /></label>
          <label className="account-services-field">详细描述<Textarea value={content} onChange={event => setContent(event.target.value)} disabled={sending} rows={6} placeholder="请描述操作步骤、实际表现或预期效果" /></label>
          <label className="account-services-field">联系方式（选填）<Input value={contact} onChange={event => setContact(event.target.value)} disabled={sending} placeholder="邮箱或其他联系方式" /></label>
          {feedbackError && <p className="account-services-error" role="alert">{feedbackError}</p>}
          <div className="account-services-actions account-services-form-actions"><Button type="button" variant="outline" onClick={() => setFeedbackOpen(false)}>关闭</Button>
            <Button type="submit" disabled={sending}>{sending ? '提交中…' : '提交反馈'}</Button></div>
        </form>
      </DialogContent>
    </Dialog>
  </div>

  return <div className="page active" id="pg-account">
    <header className="topbar account-settings-topbar">
      <Button variant="ghost" size="sm" aria-label="返回首页" onClick={() => app.setPage('home')}><span aria-hidden="true">←</span>返回首页</Button>
      <h1>账号设置</h1>
      <Button variant="ghost" size="sm" disabled={settingsBusy} onClick={() => setLogoutOpen(true)}>退出登录</Button>
    </header>
    <main className="account-settings-scroll">
      <div className="account-settings">
        <div className="account-settings-hero">
          <span className="avatar" aria-hidden="true">{displayName[0] || '律'}</span>
          <div className="account-settings-identity"><strong>{displayName || '律师'}</strong><span>{email || '未绑定邮箱'}</span></div>
          <div className="account-settings-credits"><span>可用积分</span><strong>{balance === null ? '—' : number.format(balance)}</strong></div>
        </div>
        <section className="account-settings-section" aria-labelledby="account-profile-heading">
          <h2 id="account-profile-heading">基本资料</h2>
          <form onSubmit={saveProfile}>
            <label className="account-settings-field"><span>显示名称</span>
              <input id="account-display-name" value={draftName} maxLength={24} readOnly={!canEditProfile || settingsBusy}
                onChange={event => setProfileDraft(current => ({ ...current, name: event.target.value }))} />
            </label>
            <label className="account-settings-field"><span>律所 / 单位</span>
              <input value={draftOrganization} placeholder="如：北京某某律师事务所" maxLength={48} readOnly={!canRenameOrganization || settingsBusy}
                onChange={event => setProfileDraft(current => ({ ...current, organization: event.target.value }))} />
            </label>
            {profileError && <p className="account-settings-error" role="alert">{profileError}</p>}
            <div className="account-settings-actions">
              <Button className="btn btn-pri btn-sm" type="submit" disabled={settingsBusy || !canEditProfile || !canSaveProfile}>保存资料</Button>
              {profile && !canRenameOrganization && <small>律所 / 单位名称由机构所有者修改。</small>}
              {!profile && <small>等待同步账号资料。</small>}
            </div>
          </form>
        </section>
        <section className="account-settings-section" aria-labelledby="account-email-heading">
          <h2 id="account-email-heading">登录邮箱</h2>
          <label className="account-settings-field"><span>邮箱</span>
            <span className="account-settings-email"><input id="account-login-email" readOnly value={email} aria-describedby="account-email-hint" /><small>不可修改</small></span>
          </label>
          <p id="account-email-hint">邮箱为登录凭证，如需变更请联系管理员。</p>
        </section>
        <section className="account-settings-section" aria-labelledby="account-password-heading">
          <h2 id="account-password-heading">修改密码</h2>
          <form onSubmit={changePassword}>
            <label className="account-settings-field"><span>当前密码</span>
              <input type="password" autoComplete="current-password" maxLength={1024} disabled={settingsBusy || !session.token}
                value={password.current} onChange={event => setPassword(current => ({ ...current, current: event.target.value }))} />
            </label>
            <label className="account-settings-field"><span>新密码</span>
              <input type="password" autoComplete="new-password" placeholder="至少 8 位" maxLength={72} disabled={settingsBusy || !session.token}
                value={password.next} onChange={event => setPassword(current => ({ ...current, next: event.target.value }))} />
            </label>
            <label className="account-settings-field"><span>确认新密码</span>
              <input type="password" autoComplete="new-password" maxLength={72} disabled={settingsBusy || !session.token}
                value={password.confirmation} onChange={event => setPassword(current => ({ ...current, confirmation: event.target.value }))} />
            </label>
            {passwordError && <p className="account-settings-error" role="alert">{passwordError}</p>}
            <div className="account-settings-actions"><Button className="btn btn-pri btn-sm" type="submit"
              disabled={settingsBusy || !session.token || !password.current || !password.next || !password.confirmation}>修改密码</Button></div>
          </form>
        </section>
        <details className="account-settings-services">
          <summary>积分与其他服务</summary>
          {services}
        </details>
      </div>
    </main>
    <Dialog open={logoutOpen} onOpenChange={setLogoutOpen}>
      <DialogContent className="fm-box new-form"><DialogHeader><DialogTitle>退出当前账号？</DialogTitle>
        <DialogDescription>本机案件和已保存草稿会保留，退出后需重新登录。</DialogDescription></DialogHeader>
        <div className="fm-ft"><Button className="btn btn-gh" onClick={() => setLogoutOpen(false)}>取消</Button>
          <Button className="btn btn-pri" disabled={app.busy || settingsBusy} onClick={app.logout}>确认退出</Button></div>
      </DialogContent>
    </Dialog>
  </div>
}


