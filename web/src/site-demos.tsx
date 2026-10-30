// 官网的示意组件：全部用 HTML/CSS 实现，示例内容来自《官网改版方案》第 4.2、4.4 节的虚构案件。
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'

import { copyText, getDownloadPageUrl, isMobileDevice, track } from './site'

/* ---------------- 核验状态 ---------------- */

export type VerifyStatus = 'support' | 'partial' | 'insufficient' | 'conflict'

export const verifyStatusMeta: Record<VerifyStatus, { label: string; icon: string; description: string }> = {
  support: { label: '支持', icon: '✓', description: '证据原件中找到了对应的原文。' },
  partial: { label: '部分支持', icon: '◐', description: '原件只能支持其中一部分，其余部分没有找到依据。' },
  insufficient: { label: '证据不足', icon: '!', description: '没有找到足以支持这句话的原文。' },
  conflict: { label: '矛盾', icon: '✕', description: '原件记载与这句话不一致。' },
}

export function StatusBadge({ status, compact = false }: { status: VerifyStatus; compact?: boolean }) {
  const meta = verifyStatusMeta[status]
  return (
    <span className={`verify-badge verify-badge-${status}${compact ? ' verify-badge-compact' : ''}`}>
      <span className="verify-badge-icon" aria-hidden="true">{meta.icon}</span>
      {meta.label}
    </span>
  )
}

export function SampleTag() {
  return <span className="sample-tag">示例案件 · 虚构内容</span>
}

/* ---------------- 逐句核验演示 ---------------- */

interface DemoSentence {
  text: string
  status: VerifyStatus
  evidence: string
  page: string
  quote: string
  note: string
}

const demoSentences: DemoSentence[] = [
  {
    text: '原告与被告于 2025 年 3 月 1 日签订《设备买卖合同》，约定货款总额 48 万元。',
    status: 'support',
    evidence: '证据 1《设备买卖合同》',
    page: '第 1 页',
    quote: '合同总价款为人民币肆拾捌万元整（¥480,000）',
    note: '合同记载的总价款与文书一致。',
  },
  {
    text: '原告已于 2025 年 4 月 10 日完成全部设备交付，被告当场验收合格。',
    status: 'insufficient',
    evidence: '证据 2《送货单》',
    page: '第 1 页',
    quote: '收货人：王某，2025.4.10',
    note: '仅有签收记录，未见“验收合格”的记载。',
  },
  {
    text: '被告至今未支付任何货款。',
    status: 'conflict',
    evidence: '证据 4《银行转账回单》',
    page: '第 1 页',
    quote: '2025-05-06 转账 100,000.00 元，附言：设备首款',
    note: '转账回单显示被告已支付 10 万元首款。',
  },
]

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(() => {
    try {
      return window.matchMedia('(prefers-reduced-motion: reduce)').matches
    } catch {
      return false
    }
  })
  useEffect(() => {
    try {
      const query = window.matchMedia('(prefers-reduced-motion: reduce)')
      const onChange = () => setReduced(query.matches)
      query.addEventListener('change', onChange)
      return () => query.removeEventListener('change', onChange)
    } catch {
      return undefined
    }
  }, [])
  return reduced
}

/**
 * 逐句核验示意：左侧文书，右侧证据原件。
 * - variant="full"：可点击，用于首页和产品页的演示区块；
 * - variant="mini"：首屏右侧的缩略版，只自动播放。
 * 自动播放：句子依次高亮；用户点过之后停止；开启“减少动态效果”时为静态。
 */
export function VerifyDemo({ variant = 'full' }: { variant?: 'full' | 'mini' }) {
  const [active, setActive] = useState(0)
  const [userControlled, setUserControlled] = useState(false)
  const [paused, setPaused] = useState(false)
  const [visible, setVisible] = useState(true)
  const reducedMotion = usePrefersReducedMotion()
  const rootRef = useRef<HTMLDivElement>(null)
  const isMini = variant === 'mini'

  // 只在演示区块出现在屏幕内时播放。
  useEffect(() => {
    const node = rootRef.current
    if (!node || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { threshold: 0.25 })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (reducedMotion || userControlled || paused || !visible) return
    const timer = window.setTimeout(() => setActive((index) => (index + 1) % demoSentences.length), isMini ? 2600 : 3200)
    return () => window.clearTimeout(timer)
  }, [active, reducedMotion, userControlled, paused, visible, isMini])

  const current = demoSentences[active]

  return (
    <div
      ref={rootRef}
      className={`verify-demo verify-demo-${variant}`}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setPaused(false)
      }}
    >
      <div className="demo-window-bar" aria-hidden={isMini}>
        <span className="demo-window-dots" aria-hidden="true"><i /><i /><i /></span>
        <span className="demo-window-title">质证意见（节选）</span>
        <SampleTag />
      </div>
      <div className="verify-demo-body">
        <div className="verify-demo-doc" aria-label="示例文书：质证意见（节选）">
          <p className="verify-doc-heading">质证意见（节选）</p>
          <ol className="verify-sentence-list">
            {demoSentences.map((sentence, index) => {
              const isActive = index === active
              const content = (
                <>
                  <span className="verify-sentence-text">{sentence.text}</span>
                  <StatusBadge status={sentence.status} compact={isMini} />
                </>
              )
              return (
                <li key={sentence.text} className={`verify-sentence verify-sentence-${sentence.status}${isActive ? ' is-active' : ''}`}>
                  {isMini ? (
                    <div className="verify-sentence-button" aria-current={isActive ? 'true' : undefined}>{content}</div>
                  ) : (
                    <button
                      type="button"
                      className="verify-sentence-button"
                      aria-pressed={isActive}
                      onClick={() => {
                        setActive(index)
                        setUserControlled(true)
                        track('demo_sentence_click', String(index + 1))
                      }}
                    >
                      {content}
                    </button>
                  )}
                </li>
              )
            })}
          </ol>
          {!isMini ? <p className="verify-doc-hint">点击任意一句，右侧打开对应的证据原件。</p> : null}
        </div>
        <div className={`verify-demo-evidence verify-evidence-${current.status}`} aria-live={isMini ? 'off' : 'polite'}>
          <div className="evidence-head">
            <span className="evidence-label">证据原件</span>
            <strong>{current.evidence}</strong>
            <span className="evidence-page">{current.page}</span>
          </div>
          <div className="evidence-paper" aria-hidden={false}>
            <span className="paper-line" style={{ width: '82%' }} aria-hidden="true" />
            <span className="paper-line" style={{ width: '64%' }} aria-hidden="true" />
            <mark className="evidence-quote" key={active}>“{current.quote}”</mark>
            <span className="paper-line" style={{ width: '76%' }} aria-hidden="true" />
            <span className="paper-line" style={{ width: '48%' }} aria-hidden="true" />
          </div>
          <div className="evidence-verdict">
            <StatusBadge status={current.status} />
            <span>{current.note}</span>
          </div>
        </div>
      </div>
      {!isMini ? (
        <p className="verify-demo-footnote">AI 摘录的原文必须真实存在于证据原件中，否则不予关联。</p>
      ) : null}
    </div>
  )
}

/* ---------------- 缩略核验面板（用于“已有文书也能核”示意） ---------------- */

export function VerifyMiniPanel() {
  return (
    <div className="verify-mini-panel" aria-label="逐句核验结果示意">
      {demoSentences.map((sentence, index) => (
        <div key={sentence.text} className={`verify-mini-row verify-sentence-${sentence.status}`}>
          <span className="verify-mini-index">{index + 1}</span>
          <span className="verify-mini-line" aria-hidden="true" />
          <StatusBadge status={sentence.status} compact />
        </div>
      ))}
    </div>
  )
}

export function ImportDiagram() {
  return (
    <div className="import-diagram" role="img" aria-label="导入 Word 文书后，逐句对照本案证据，标出核验结果">
      <div className="import-file">
        <span className="import-file-icon" aria-hidden="true">W</span>
        <strong>代理词.docx</strong>
        <span>自己写的 · 助理写的 · 其他 AI 写的</span>
      </div>
      <span className="import-arrow" aria-hidden="true">
        <svg viewBox="0 0 48 16" width="48" height="16"><path d="M0 8h42M36 2l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2" /></svg>
      </span>
      <div className="import-result">
        <span className="import-result-title">和本案证据逐句对照</span>
        <VerifyMiniPanel />
      </div>
    </div>
  )
}

/* ---------------- 案件作战图 ---------------- */

const positionFacts = [
  { label: '代理方', value: '原告（卖方）' },
  { label: '诉求', value: '支付剩余货款 38 万元及逾期付款违约金' },
  { label: '认可事实', value: '已收到 10 万元首款' },
  { label: '争议事实', value: '设备是否验收合格' },
]

const strategyColumns: Array<{ key: string; label: string; value: string; tone?: 'risk' | 'opponent' }> = [
  { key: 'claim', label: '主张', value: '被告应支付剩余货款 38 万元' },
  { key: 'elements', label: '成立要件', value: '合同有效；我方已交付；被告未足额付款' },
  { key: 'burden', label: '举证责任', value: '我方证明交付事实；被告证明已付款或质量异议' },
  { key: 'favorable', label: '有利证据', value: '证据 1 买卖合同、证据 2 送货单' },
  { key: 'unfavorable', label: '不利证据', value: '证据 4 转账回单（已付 10 万元，诉请金额需扣减）', tone: 'risk' },
  { key: 'gaps', label: '补证缺口', value: '验收合格的书面记录；催款记录' },
  { key: 'rebuttal', label: '对方可能反驳', value: '设备存在质量问题，未验收合格', tone: 'opponent' },
  { key: 'response', label: '我方应对', value: '补充使用记录，主张已实际使用视为验收' },
]

export function StrategyBoard() {
  return (
    <div className="strategy-board">
      <div className="strategy-position">
        <div className="strategy-position-head">
          <span className="strategy-step">第一步</span>
          <strong>确认代理立场</strong>
          <SampleTag />
        </div>
        <dl className="strategy-position-grid">
          {positionFacts.map((item) => (
            <div key={item.label}>
              <dt>{item.label}</dt>
              <dd>{item.value}</dd>
            </div>
          ))}
        </dl>
      </div>
      <div className="strategy-table-wrap">
        <div className="strategy-position-head">
          <span className="strategy-step">第二步</span>
          <strong>生成办案策略</strong>
        </div>
        <table className="strategy-table">
          <caption className="visually-hidden">案件作战图示例</caption>
          <thead>
            <tr>
              {strategyColumns.map((column) => (
                <th key={column.key} scope="col" className={column.tone ? `strategy-tone-${column.tone}` : undefined}>
                  {column.tone === 'risk' ? <span aria-hidden="true">⚠ </span> : null}
                  {column.tone === 'opponent' ? <span aria-hidden="true">⇄ </span> : null}
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              {strategyColumns.map((column) => (
                <td key={column.key} data-label={column.label} className={column.tone ? `strategy-tone-${column.tone}` : undefined}>
                  {column.value}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}

/* ---------------- 与通用 AI 写作的区别 ---------------- */

const compareRows = [
  { label: '站在哪边', generic: '默认中立', ours: '先确认代理立场' },
  { label: '事实依据', generic: '根据你的描述来写', ours: '每句都能点回证据原件' },
  { label: '出了错', generic: '你得自己逐句去查', ours: '支持、矛盾、证据不足，逐句标出' },
  { label: '法条', generic: '可能引用旧法', ours: '可查看国家法律法规数据库的官方原文' },
]

export function CompareTable() {
  return (
    <div className="compare-wrap">
      <table className="compare-table">
        <caption className="visually-hidden">通用 AI 写作与 LawVerify 的区别</caption>
        <thead>
          <tr>
            <th scope="col"><span className="visually-hidden">对比项</span></th>
            <th scope="col">通用 AI 写作</th>
            <th scope="col" className="compare-ours">LawVerify</th>
          </tr>
        </thead>
        <tbody>
          {compareRows.map((row) => (
            <tr key={row.label}>
              <th scope="row">{row.label}</th>
              <td data-label="通用 AI 写作">{row.generic}</td>
              <td data-label="LawVerify" className="compare-ours">{row.ours}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/* ---------------- 4 步工作流 ---------------- */

export const workflowSteps = [
  { title: '链接材料，理解原件', detail: '同一案件可链接多个本地文件夹，增量导入；提取证明目的、关键事实与证明局限。' },
  { title: '确认代理立场', detail: '说明代理方与办案目标，梳理主张、成立要件与举证思路。' },
  { title: '撰写或导入文书', detail: '接近 Word 的连续文稿，边生成边审阅；已写好的文书也能导入。' },
  { title: '逐句核验，导出 Word', detail: '核对每句陈述的证据、法条与案例，再导出 Word 继续打磨。' },
]

export function WorkflowSteps() {
  return (
    <ol className="workflow-steps">
      {workflowSteps.map((step, index) => (
        <li key={step.title}>
          <span className="workflow-index">{index + 1}</span>
          <strong>{step.title}</strong>
          <span>{step.detail}</span>
        </li>
      ))}
    </ol>
  )
}

/* ---------------- 下载按钮 / 复制下载页链接 ---------------- */

export function CopyDownloadLinkButton({ className = 'ghost-button', source = '' }: { className?: string; source?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  return (
    <button
      type="button"
      className={className}
      onClick={async () => {
        const ok = await copyText(getDownloadPageUrl())
        setState(ok ? 'copied' : 'failed')
        track('copy_download_link', source)
        window.setTimeout(() => setState('idle'), 2400)
      }}
    >
      {state === 'copied' ? '已复制，在电脑上打开' : state === 'failed' ? `复制失败：${getDownloadPageUrl()}` : '复制下载页链接'}
    </button>
  )
}

// 电脑访客：按系统显示“下载 Windows / Mac 客户端”，进入下载页；手机访客：改成“复制下载页链接”。
export function DownloadEntryButton({ className = 'ghost-button', source = '' }: { className?: string; source?: string }) {
  return (
    <a className={className} href="/download" onClick={() => track('hero_cta_click', `download:${source}`)}>
      下载客户端
    </a>
  )
}

export function useIsMobileDevice() {
  const [mobile] = useState(() => isMobileDevice())
  return mobile
}

/* ---------------- 区块标题 ---------------- */

export function SectionTitle({ kicker, title, children }: { kicker?: string; title: string; children?: ReactNode }) {
  return (
    <header className="section-title">
      {kicker ? <span className="section-kicker">{kicker}</span> : null}
      <h2>{title}</h2>
      {children ? <p>{children}</p> : null}
    </header>
  )
}

/* ---------------- 首屏：文书 + 页边批注 ---------------- */

// 每句话右侧对齐一条批注，像在文书里看批注。纯 CSS 动效：下划线和批注按句依次出现；减少动态效果时直接显示完成状态。
const heroNotes: Array<{ before: string; mark: string; after: string; tone: 'support' | 'warn' | 'conflict'; icon: string; label: string; detail: string }> = [
  { before: '原告与被告于 2025 年 3 月 1 日', mark: '签订《设备买卖合同》', after: '，约定货款总额 48 万元。', tone: 'support', icon: '✓', label: '支持', detail: '证据 1 合同 · 第 1 页' },
  { before: '原告已于 2025 年 4 月 10 日完成全部设备交付，被告', mark: '当场验收合格', after: '。', tone: 'warn', icon: '!', label: '证据不足', detail: '送货单仅有签收，未见验收记录' },
  { before: '被告至今', mark: '未支付任何货款', after: '。', tone: 'conflict', icon: '✕', label: '矛盾', detail: '转账回单：已付首款 10 万元' },
  { before: '依据', mark: '《合同法》第一百五十九条', after: '，被告应当按照约定的数额支付价款。', tone: 'conflict', icon: '✕', label: '法条已废止', detail: '现行：《民法典》第六百二十六条' },
  { before: '类案', mark: '（2024）京01XX民初XXXX号', after: '判决亦持相同观点。', tone: 'warn', icon: '!', label: '案号未能核实', detail: '法院官网未查到该案号，不代表案号有误' },
]

export function HeroProductPreview() {
  return (
    <div className="hero-doc hero-win" aria-label="产品示意：一份质证意见被逐句核验，右侧是核验结果（示例案件，虚构内容）">
      <div className="hw-bar" aria-hidden="true">
        <span className="hw-dots"><i /><i /><i /></span>
        <span className="hw-title">质证意见（节选）.docx</span>
        <span className="hw-status">5 份材料 · 1,281 页</span>
      </div>
      <div className="hd-grid">
        <p className="hd-title">质证意见（节选）</p>
        <span className="hd-title-gap hw-side-head">本案证据核验 · 3 处</span>
        {heroNotes.map((note, index) => (
          <Fragment key={index}>
          {index === 3 ? (
            <>
              <span className="hd-line hd-gap" aria-hidden="true" />
              <span className="hw-side-head hw-side-head-2">法条与案例核验 · 2 处</span>
            </>
          ) : null}
          <div className="hd-row" key={index} style={{ ['--i' as string]: index }}>
            <p className={`hd-line hd-line-${note.tone}`}>{note.before}<span className="hd-mark">{note.mark}</span>{note.after}</p>
            <div className={`hd-note hd-note-${note.tone}`}>
              <i aria-hidden="true">{note.icon}</i>
              <span><b>{note.label}</b><em>{note.detail}</em></span>
            </div>
          </div>
          </Fragment>
        ))}
        <span className="hd-sample">示例案件 · 虚构内容</span>
      </div>
    </div>
  )
}

/* ---------------- 法条与案例核验（首页区块） ---------------- */

export function LegalCheckShowcase() {
  return (
    <div className="legal-showcase">
      <article className="legal-card">
        <span className="legal-card-kicker">法条核验</span>
        <p className="legal-card-cite"><s>《合同法》第一百五十九条</s></p>
        <span className="verify-badge verify-badge-conflict"><span className="verify-badge-icon" aria-hidden="true">✕</span>已废止</span>
        <p className="legal-card-body">已于 2021 年随《民法典》施行废止。现行对应：<b>《民法典》第六百二十六条</b>，可查看官方原文。</p>
        <span className="legal-card-foot">已废止、已修订的条文在正文里直接标红提示</span>
      </article>
      <article className="legal-card">
        <span className="legal-card-kicker">案号核验</span>
        <p className="legal-card-cite">（2024）京01XX民初XXXX号</p>
        <span className="verify-badge verify-badge-insufficient"><span className="verify-badge-icon" aria-hidden="true">!</span>未能核实</span>
        <p className="legal-card-body">在法院官网正文中没有找到这个案号。只有官方正文里能对上，才显示为已核实。</p>
        <span className="legal-card-foot">查询失败或需要登录时，也如实显示“未能核实”</span>
      </article>
      <p className="legal-showcase-note"><SampleTag /> 法条与案号仅作演示，引用前仍需律师最终核对。</p>
    </div>
  )
}

/* ======================================================================
   首页 v6：滚动故事（三大能力）、案件助手进度画面、工作流时间线
   ====================================================================== */

function useInView<T extends Element>(threshold = 0.2) {
  const ref = useRef<T>(null)
  const [inView, setInView] = useState(false)
  useEffect(() => {
    const node = ref.current
    if (!node) return
    if (typeof IntersectionObserver === 'undefined') {
      setInView(true)
      return
    }
    const observer = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting), { threshold })
    observer.observe(node)
    return () => observer.disconnect()
  }, [threshold])
  return [ref, inView] as const
}

/* ---------- 场景 1：超大文件材料处理 ---------- */

const storyFiles = [
  { name: '往来邮件与催款记录.pdf', meta: '1,248 页 · 86 MB' },
  { name: '证据4 银行转账回单.pdf', meta: '2 页 · 0.9 MB' },
  { name: '证据2 送货单.jpg', meta: '1 页 · 2.1 MB' },
  { name: '证据1 设备买卖合同.pdf', meta: '18 页 · 6.2 MB' },
  { name: '起诉状.docx', meta: '12 页 · 0.4 MB' },
]

function SceneMaterials({ active }: { active: boolean }) {
  return (
    <div className={`scene scene-materials${active ? ' is-active' : ''}`}>
      <div className="sm-photo" style={{ backgroundImage: 'url(/media/files-binder.jpg)' }} aria-hidden="true" />
      <div className="sm-stack-wrap">
        <div className="sm-stack">
          {storyFiles.map((file, index) => (
            <div className="sm-sheet" key={file.name} style={{ ['--i' as string]: index }}>
              <b>{file.name}</b>
              <span>{file.meta}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="sm-chips">
        <span>5 份材料 · 2 个文件夹</span>
        <span>单份最大 100MB</span>
        <span>增量导入 · 分批处理</span>
        <span>Word、PDF、图片、文本</span>
      </div>
    </div>
  )
}

/* ---------- 核验章（代替连线/进度条表示结论） ---------- */

export function Stamp({ tone, children, className = '' }: { tone: 'ok' | 'bad' | 'warn'; children: ReactNode; className?: string }) {
  return <span className={`stamp stamp-${tone} ${className}`.trim()}>{children}</span>
}

/* ---------- 场景 2：语义级证据核验（同色高亮表示对应关系） ---------- */

function SceneEvidence({ active }: { active: boolean }) {
  return (
    <div className={`scene scene-evidence${active ? ' is-active' : ''}`}>
      <div className="sm-photo" style={{ backgroundImage: 'url(/media/bg-glass.jpg)' }} aria-hidden="true" />
      <div className="se-desk">
        <div className="se-paper se-doc">
          <span className="se-paper-label">答辩状 · 第 2 句</span>
          <p>被告已于 2025 年 5 月 6 日向原告<mark className="se-hl">付清全部货款</mark>，不存在欠款。</p>
        </div>
        <div className="se-paper se-receipt">
          <span className="se-paper-label">证据 4 · 银行转账回单</span>
          <dl>
            <div><dt>交易日期</dt><dd>2025-05-06</dd></div>
            <div><dt>付款方</dt><dd>被告</dd></div>
            <div><dt>金额</dt><dd><mark className="se-hl">100,000.00 元</mark></dd></div>
            <div><dt>附言</dt><dd><mark className="se-hl">设备首款</mark></dd></div>
          </dl>
        </div>
      </div>
      <p className="se-search">
        <span className="se-kw">回单里搜「货款」<b>未命中</b></span>
        <span className="se-sem">语义比对<b>命中</b></span>
      </p>
      <div className="se-verdict">
        <Stamp tone="ok">部分支持</Stamp>
        <span>回单能证明被告付款 10 万元，不能证明 48 万元货款已全部付清</span>
      </div>
    </div>
  )
}

/* ---------- 场景 3：案例法条核验（逐条盖章） ---------- */

const storyCitations = [
  { cite: '《民法典》第五百七十七条', source: '国家法律法规数据库', tone: 'ok' as const, result: '现行有效', note: '' },
  { cite: '《合同法》第一百五十九条', source: '国家法律法规数据库', tone: 'bad' as const, result: '已废止', note: '现行对应：《民法典》第六百二十六条' },
  { cite: '（2024）京01XX民初XXXX号', source: '法院官方页面', tone: 'warn' as const, result: '未能核实', note: '官方正文中未找到该案号' },
]

function SceneCitations({ active }: { active: boolean }) {
  return (
    <div className={`scene scene-citations${active ? ' is-active' : ''}`}>
      <div className="sm-photo" style={{ backgroundImage: 'url(/media/bg-gavel.jpg)' }} aria-hidden="true" />
      <span className="sc-head">文书中识别到 3 处引用</span>
      {storyCitations.map((item, index) => (
        <div className={`sc-row sc-${item.tone}`} key={item.cite} style={{ ['--i' as string]: index }}>
          <div className="sc-text">
            <span className="sc-cite">{item.cite}</span>
            <span className="sc-source">核对来源：{item.source}</span>
            {item.note ? <span className="sc-note">{item.note}</span> : null}
          </div>
          <Stamp tone={item.tone} className="sc-stamp">{item.result}</Stamp>
        </div>
      ))}
    </div>
  )
}

const storyChapters = [
  {
    kicker: '超大文件材料处理',
    title: '上千页的案卷，直接导入。',
    body: '同一案件可链接多个本地文件夹，增量导入材料，保留原件并支持大文件分批处理。支持 Word、PDF、图片与文本，单份材料最大 100MB；暂不支持录音、视频。',
    points: ['多目录材料增量导入', '保留原件，分批处理', '材料变更后可重新梳理'],
  },
  {
    kicker: '语义级证据核验',
    title: '这句话由什么材料支持？',
    body: '不仅找出相关材料，还核对这份材料能证明到哪一步。结合全案背景与段落语义召回候选证据，再判断它与当前陈述的适配关系。',
    points: ['证据关联锚定到具体句子', '支持、部分支持、矛盾、证据不足逐句标出', 'AI 摘录的引文必须真实出现在原件里'],
  },
  {
    kicker: '案例法条核验',
    title: '让论证依据回到可核对的来源。',
    body: '文书中的法条自动识别并核对官方法源，已废止、已修订的条文直接标红提示；引用的案号回到法院官方页面核对，只有官方正文能对上才显示已核实。',
    points: ['法条可查看官方原文', '废止、修订版本给出风险提示', '查不到的案号如实提示“未能核实”'],
  },
]

const storyScenes = [SceneMaterials, SceneEvidence, SceneCitations]

export function CapabilityStory() {
  const [active, setActive] = useState(0)
  const stepRefs = useRef<Array<HTMLElement | null>>([])

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) setActive(Number((entry.target as HTMLElement).dataset.index ?? 0))
        })
      },
      { rootMargin: '-45% 0px -45% 0px' },
    )
    stepRefs.current.forEach((node) => node && observer.observe(node))
    return () => observer.disconnect()
  }, [])

  return (
    <section className="story" aria-labelledby="story-title">
      <header className="story-head">
        <span className="section-kicker">核心能力</span>
        <h2 id="story-title">证明到什么程度？还有哪些矛盾和缺口？</h2>
        <p>产品的核心不止于生成一份文书，更在于帮你回答：这句话由什么材料支持。</p>
      </header>
      <div className="story-body">
        <div className="story-steps">
          {storyChapters.map((chapter, index) => {
            const Scene = storyScenes[index]
            return (
              <article
                key={chapter.kicker}
                ref={(node) => { stepRefs.current[index] = node }}
                data-index={index}
                className={`story-step${active === index ? ' is-active' : ''}`}
              >
                <span className="story-step-kicker"><i>{index + 1}</i>{chapter.kicker}</span>
                <h3>{chapter.title}</h3>
                <p>{chapter.body}</p>
                <ul>
                  {chapter.points.map((point) => <li key={point}>{point}</li>)}
                </ul>
                <div className="story-inline">
                  <Scene active />
                </div>
              </article>
            )
          })}
        </div>
        <div className="story-stage" aria-hidden="true">
          <div className="story-stage-inner">
            <div className="story-stage-top">
              <span>{storyChapters[active].kicker}</span>
              <span className="story-dots">
                {storyChapters.map((chapter, index) => <i key={chapter.kicker} className={index === active ? 'is-on' : ''} />)}
              </span>
            </div>
            {storyScenes.map((Scene, index) => (
              <div key={index} className={`story-scene-slot${index === active ? ' is-on' : ''}`}>
                <Scene active={index === active} />
              </div>
            ))}
            <span className="story-sample">示例案件 · 虚构内容</span>
          </div>
        </div>
      </div>
    </section>
  )
}

/* ---------- 案件助手：进度清单 + 逐行生成的办案策略 ---------- */

const agentSteps = ['确认代理立场', '拆解主张与成立要件', '区分有利与不利证据', '标出补证缺口', '预判对方反驳与我方应对']

const agentRows: Array<{ step: number; label: string; value: string; tone?: 'risk' | 'opponent' }> = [
  { step: 0, label: '代理立场', value: '原告（卖方）· 诉求支付剩余货款 38 万元及逾期付款违约金' },
  { step: 1, label: '主张', value: '被告应支付剩余货款 38 万元' },
  { step: 1, label: '成立要件', value: '合同有效；我方已交付；被告未足额付款' },
  { step: 1, label: '举证责任', value: '我方证明交付事实；被告证明已付款或质量异议' },
  { step: 2, label: '有利证据', value: '证据 1 买卖合同、证据 2 送货单' },
  { step: 2, label: '不利证据', value: '证据 4 转账回单：已付 10 万元，诉请金额需扣减', tone: 'risk' },
  { step: 3, label: '补证缺口', value: '验收合格的书面记录；催款记录' },
  { step: 4, label: '对方可能反驳', value: '设备存在质量问题，未验收合格', tone: 'opponent' },
  { step: 4, label: '我方应对', value: '补充使用记录，主张已实际使用视为验收' },
]

const AGENT_STEP_MS = 1900
const AGENT_HOLD_STEPS = 2

export function AgentStrategyPanel() {
  const reducedMotion = usePrefersReducedMotion()
  const [ref, inView] = useInView<HTMLDivElement>(0.25)
  const [tick, setTick] = useState(0)
  const total = agentSteps.length + AGENT_HOLD_STEPS

  useEffect(() => {
    if (reducedMotion || !inView) return
    const timer = window.setInterval(() => setTick((value) => (value + 1) % total), AGENT_STEP_MS)
    return () => window.clearInterval(timer)
  }, [reducedMotion, inView, total])

  // current = 正在进行的步骤；done = 已完成的步骤数
  const done = reducedMotion ? agentSteps.length : Math.min(tick, agentSteps.length)
  const current = reducedMotion || tick >= agentSteps.length ? -1 : tick

  return (
    <div ref={ref} className="agent-window">
      <div className="agent-bar">
        <span className="demo-window-dots" aria-hidden="true"><i /><i /><i /></span>
        <span className="agent-bar-title">案件助手 · 设备买卖合同纠纷</span>
        <SampleTag />
      </div>
      <div className="agent-body">
        <div className="agent-progress">
          <span className="agent-col-head">进度</span>
          <ol>
            {agentSteps.map((step, index) => {
              const state = index < done ? 'is-done' : index === current ? 'is-running' : 'is-pending'
              return (
                <li key={step} className={state}>
                  <span className="agent-mark" aria-hidden="true">{index < done ? '✓' : ''}</span>
                  <span className="agent-step-text">{step}</span>
                </li>
              )
            })}
          </ol>
          <span className="agent-status">{current >= 0 ? '正在分析案件材料…' : '已生成办案策略'}</span>
        </div>
        <div className="agent-output">
          <span className="agent-col-head">办案策略</span>
          <dl>
            {agentRows.map((row) => {
              const shown = row.step < done
              return (
                <div key={row.label} className={`agent-row${shown ? ' is-shown' : ''}${row.tone ? ` agent-row-${row.tone}` : ''}`}>
                  <dt>{row.tone === 'risk' ? '⚠ ' : row.tone === 'opponent' ? '⇄ ' : ''}{row.label}</dt>
                  <dd>{shown ? row.value : <span className="agent-skeleton" aria-hidden="true" />}</dd>
                </div>
              )
            })}
          </dl>
        </div>
      </div>
    </div>
  )
}

/* ---------- 适用场景：个人律师 / 律所团队（支持放办公室照片） ---------- */

// 照片放在 web/public/images/ 下，文件名与下面一致即可自动显示；没有照片时显示品牌色底。
const audienceCards = [
  {
    key: 'solo',
    title: '个人律师',
    lead: '从阅卷到签字前审阅，把文书里的事实依据与引用再核对一遍。',
    uses: ['多个文件夹材料分批导入', '每句陈述对回证据原件', '法条、案号核对官方来源'],
    image: '/images/scene-solo.jpg',
    alt: '律师在办公桌前审阅案卷材料',
    cta: { label: '免费注册', href: '/register' },
  },
  {
    key: 'team',
    title: '律所团队',
    lead: '用于律师各自办理案件时的材料整理与文书核验；团队需求可联系我们沟通。',
    uses: ['各自办案的材料整理', '文书逐句核验', '团队需求单独沟通'],
    image: '/images/scene-team.jpg',
    alt: '律所团队围绕电脑讨论案件',
    cta: { label: '咨询团队方案', href: '/console?apply=team#cocreate' },
  },
  {
    key: 'legal',
    title: '企业法务',
    lead: '围绕争议案件材料，核对事实表述与法律引用。',
    uses: ['合同争议材料整理', '事实表述对回业务原件', '引用法条逐条核对'],
    image: '/images/scene-legal.jpg',
    alt: '法务人员审阅合同文件',
    cta: { label: '免费注册', href: '/register' },
  },
]

const AUD_AUTO_MS = 4000

export function AudienceSection() {
  const [active, setActive] = useState(0)
  const reducedMotion = usePrefersReducedMotion()
  const [ref, inView] = useInView<HTMLDivElement>(0.2)
  const auto = !reducedMotion && inView

  useEffect(() => {
    if (!auto) return
    const timer = window.setTimeout(() => setActive((value) => (value + 1) % audienceCards.length), AUD_AUTO_MS)
    return () => window.clearTimeout(timer)
  }, [active, auto])

  const card = audienceCards[active]
  return (
    <div ref={ref} className={`aud${auto ? ' is-auto' : ''}`}>
      <div className="aud-media">
        {audienceCards.map((item, index) => (
          <img key={item.key} src={item.image} alt={item.alt} loading="lazy" className={index === active ? 'is-on' : ''} />
        ))}
      </div>
      <div className="aud-side">
        <div className="aud-tabs" role="tablist" aria-label="适用人群">
          {audienceCards.map((item, index) => (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={index === active}
              className={`aud-tab${index === active ? ' is-active' : ''}`}
              onClick={() => setActive(index)}
            >
              <span>{item.title}</span>
            </button>
          ))}
        </div>
        <div className="aud-body" key={card.key}>
          <p>{card.lead}</p>
          <ul>
            {card.uses.map((item) => <li key={item}>{item}</li>)}
          </ul>
          <a className="text-link" href={card.cta.href} onClick={() => track('hero_cta_click', `audience:${card.key}`)}>{card.cta.label} →</a>
        </div>
      </div>
    </div>
  )
}

/* ---------- 首屏背景视频 ---------- */

export function HeroBackdrop() {
  const reducedMotion = usePrefersReducedMotion()
  const [wide] = useState(() => {
    try {
      return window.matchMedia('(min-width: 768px)').matches
    } catch {
      return false
    }
  })
  const videoRef = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    video.muted = true
    void video.play().catch(() => {
      // 自动播放被拒绝时，停在封面帧即可。
    })
  }, [])
  const showVideo = wide && !reducedMotion
  return (
    <div className="hero-backdrop" aria-hidden="true">
      {showVideo ? (
        <video ref={videoRef} src="/media/hero-bg.mp4" poster="/media/hero-bg-poster.jpg" autoPlay muted loop playsInline preload="auto" />
      ) : (
        <img src="/media/hero-bg-poster.jpg" alt="" />
      )}
    </div>
  )
}

/* ---------- 工作流：可点选的四步，每步一个画面（案件助手放在第 2 步） ---------- */

const wfSteps = [
  { scene: '接案与阅卷', title: '链接材料，理解原件', body: '同一案件可链接多个本地文件夹，增量导入；整理出证明目的、关键事实、争议点与证明局限。' },
  { scene: '举证准备', title: '确认代理立场，梳理举证思路', body: '先确认代理立场，再梳理主张、成立要件、举证责任与补证缺口，供你判断取舍。' },
  { scene: '质证意见与法律文书', title: '撰写或导入文书', body: '起草或导入 Word 文书，边生成边审阅，选中段落定向改写。' },
  { scene: '庭前审阅', title: '逐句核验，导出 Word', body: '逐句核验事实依据，检查法条与案例引用，确认后导出 Word。' },
]

const WF_AUTO_MS = 4500

function WfMaterials() {
  return (
    <div className="wf-visual wf-v-materials">
      <div className="wf-photo" style={{ backgroundImage: 'url(/media/files-cases.jpg)' }} aria-hidden="true" />
      <div className="wf-insight">
        <span className="wf-insight-head">原件理解 · 证据 4《银行转账回单》</span>
        <dl>
          <div><dt>证明目的</dt><dd>被告已支付部分货款</dd></div>
          <div><dt>关键事实</dt><dd>2025-05-06 转账 100,000.00 元</dd></div>
          <div><dt>证明局限</dt><dd>附言仅写“设备首款”，未注明对应合同编号</dd></div>
        </dl>
        <span className="wf-insight-tag">律师关注：与起诉状“未支付任何货款”的表述不一致</span>
      </div>
    </div>
  )
}

const wfDraft = '对证据 4《银行转账回单》的真实性无异议，但对其证明目的有异议。该回单显示被告已于 2025 年 5 月 6 日支付首款 10 万元，原告据此主张的欠款金额应相应扣减为 38 万元……'

function WfWriting({ active }: { active: boolean }) {
  const reducedMotion = usePrefersReducedMotion()
  const [count, setCount] = useState(reducedMotion ? wfDraft.length : 0)
  useEffect(() => {
    if (reducedMotion) {
      setCount(wfDraft.length)
      return
    }
    if (!active) {
      setCount(0)
      return
    }
    setCount(0)
    const timer = window.setInterval(() => {
      setCount((value) => {
        if (value >= wfDraft.length) {
          window.clearInterval(timer)
          return value
        }
        return value + 2
      })
    }, 40)
    return () => window.clearInterval(timer)
  }, [active, reducedMotion])
  return (
    <div className="wf-visual wf-v-writing">
      <div className="wf-doc">
        <div className="wf-doc-bar">
          <span>质证意见（草稿）.docx</span>
          <span className="wf-doc-chip">AI 撰写中</span>
        </div>
        <p className="wf-doc-title">质证意见</p>
        <p className="wf-doc-text">
          {wfDraft.slice(0, count)}
          {count < wfDraft.length ? <span className="wf-caret" aria-hidden="true" /> : null}
        </p>
        <div className="wf-doc-actions">
          <span>定向改写</span>
          <span>改得更简洁</span>
          <span>补充法律依据</span>
        </div>
      </div>
      <div className="wf-import">
        <span className="wf-import-icon" aria-hidden="true">W</span>
        <span><b>已有文书？</b>直接导入 Word，逐句对照证据</span>
      </div>
    </div>
  )
}

function WfReview() {
  return (
    <div className="wf-visual wf-v-review">
      <div className="wf-doc">
        <p className="wf-doc-title">质证意见（定稿）</p>
        <p className="wf-review-line"><span>原告与被告于 2025 年 3 月 1 日签订《设备买卖合同》，约定货款总额 48 万元。</span><Stamp tone="ok">支持</Stamp></p>
        <p className="wf-review-line"><span>原告已于 2025 年 4 月 10 日完成全部设备交付，被告当场验收合格。</span><Stamp tone="warn">证据不足</Stamp></p>
        <p className="wf-review-line"><span>被告已于 2025 年 5 月 6 日支付首款 10 万元。</span><Stamp tone="ok">支持</Stamp></p>
      </div>
      <div className="wf-export">
        <span className="wf-import-icon" aria-hidden="true">W</span>
        <span><b>质证意见.docx</b>已导出，继续打磨</span>
      </div>
    </div>
  )
}

export function WorkflowExplorer() {
  const [active, setActive] = useState(0)
  const [userPicked, setUserPicked] = useState(false)
  const reducedMotion = usePrefersReducedMotion()
  const [ref, inView] = useInView<HTMLDivElement>(0.2)
  const auto = !reducedMotion && inView && !userPicked

  useEffect(() => {
    if (!auto) return
    const timer = window.setTimeout(() => setActive((value) => (value + 1) % wfSteps.length), WF_AUTO_MS)
    return () => window.clearTimeout(timer)
  }, [active, auto])

  return (
    <div
      ref={ref}
      className={`wf${auto ? ' is-auto' : ''}`}
    >
      <div className="wf-steps" role="tablist" aria-label="典型工作流">
        {wfSteps.map((step, index) => (
          <button
            key={step.title}
            type="button"
            role="tab"
            id={`wf-tab-${index}`}
            aria-selected={active === index}
            aria-controls="wf-panel"
            className={`wf-step${active === index ? ' is-active' : ''}`}
            onClick={() => {
              setActive(index)
              setUserPicked(true)
            }}
          >
            <span className="wf-num">{index + 1}</span>
            <span className="wf-step-main">
              <span className="wf-scene">{step.scene}</span>
              <strong>{step.title}</strong>
              <span className="wf-step-body">{step.body}</span>
            </span>
          </button>
        ))}
      </div>
      <div className="wf-panel" id="wf-panel" role="tabpanel" aria-labelledby={`wf-tab-${active}`}>
        <div className={`wf-slot${active === 0 ? ' is-on' : ''}`}><WfMaterials /></div>
        <div className={`wf-slot has-bg${active === 1 ? ' is-on' : ''}`} style={{ ['--wf-bg' as string]: 'url(/media/bg-scales.jpg)' }}><AgentStrategyPanel /></div>
        <div className={`wf-slot has-bg${active === 2 ? ' is-on' : ''}`} style={{ ['--wf-bg' as string]: 'url(/media/bg-writing.jpg)' }}><WfWriting active={active === 2} /></div>
        <div className={`wf-slot has-bg${active === 3 ? ' is-on' : ''}`} style={{ ['--wf-bg' as string]: 'url(/media/bg-light.jpg)' }}><WfReview /></div>
        <span className="wf-sample">示例案件 · 虚构内容</span>
      </div>
    </div>
  )
}

/* ---------- 区别：同一段文字，切换“通用 AI 写作 / LawVerify” ---------- */

const compareSides = {
  generic: {
    label: '通用 AI 写作',
    points: ['默认中立，不知道你代理哪一方', '根据你的描述来写，不回到证据原件', '出了错，你得自己逐句去查', '可能引用已经废止的旧法'],
  },
  lv: {
    label: 'LawVerify',
    points: ['先确认代理立场：原告（卖方）', '每句陈述都能点回证据原件', '支持、矛盾、证据不足，逐句标出', '法条核对官方法源，废止的直接标红'],
  },
}

export function CompareToggle() {
  const [mode, setMode] = useState<'generic' | 'lv'>('lv')
  const [userPicked, setUserPicked] = useState(false)
  const reducedMotion = usePrefersReducedMotion()
  const [ref, inView] = useInView<HTMLDivElement>(0.35)

  useEffect(() => {
    if (reducedMotion || userPicked || !inView) return
    const timer = window.setTimeout(() => setMode((value) => (value === 'lv' ? 'generic' : 'lv')), mode === 'lv' ? 6000 : 3500)
    return () => window.clearTimeout(timer)
  }, [mode, userPicked, inView, reducedMotion])

  const side = compareSides[mode]
  const lv = mode === 'lv'
  return (
    <div ref={ref} className={`cmp is-${mode}`}>
      <div className="cmp-copy">
        <div className="cmp-switch" role="group" aria-label="切换对比">
          {(['generic', 'lv'] as const).map((key) => (
            <button
              key={key}
              type="button"
              aria-pressed={mode === key}
              className={mode === key ? 'is-on' : ''}
              onClick={() => {
                setMode(key)
                setUserPicked(true)
              }}
            >
              {compareSides[key].label}
            </button>
          ))}
        </div>
        <ul className="cmp-points" key={mode}>
          {side.points.map((point) => <li key={point}>{point}</li>)}
        </ul>
        <p className="cmp-note">示意对比，非特定模型实测。</p>
      </div>
      <div className="cmp-doc" aria-label={`${side.label}写出的同一段质证意见（示例）`}>
        <div className="cmp-doc-bar">
          <span>{lv ? '代理方：原告（卖方）' : '代理方：未设定'}</span>
          <SampleTag />
        </div>
        <p className="cmp-line">
          <span>原告与被告于 2025 年 3 月 1 日<span className={lv ? 'cmp-hl cmp-hl-ok' : ''}>签订《设备买卖合同》</span>，约定货款总额 48 万元。</span>
          {lv ? <span className="cmp-ref">证据 1 · 第 1 页</span> : null}
        </p>
        <p className="cmp-line">
          <span>被告至今<span className={lv ? 'cmp-hl cmp-hl-bad' : ''}>未支付任何货款</span>。</span>
          {lv ? <Stamp tone="bad" className="cmp-stamp">矛盾</Stamp> : null}
        </p>
        <p className="cmp-line">
          依据<span className={lv ? 'cmp-hl cmp-hl-bad cmp-struck' : ''}>《合同法》第一百五十九条</span>，被告应当按照约定的数额支付价款。
          {lv ? <Stamp tone="bad" className="cmp-stamp">法条已废止</Stamp> : null}
        </p>
        <p className="cmp-foot">{lv ? '3 句已核验 · 2 处需要修改' : '没有标注。哪句有依据、哪句有问题，需要你自己去查。'}</p>
      </div>
    </div>
  )
}


/* ---------- 导入已有文书：同首页的校验展示（只划关键词 + 圆点结论） ---------- */

const importLines: Array<{ before: string; mark: string; after: string; tone: 'ok' | 'warn' | 'bad'; label: string; detail: string }> = [
  { before: '原告与被告于 2025 年 3 月 1 日', mark: '签订《设备买卖合同》', after: '，约定货款总额 48 万元。', tone: 'ok', label: '支持', detail: '证据 1《设备买卖合同》第 1 页' },
  { before: '设备交付后，被告', mark: '当场验收合格', after: '。', tone: 'warn', label: '证据不足', detail: '送货单仅有签收，未见验收记录' },
  { before: '被告至今', mark: '未支付任何货款', after: '。', tone: 'bad', label: '矛盾', detail: '证据 4 转账回单：已付首款 10 万元' },
]

export function ImportPreview() {
  return (
    <div className="imp" aria-label="导入已有文书后逐句核验的示意（示例案件，虚构内容）">
      <div className="imp-file">
        <span className="wf-import-icon" aria-hidden="true">W</span>
        <span><b>代理词.docx</b>已导入 · 与本案 5 份证据逐句对照</span>
      </div>
      <div className="imp-doc">
        {importLines.map((line) => (
          <div className={`imp-line imp-${line.tone}`} key={line.mark}>
            <p>{line.before}<span className="imp-mark">{line.mark}</span>{line.after}</p>
            <div className="imp-note"><Stamp tone={line.tone}>{line.label}</Stamp><span>{line.detail}</span></div>
          </div>
        ))}
        <SampleTag />
      </div>
    </div>
  )
}

/* ===================== 产品页：功能分章的演示 ===================== */

/* 章节导航：滚到哪一章，高亮哪一章 */
export function ProductNav({ items }: { items: Array<{ id: string; label: string }> }) {
  const [active, setActive] = useState(items[0]?.id ?? '')
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) setActive(entry.target.id)
        })
      },
      { rootMargin: '-40% 0px -55% 0px' },
    )
    items.forEach((item) => {
      const node = document.getElementById(item.id)
      if (node) observer.observe(node)
    })
    return () => observer.disconnect()
  }, [items])
  return (
    <nav className="pf-nav" aria-label="产品功能">
      {items.map((item, index) => (
        <a key={item.id} href={`#${item.id}`} className={active === item.id ? 'is-active' : ''}>
          <i>{String(index + 1).padStart(2, '0')}</i>
          <span>{item.label}</span>
        </a>
      ))}
    </nav>
  )
}

/* 超大材料：案件文件夹 + 原件理解 */
const mpFolders = [
  {
    name: '起诉材料',
    files: [
      { name: '起诉状.docx', meta: '12 页', state: '已解析' },
      { name: '证据目录.pdf', meta: '6 页', state: '已解析' },
    ],
  },
  {
    name: '往来证据',
    files: [
      { name: '往来邮件与催款记录.pdf', meta: '1,248 页 · 86 MB', state: '已解析' },
      { name: '银行转账回单.pdf', meta: '2 页', state: '已解析', active: true },
      { name: '送货单.jpg', meta: '1 页', state: '已解析' },
      { name: '微信聊天记录截图（23 张）', meta: '新增', state: '解析中', fresh: true },
    ],
  },
]

export function MaterialsPanel() {
  return (
    <div className="mp" aria-label="案件材料示意（示例案件，虚构内容）">
      <div className="mp-bar">
        <b>设备买卖合同纠纷</b>
        <span>已关联 2 个本地文件夹 · 1,281 页</span>
      </div>
      <div className="mp-body">
        <ul className="mp-tree">
          {mpFolders.map((folder) => (
            <li key={folder.name}>
              <span className="mp-folder">{folder.name}</span>
              <ul>
                {folder.files.map((file) => (
                  <li key={file.name} className={`mp-file${file.active ? ' is-active' : ''}${file.fresh ? ' is-fresh' : ''}`}>
                    <span className="mp-name">{file.name}</span>
                    <span className="mp-meta">{file.meta} · {file.state}</span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
        <div className="mp-detail">
          <span className="mp-detail-head">原件理解 · 银行转账回单.pdf</span>
          <dl>
            <div><dt>证明目的</dt><dd>被告已支付部分货款</dd></div>
            <div><dt>关键事实</dt><dd>2025-05-06 转账</dd></div>
            <div><dt>金额</dt><dd>100,000.00 元</dd></div>
            <div><dt>证明局限</dt><dd>附言仅写“设备首款”，未注明合同编号</dd></div>
          </dl>
          <span className="mp-flag">与起诉状“未支付任何货款”的表述不一致</span>
        </div>
      </div>
      <SampleTag />
    </div>
  )
}

/* 案件作战图：我方 / 证据 / 对方 三栏 */
const smColumns: Array<{ title: string; items: Array<{ label: string; value: string; tone?: 'risk' | 'opponent' }> }> = [
  {
    title: '我方',
    items: [
      { label: '主张', value: '被告应支付剩余货款 38 万元' },
      { label: '成立要件', value: '合同有效；我方已交付；被告未足额付款' },
      { label: '举证责任', value: '我方证明交付；被告证明已付款或质量异议' },
    ],
  },
  {
    title: '证据',
    items: [
      { label: '有利证据', value: '证据 1 买卖合同、证据 2 送货单' },
      { label: '不利证据', value: '证据 4 转账回单：已付 10 万元，诉请需扣减', tone: 'risk' },
      { label: '补证缺口', value: '验收合格的书面记录；催款记录' },
    ],
  },
  {
    title: '对方',
    items: [
      { label: '可能反驳', value: '设备存在质量问题，未验收合格', tone: 'opponent' },
      { label: '我方应对', value: '补充使用记录，主张已实际使用视为验收' },
    ],
  },
]

export function StrategyMap() {
  return (
    <div className="sm2" aria-label="案件作战图示意（示例案件，虚构内容）">
      <div className="sm2-head">
        <span className="sm2-step">代理立场</span>
        <b>原告（卖方）</b>
        <span>诉求：支付剩余货款 38 万元及逾期付款违约金</span>
      </div>
      <div className="sm2-cols">
        {smColumns.map((column) => (
          <div className="sm2-col" key={column.title}>
            <span className="sm2-col-title">{column.title}</span>
            {column.items.map((item) => (
              <div className={`sm2-item${item.tone ? ` is-${item.tone}` : ''}`} key={item.label}>
                <b>{item.label}</b>
                <span>{item.value}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
      <SampleTag />
    </div>
  )
}

/* 质证意见起草：编辑器 + 定向改写 */
export function DraftEditor() {
  return (
    <div className="de" aria-label="质证意见起草示意（示例案件，虚构内容）">
      <div className="de-bar">
        <span className="de-file">质证意见.docx</span>
        <span className="de-state">边生成边审阅</span>
        <span className="de-export">导出 Word</span>
      </div>
      <div className="de-page">
        <p className="de-title">质证意见</p>
        <p className="de-h">一、对证据 4《银行转账回单》的质证意见</p>
        <p>对该证据的真实性无异议，<span className="de-sel">但对其证明目的有异议</span>。该回单显示被告已于 2025 年 5 月 6 日支付首款 10 万元<span className="de-ref">证据 4 · 第 1 页</span>，原告主张的欠款金额应相应扣减为 38 万元。</p>
        <div className="de-pop">
          <span className="de-pop-head">定向改写</span>
          <span>改得更简洁</span>
          <span>补充法律依据</span>
          <span className="de-pop-input">告诉 AI 怎么改…</span>
        </div>
      </div>
      <SampleTag />
    </div>
  )
}
