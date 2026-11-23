import { Fragment, useEffect, useRef, useState, type FormEvent } from 'react'

import { api, ApiError, type CocreateReviewFilter, type CocreateReviewItem, type CocreateReviewList, type CocreateWorkYears } from './api'
import { clearApplyIntent, readApplyIntent, track } from './site'
import './cocreate.css'

const workYearLabels: Record<CocreateWorkYears, string> = {
  under_3: '不足 3 年',
  '3_to_4': '3 至不足 5 年',
  '5_to_9': '5 至不足 10 年',
  '10_plus': '10 年及以上',
}

export function CocreatePage({ signedIn }: { signedIn: boolean }) {
  const [submitted, setSubmitted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const pendingRequest = useRef<{ id: string; fields: string } | null>(null)
  const sending = useRef(false)
  const successHeading = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    if (submitted) successHeading.current?.focus()
  }, [submitted])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (sending.current) return
    const formData = new FormData(event.currentTarget)
    const read = (name: string) => String(formData.get(name) ?? '').trim()
    const email = read('email').toLowerCase()
    const phone = read('phone').replace(/[\s()-]/g, '').replace(/^(?:\+?86|0086)/, '')
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError('请输入正确的邮箱地址。')
      event.currentTarget.querySelector<HTMLInputElement>('input[name="email"]')?.focus()
      return
    }
    if (!/^1[3-9][0-9]{9}$/.test(phone)) {
      setError('请输入有效的中国大陆手机号。')
      event.currentTarget.querySelector<HTMLInputElement>('input[name="phone"]')?.focus()
      return
    }
    const fields = {
      name: read('name'), email, phone, workYears: read('workYears') as CocreateWorkYears,
      region: read('region'), lawFirm: read('lawFirm'), practiceAreas: read('practiceAreas'),
      resume: read('resume'), expectations: read('expectations'),
    }
    const serialized = JSON.stringify(fields)
    sending.current = true
    setBusy(true)
    setError('')
    try {
      if (pendingRequest.current?.fields !== serialized) {
        pendingRequest.current = { id: crypto.randomUUID(), fields: serialized }
      }
      await api.submitCocreateApplication({ id: pendingRequest.current.id, ...fields })
      setSubmitted(true)
      if (readApplyIntent() === 'cocreate') clearApplyIntent()
      track('cocreate_apply_submit', 'cocreate')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '提交失败，请稍后重试。')
    } finally {
      sending.current = false
      setBusy(false)
    }
  }

  return (
    <section className="card stack cocreate-page" aria-labelledby="cocreate-page-title">
      <div className="cocreate-brand">
        <img src="/brand/lawverify-wordmark.svg" alt="LawVerify" width={146} height={42} />
        <span>律师共创计划</span>
      </div>
      <h1 id="cocreate-page-title" ref={successHeading} tabIndex={submitted ? -1 : undefined}>
        {submitted ? '报名已提交，等待审核' : '一起做出更懂律师的 AI'}
      </h1>
      {submitted ? (
        <div className="stack" role="status">
          <img className="cocreate-wechat-photo" src="/xiao-hetao.jpg" alt="LawVerify 的小核桃" width={144} height={144} />
          <h2>下一步，来和小核桃打个招呼</h2>
          <p>我们会审核你的报名。审核通过后即可参与共创。</p>
          <p>微信号 <strong>info_LawVerify</strong><br />好友验证请写「共创报名 + 你的姓名」。</p>
          <div className="hero-actions">
            <button className="primary-button" type="button" onClick={async () => {
              try { await navigator.clipboard.writeText('info_LawVerify'); setCopied(true) } catch { setCopied(false) }
            }}>{copied ? '已复制微信号' : '复制微信号'}</button>
            <a className="ghost-button" href="/">返回首页</a>
          </div>
        </div>
      ) : (
        <>
          <p><strong>招募 50 位执业律师，入选可享终身全功能 VIP。</strong> LawVerify 将文书里的事实逐句与本案证据对照，提示依据不足、支持不完整或前后矛盾的地方，方便你回到原件复核。无论是自己写的还是 AI 辅助生成的文书，最终判断都由律师作出。</p>
          <ul>
            <li><strong>试一试，直接提意见。</strong> 哪一步太绕、哪条提示不清楚、哪个功能该优先做，都欢迎告诉我们。需要举例时，请用虚构场景。</li>
            <li><strong>一起把反馈变成改进。</strong> 我们会在共创群同步进展。你也可以自愿参与官网署名、共创案例集和发布活动；公开署名前会征得你的同意。</li>
          </ul>
          <p>报名无需注册 LawVerify 账号。已有账号的律师，请填写注册时使用的邮箱或手机号。{!signedIn && <>你也可以<a href="/login?apply=cocreate">先登录</a>，提交时关联账号。</>}</p>
          <p className="muted">报名信息用于共创筛选和联系。请勿填写客户姓名、案号或上传案卷材料。</p>
          <p className="muted">本轮限 50 位，民商事诉讼律师优先。参与要求、VIP 权益范围及活动安排以共创协议为准。</p>
          <form className="cocreate-form" aria-busy={busy} onSubmit={submit}>
            <h2>填写共创申请</h2>
            <label className="cocreate-extra">姓名<input name="name" required maxLength={80} readOnly={busy} autoComplete="name" placeholder="请输入姓名" /></label>
            <label>邮箱<input name="email" type="email" required maxLength={254} readOnly={busy} autoComplete="email" placeholder="请输入邮箱" /></label>
            <label>手机号<input name="phone" type="tel" required maxLength={32} readOnly={busy} autoComplete="tel" placeholder="请输入中国大陆手机号" /></label>
            <label>工作年限<select name="workYears" required defaultValue="" disabled={busy}>
              <option value="">请选择</option>
              {Object.entries(workYearLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select></label>
            <label>所在地区<input name="region" required maxLength={120} readOnly={busy} placeholder="例如：浙江省杭州市" /></label>
            <label>所在律所<input name="lawFirm" required maxLength={160} readOnly={busy} autoComplete="organization" placeholder="请输入律所名称" /></label>
            <label>擅长领域<input name="practiceAreas" required maxLength={300} readOnly={busy} placeholder="例如：民商事诉讼、证据审查" /></label>
            <label className="cocreate-extra">简要履历<textarea name="resume" required maxLength={2000} readOnly={busy} rows={3} placeholder="简述执业经历及主要业务" /></label>
            <label className="cocreate-extra">共创期望<textarea name="expectations" required maxLength={2000} readOnly={busy} rows={3} placeholder="最想改善哪个办案环节？希望怎样参与共创？" /></label>
            {error && <div className="form-error" role="alert">{error}</div>}
            <div className="hero-actions">
              <button className="primary-button" type="submit" disabled={busy}>{busy ? '提交中…' : '提交申请'}</button>
              <a className="ghost-button" href="/">返回首页</a>
            </div>
          </form>
        </>
      )}
    </section>
  )
}

const reviewFilters = [
  ['all', '全部申请'], ['pending', '待审核'], ['approved', '已确认'],
] as const

const pointsFormatter = new Intl.NumberFormat('zh-CN')

function ApplicationDetails({ item }: { item: CocreateReviewItem }) {
  return (
    <dl className="cocreate-review-details" id={`cocreate-details-${item.id}`}>
      <div><dt>登录关联账号</dt><dd>{item.productAccount ?? '未关联'}</dd></div>
      <div><dt>工作年限</dt><dd>{workYearLabels[item.workYears]}</dd></div>
      <div><dt>擅长领域</dt><dd>{item.practiceAreas}</dd></div>
      <div><dt>简要履历</dt><dd>{item.resume}</dd></div>
      <div className="cocreate-review-expectations"><dt>共创期望</dt><dd>{item.expectations}</dd></div>
      {item.contact && <div className="cocreate-review-expectations"><dt>历史联系方式</dt><dd>{item.contact}</dd></div>}
    </dl>
  )
}

export function AdminCocreatePage() {
  const [data, setData] = useState<CocreateReviewList | null>(null)
  const [filter, setFilter] = useState<CocreateReviewFilter>('all')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [reload, setReload] = useState(0)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [granting, setGranting] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [actionError, setActionError] = useState('')
  const [notice, setNotice] = useState('')
  const [grantNotice, setGrantNotice] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setLoadError('')
    const timer = window.setTimeout(async () => {
      try {
        const result = await api.searchCocreateApplications({ query: search, status: filter, page }, controller.signal)
        if (!controller.signal.aborted) setData(result)
      } catch (cause) {
        if (!controller.signal.aborted) setLoadError(cause instanceof Error ? cause.message : '暂时无法读取共创报名。')
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }, search ? 220 : 0)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [filter, search, page, reload])

  async function approve(item: CocreateReviewItem) {
    if (!window.confirm(`确认通过「${item.name}」的报名？通过后，该申请人可参与共创。`)) return
    setConfirming(item.id)
    setActionError('')
    setNotice('')
    try {
      await api.approveCocreateApplication(item.id)
      setNotice(`已确认「${item.name}」的共创资格。`)
      setReload(value => value + 1)
      // 刷新完成前也隐藏已经通过的报名操作。
      setData(current => current && ({
        ...current,
        items: current.items.map(entry => entry.id === item.id ? { ...entry, status: 'approved' } : entry),
      }))
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : '审核失败，请稍后重试。')
    } finally {
      setConfirming(null)
    }
  }

  async function grantPoints(item: CocreateReviewItem) {
    const recipient = item.pointsRecipient
    if (!recipient) return
    const storageKey = `lawverify-cocreate-points:${item.id}`
    setActionError('')
    try {
      const savedGrant = sessionStorage.getItem(storageKey)
      const prompt = savedGrant
        ? `重试「${item.name}」上一笔 50,000 积分发放？`
        : `确认向「${item.name}」匹配的账号 ${recipient.account} 发放 50,000 积分？`
      if (!window.confirm(prompt)) return

      setGranting(item.id)
      setNotice('')
      setGrantNotice('')
      const grant = savedGrant ? JSON.parse(savedGrant) as { idempotencyKey: string; recipientUserId: string }
        : { idempotencyKey: crypto.randomUUID(), recipientUserId: recipient.userId }
      // 响应丢失或刷新页面后，仍可用同一个操作编号重试。
      sessionStorage.setItem(storageKey, JSON.stringify(grant))
      const result = await api.grantCocreatePoints(item.id, grant)
      sessionStorage.removeItem(storageKey)
      setData(current => current && ({
        ...current,
        items: current.items.map(entry => entry.id === item.id ? { ...entry, pointsGranted: result.pointsGranted } : entry),
      }))
      setGrantNotice(result.message)
      setReload(value => value + 1)
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === 'COCREATE_POINTS_RECIPIENT_CHANGED') {
        sessionStorage.removeItem(storageKey)
        setReload(value => value + 1)
      }
      setActionError(cause instanceof Error ? cause.message : '暂时无法发放积分，请稍后重试。')
    } finally {
      setGranting(null)
    }
  }

  const totalPages = data ? Math.max(1, Math.ceil(data.counts[filter] / data.pageSize)) : 1

  return (
    <div className="cocreate-review" aria-labelledby="cocreate-review-title">
      <header className="cocreate-review-hero">
        <h1 id="cocreate-review-title">共创审核</h1>
        <p>查看律师的报名资料，确认共创成员。</p>
      </header>
      <section className="card cocreate-review-card" aria-label="共创报名列表" aria-busy={loading}>
        <div className="cocreate-review-toolbar">
          <div className="cocreate-review-filters" role="group" aria-label="审核状态">
            {reviewFilters.map(([key, label]) => (
              <button key={key} type="button" aria-pressed={filter === key} onClick={() => { setFilter(key); setPage(1) }}>
                {label}{data && <span>{data.counts[key]}</span>}
              </button>
            ))}
          </div>
          <input type="search" aria-label="搜索报名资料" placeholder="搜索姓名、邮箱、手机号、地区或律所" maxLength={254} value={search}
            onChange={event => { setSearch(event.target.value); setPage(1) }} />
        </div>
        {loadError && <div className="cocreate-review-message" role="alert">
          <span>{loadError}</span> <button type="button" className="cocreate-review-text-button" onClick={() => setReload(value => value + 1)}>重试</button>
        </div>}
        {actionError && <p className="cocreate-review-message" role="alert">{actionError}</p>}
        {notice && <p className="cocreate-review-message is-success" role="status">{notice}</p>}
        {loading && <p className="cocreate-review-message" role="status">正在读取报名资料…</p>}
        {!loading && !loadError && data && (
          <>
            <div className="cocreate-review-table-scroll" role="region" aria-label="报名资料表格" tabIndex={0}>
              <table className="cocreate-review-table">
                <thead><tr>
                  <th scope="col">申请人 / 联系方式</th><th scope="col">律所 / 地区</th><th scope="col">已注册账号</th>
                  <th scope="col">共创律师</th><th scope="col">已发放积分</th><th scope="col">操作</th>
                </tr></thead>
                <tbody>
                  {data.items.map(item => {
                    const expanded = expandedId === item.id
                    const approved = item.status === 'approved'
                    return (
                      <Fragment key={item.id}>
                        <tr>
                          <td>
                            <strong>{item.name}</strong>
                            {item.email && <span className="cocreate-review-secondary">{item.email}</span>}
                            {item.phone && <span className="cocreate-review-secondary">{item.phone}</span>}
                            {!item.email && !item.phone && <span className="cocreate-review-secondary">{item.contact}</span>}
                          </td>
                          <td><strong>{item.lawFirm}</strong><span className="cocreate-review-secondary">{item.region}</span></td>
                          <td>{item.registered ? '是' : '否'}</td>
                          <td><span className={`cocreate-review-status${approved ? ' is-approved' : ''}`} title={approved ? '已确认' : '待审核'}>{approved ? '是' : '否'}</span></td>
                          <td>{pointsFormatter.format(BigInt(item.pointsGranted))}</td>
                          <td><div className="cocreate-review-actions">
                            <button type="button" className="cocreate-review-text-button" aria-expanded={expanded}
                              aria-controls={expanded ? `cocreate-details-${item.id}` : undefined}
                              onClick={() => setExpandedId(expanded ? null : item.id)}>{expanded ? '收起资料' : '查看资料'}</button>
                            {!approved && <button type="button" className="cocreate-review-text-button" disabled={confirming !== null || granting !== null}
                              onClick={() => void approve(item)}>{confirming === item.id ? '确认中…' : '确认共创'}</button>}
                            <button type="button" className="cocreate-review-text-button cocreate-review-grant"
                              title={item.pointsGrantBlockedReason ?? undefined} disabled={!item.canGrantPoints || confirming !== null || granting !== null}
                              onClick={() => void grantPoints(item)}>{granting === item.id ? '发放中…' : '积分发放'}</button>
                          </div></td>
                        </tr>
                        {expanded && <tr className="cocreate-review-detail-row"><td colSpan={6}><ApplicationDetails item={item} /></td></tr>}
                      </Fragment>
                    )
                  })}
                  {data.items.length === 0 && <tr><td colSpan={6}>暂无符合条件的报名。</td></tr>}
                </tbody>
              </table>
            </div>
            {totalPages > 1 && <div className="cocreate-review-pagination" aria-label="分页">
              <button className="ghost-button" type="button" disabled={data.page <= 1} onClick={() => setPage(data.page - 1)}>上一页</button>
              <span>{data.page} / {totalPages}</span>
              <button className="ghost-button" type="button" disabled={data.page >= totalPages} onClick={() => setPage(data.page + 1)}>下一页</button>
            </div>}
          </>
        )}
      </section>
      <div className={`cocreate-review-grant-notice${grantNotice ? ' is-visible' : ''}`}>
        <div role="status" aria-atomic="true">{grantNotice}</div>
        {grantNotice && <button type="button" className="cocreate-review-text-button" aria-label="关闭积分发放提示"
          onClick={() => setGrantNotice('')}>关闭</button>}
      </div>
    </div>
  )
}
