import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react'
import type { CheckCode, CheckOutcome } from '../../../server/src/intelligence/verification/protocol'
import profile from '../../../server/src/intelligence/verification/doc-element-profile.json'
import { declarationEditRange } from '../../../server/src/intelligence/verification/review-status.ts'
import { ChevronDown, PanelLeft, PanelRight, Sparkles } from 'lucide-react'
import { api } from '../api'
import walnut from '../features/auth/walnut.jpg'
import { whenUiIdle } from '../redesign-loader'
import { Button } from './components/ui/button'
import { Textarea } from './components/ui/textarea'
import { Tabs, TabsContent, TabsList, TabsTrigger } from './components/ui/tabs'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './components/ui/dropdown-menu'
import { ContextMenu } from 'radix-ui'
import { BrandHome } from './Home'
import { EssentialDialogs } from './EssentialDialogs'
import { DocumentPaper } from './DocumentPaper'
import { useApp } from './AppContext'
import { STATUS_NAMES, type ReviewElement } from './model'
import { DocumentTypeSelect } from './DocumentTypeSelect'
import { WorkspaceMaterials } from './WorkspaceMaterials'
import { ReviewTodos } from './ReviewTodos'
import { currentReviewFinding, documentBadge } from './reviewOverview'
import { CaseReportButton } from './CaseReportButton'
import { CASE_MATCH_LABELS, caseCitations } from './caseResearchReport'
import { VERIFICATION_ACTION_LABELS, verificationImpacts } from './verificationMemory'
import { lastSelectedAnchor } from './rewriteAnchor'
import type { Certificate } from '../types'

const loadCaseMemory = () => import('./CaseMemory')
const loadWorkspaceAssistant = () => import('./WorkspaceAssistant')
const CaseMemory = lazy(() => loadCaseMemory().then(module => ({ default: module.CaseMemory })))
const WorkspaceAssistant = lazy(() => loadWorkspaceAssistant().then(module => ({ default: module.WorkspaceAssistant })))

function Topbar({ memory, onMemory }: { memory: boolean; onMemory: () => void }) {
  const app = useApp()
  const project = app.project
  if (!project) return null
  const folder = app.workspace?.cases.find(item => item.id === project.id)
  const memoryRecord = app.workspace?.caseContextMemories.find(item => item.caseId === project.id)
  const basics = folder?.basicInfo
  const parties = (['plaintiff', 'defendant'] as const).flatMap(side => {
    const rawName = basics?.[side]
    const name = memory ? rawName?.trim() : rawName
    const ours = basics?.ourSide === side
    if (!name && !ours) return []
    const label = side === 'plaintiff' ? '原告' : '被告'
    return [`${label}${ours ? '（我方）' : ''}${name ? `：${name}` : ''}`]
  })
  const identity = (memory ? parties : [
    ...(parties.length ? parties : (memoryRecord?.parties ?? []).slice(0, 2)), basics?.caseNumber, basics?.court || folder?.description,
  ]).filter(Boolean).join(' ｜ ')
  return (
    <div className={`topbar workspace-topbar${memory ? ' workspace-memory-topbar' : ''}`}>
      <BrandHome onHome={async () => { if (await app.flushDocument()) app.setPage('home') }} />
      {!memory && <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" className="case-btn" aria-label={`切换案件 · ${project.name}`}>
            <b>{project.name}</b><ChevronDown size={14} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="new-case-menu">
          {app.projects.map(item => (
            <DropdownMenuItem key={item.id} className={`case-opt ${item.id === project.id ? 'on' : ''}`}
              onSelect={async () => { if (await app.flushDocument()) app.enter(item.id) }}>
              <span className="case-letter">{item.name[0]}</span>
              <span><span className="n">{item.name}</span><span className="m">{item.mats.length} 份材料</span></span>
              <span className="ck">{item.id === project.id ? '✓' : ''}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>}
      {identity && <span className="workspace-case-identity" title={identity}>{identity}</span>}
      {!memory && <Button className="btn btn-gh btn-sm workspace-report-button" disabled={!app.certificate || app.busy}
        onClick={async () => { if (await app.prepareDocument()) { app.setAssistantRequest(null); app.setPage('report') } }}>导出文书</Button>}
      <Button className="btn btn-pri btn-sm" disabled={app.busy} onClick={onMemory}>{memory ? '返回工作台' : '案件记忆'}</Button>
    </div>
  )
}

function DocumentHeader({ paneControls }: { paneControls: ReactNode }) {
  const app = useApp()
  const project = app.project!
  const certificate = app.certificate
  return <>
    <div className="workspace-doc-strip">
      {paneControls}
      <span className="workspace-doc-count">文书 {project.docs.length}</span>
      <Tabs value={app.docId} activationMode="manual" className="doc-switch"
        onValueChange={async id => { if (await app.flushDocument()) app.switchDocument(id) }}>
        <TabsList className="new-doc-tabs" variant="line" aria-label="案件文书">
          {project.docs.map(id => {
            const badge = documentBadge(project.els[id] ?? [])
            return <TabsTrigger key={id} className="doc-tab" value={id}>
              <span className="workspace-doc-name">{project.docNames[id]}</span>
              {badge && <span className="workspace-doc-badge" title={badge.label}>
                <i className={`color-${badge.tone}`} aria-hidden="true" />
                {!!badge.count && <span aria-hidden="true">{badge.count}</span>}
                <span className="sr-only">{badge.label}</span>
              </span>}
            </TabsTrigger>
          })}
        </TabsList>
      </Tabs>
    </div>
    {certificate && <div className="ctool workspace-document-heading">
      <h1>{certificate.title}</h1>
      {certificate.linkageStale && <span className="workspace-stale">待重核</span>}
      <DocumentTypeSelect value={certificate.docKey} disabled={app.busy} label="当前文书类型" onChange={async docKey => {
        if (await app.prepareDocument()) {
          void app.run(async () => { await api.classifyCertificate(certificate.id, docKey) }, '文书类型已保存，请重新核验')
        }
      }} />
      <DropdownMenu>
        <DropdownMenuTrigger asChild><Button variant="ghost" size="sm">高亮筛选 <ChevronDown size={12} /></Button></DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="new-case-menu assistant-more-menu">
          {([['all', '全部'], ['fail', '红灯'], ['warn', '预警'], ['pass', '存在支持']] as const).map(([key, label]) =>
            <DropdownMenuItem key={key} onSelect={() => { app.select(''); app.setFilter(key) }}>{app.filter === key ? '✓ ' : ''}{label}</DropdownMenuItem>)}
        </DropdownMenuContent>
      </DropdownMenu>
      {app.certificate?.verification?.dirty && app.certificate.linkageInputKey && <Button className="btn btn-gh btn-sm" disabled={app.busy}
        onClick={async () => { if (await app.prepareDocument()) void app.recheckDirty() }}>局部重核</Button>}
      <Button className="btn btn-pri btn-sm" disabled={app.busy}
        onClick={async () => { if (await app.prepareDocument()) void app.verify() }}>{app.certificate?.verification?.revision ? '全文重核' : 'AI 核验'}</Button>
    </div>}
  </>
}

const selectionActions = [
  ['case', '问 AI', '请核对所选文字的事实与引用依据。'],
  ['rewrite', '改写', '请把所选文字改写得更严谨。'],
  ['law', '查法条'],
  ['similar', '查类案'],
] as const

function readDocumentSelection(container: HTMLElement | null, certificate?: Certificate) {
  const body = container?.querySelector('.whole-document-content')
  const selection = window.getSelection()
  if (!body || !selection || selection.isCollapsed || !body.contains(selection.anchorNode) || !body.contains(selection.focusNode)) return
  const text = selection.toString().trim()
  if (!text) return undefined
  const range = selection.getRangeAt(0)
  const declarationIds = [...new Set(Array.from(body.querySelectorAll<HTMLElement>('[data-el]'))
    .filter(node => range.intersectsNode(node)).flatMap(node => node.dataset.el ? [node.dataset.el] : []))].slice(0, 12)
  return { body, text, range, declarationIds, anchor: lastSelectedAnchor(body, range, certificate) }
}

type AssistantSelection = Pick<NonNullable<ReturnType<typeof readDocumentSelection>>, 'text' | 'declarationIds' | 'anchor'>

const highlightStatus = {
  pass: '存在支持', warn: '预警', fail: '不通过', miss: '缺少出处', note: '已标注', pending: '待核验',
}
const highlightCheckCodes = ['A1', 'A2', 'A3', 'A4', 'A5'] as const
const highlightCheckStatus: Record<CheckOutcome, string> = {
  pass: '通过', warn: '预警', fail: '不通过', miss: '缺少出处', pending: '未核实', 'not-applicable': '不适用',
}

function LinkageCard({ element, compact }: { element: ReviewElement; compact: boolean }) {
  const app = useApp()
  const [editing, setEditing] = useState(false)
  const [noteOpen, setNoteOpen] = useState(false)
  const [text, setText] = useState(element.quote)
  const declarationNote = element.declaration ? element.declaration.review?.note ?? '' : element.note
  const confirmed = element.verified && (!element.declaration || element.declaration.review?.decision === 'confirmed')
  const [note, setNote] = useState(declarationNote)
  const [checked, setChecked] = useState<CheckCode[]>([])
  const [pendingEdit, setPendingEdit] = useState<'adopt' | 'delete' | null>(null)
  const [declined, setDeclined] = useState(false)
  const certificate = app.certificate
  const finding = currentReviewFinding(certificate, element)
  const checks = Object.entries(finding?.checks ?? {}).flatMap(([code, check]) => check.outcome === 'not-applicable'
    ? [] : [{ code: code as CheckCode, check, outcome: check.outcome }])
  const suggestion = finding && element.sources.length > 0 && declarationEditRange(element.original.text, finding, 'adopt')
  const canDelete = element.verdict === 'miss' && finding && declarationEditRange(element.original.text, finding, 'delete')
  const sk = ['pass', 'note'].includes(element.verdict)
    ? 'ok'
    : element.verdict === 'warn'
      ? 'warn'
      : 'bad'
  const names = { l1: '案件原材料', l2: '法条', l3: '案例', l0: '未联动' }
  const caseRows = caseCitations([element], app.workspace?.knowledgeCases ?? [])
  const calibration = finding?.confidenceCalibration
  const paragraphIndex = certificate?.paragraphs.findIndex(paragraph => paragraph.id === element.paragraphId) ?? -1
  const location = [paragraphIndex >= 0 ? `第 ${paragraphIndex + 1} 段` : '正文',
    element.sentenceIndex !== undefined ? `第 ${element.sentenceIndex + 1} 句` : undefined].filter(Boolean).join(' · ')
  const category = profile.elementTypes[element.type as keyof typeof profile.elementTypes] ?? element.type
  const differences = finding?.differences?.length ? finding.differences
    : !compact && (finding || !element.declaration && !certificate?.linkageStale) && element.verdict === 'fail' && element.sources[0]?.quote
      ? [{ field: '原文', document: element.quote, source: element.sources[0].quote }] : []
  const dependencies = certificate && element.declaration?.dependencies?.length
    ? verificationImpacts(certificate, app.elements).filter(item => item.target.id === element.id) : []
  const history = certificate?.verification?.audit?.filter(item => item.declarationId === element.id || item.affected?.includes(element.id)) ?? []
  const localHistory = app.audits.filter(item => item.certificateId === element.certificateId && item.paragraphId === element.paragraphId
    && (!element.declaration || item.elementId === element.id || item.elementId === `${element.certificateId}:${element.paragraphId}:paragraph`))
  useEffect(() => {
    const handler = (event: Event) => {
      if (app.busy) return
      const op = (event as CustomEvent<string>).detail
      if (op === 'confirm') void app.confirm(element)
      if (op === 'reject') void app.reject(element)
      if (op === 'edit') setEditing(true)
    }
    window.addEventListener('lv-operation', handler)
    return () => window.removeEventListener('lv-operation', handler)
  }, [app, element])
  const editForm = <div className="rc-q">
    <Textarea autoFocus={compact} value={text} onChange={event => setText(event.target.value)} aria-label="修改声明" />
    <div className="inline-actions">
      <Button className="op pri" disabled={app.busy} onClick={async () => {
        if (await app.edit(element, text)) {
          setEditing(false)
          if (element.declaration) void app.recheckDirty()
        }
      }}>保存并局部重核</Button>
      <Button className="op" disabled={app.busy} onClick={() => {
        setEditing(false)
        setText(element.quote)
      }}>取消</Button>
    </div>
  </div>
  const confirmation = pendingEdit && <div className="advise y" role="group" aria-label="确认修改声明">
    <p>{pendingEdit === 'adopt'
      ? compact ? '确认采用这条修改建议，保存后进入待重核。' : '确认替换上方原文，保存后进入待重核。'
      : `确认从正文移除「${element.quote}」，原文和操作将保留在报告中。`}</p>
    {compact && suggestion && <p>{suggestion.replacement}</p>}
    <Button className="op pri" disabled={app.busy} onClick={async () => {
      if (await app.applyDeclarationEdit(element, pendingEdit)) setPendingEdit(null)
    }}>{pendingEdit === 'adopt' ? '确认替换' : '确认删除'}</Button>
    <Button className="op" disabled={app.busy} onClick={() => setPendingEdit(null)}>取消</Button>
  </div>
  const sources = element.sources.length ? <ul className="review-detail-sources">{element.sources.map((source, index) => (
    <li key={`${source.targetId}-${index}`}>
      <button type="button" className="rc-loc" onClick={() => app.setDrawer(source)}>
        <span className={`src-dot ${source.st}`} />
        <span><b className="nm">{source.name}</b>{source.loc && <small>{source.loc}</small>}</span>
        <span className="source-preview-link">预览 →</span>
      </button>
      {source.quote && <blockquote>{source.quote}</blockquote>}
    </li>
  ))}</ul> : <p className="review-view-empty">{element.verdict === 'pending' ? '此声明待核验，暂无可回查出处。' : '暂无可回查出处。'}</p>
  return (
    <div className={`rc st-${sk}${compact ? ' review-highlight-result' : ''}`}>
      {compact ? <>
        <section className="review-highlight-conclusion" aria-label="核验结论">
          <span className={`review-highlight-status text-${element.verdict}`}>{highlightStatus[element.verdict]}</span>
          <p>{element.reason}</p>
          {suggestion && <p className="review-highlight-suggestion">修改建议 · {suggestion.replacement}</p>}
        </section>
        <section className="review-highlight-sources" aria-label="出处">
          <h3>出处</h3>
          {sources}
        </section>
        {!editing && !pendingEdit && <div className="ops">
          <Button className={`op${suggestion ? '' : ' pri'}`} disabled={app.busy} onClick={() => setEditing(true)}>修改声明</Button>
          {suggestion && <Button className="op pri" disabled={app.busy} onClick={() => setPendingEdit('adopt')}>采纳修改建议</Button>}
          <Button className="op" disabled={app.busy} onClick={() => app.setReferenceTarget(element)}>关联出处</Button>
        </div>}
        {editing && editForm}
        {confirmation}
      </> : <>
      <div className="rc-h">
        <span className={`src-dot ${element.src}`} />
        <span className="rc-type">
          {category} · {names[element.src]}
          {element.caseVerification?.match && ` · ${CASE_MATCH_LABELS[element.caseVerification.match]}`}
        </span>
        <span className="user-tag">{element.declaration
          ? confirmed ? '声明已人工确认' : element.original.verified ? '有历史整段确认' : '待人工审阅'
          : element.verified ? '整段已人工确认' : '整段待人工审阅'}</span>
        <span className="rc-st">
          <i className={`color-${element.verdict}`} />
          {STATUS_NAMES[element.verdict]}
        </span>
      </div>
      {editing ? editForm : <div className="rc-q">{element.quote}</div>}
      <div className="rc-reason">
        <b>核验结论 · </b>
        {element.reason}
      </div>
      <div className="workspace-linkage-assistant">
        <Button variant="ghost" size="sm" disabled={app.busy} onClick={() => app.setAssistantRequest({
          mode: 'case', prompt: '请根据卷内材料核对这条声明，并指出需要补证的事项。', quote: element.quote,
          declarationIds: [element.id], anchor: { paragraphId: element.paragraphId, start: element.start, quote: element.quote },
        })}><Sparkles size={14} />问 AI</Button>
        {!!caseRows.length && <CaseReportButton rows={caseRows}>导出本句案例</CaseReportButton>}
      </div>
      </>}
      <details className="review-declaration-details" open>
        <summary>核验详情{!compact && <small>{location}</small>}</summary>
        {compact && <>
          <p className="review-highlight-location">{category} · {location}</p>
          <blockquote className="rc-q">{element.quote}</blockquote>
        </>}
        {element.conf !== null && calibration && <>
            <div className="conf">
              <span className="mat-description">结论置信度</span>
              <div className="conf-track" aria-hidden="true">
                <i style={{ width: `${element.conf}%` }} />
              </div>
              <span className="conf-num">{element.conf}%</span>
            </div>
            <details className="confidence-details">
              <summary>查看置信度依据</summary>
              <p>{calibration.basis}。同类 AI 结论与律师独立复核的一致概率。</p>
              <p>校准集 {calibration.calibrationCases} 案，验证集 {calibration.validationCases} 案，验证一致率 {calibration.validationAgreementPercent}%。</p>
              <p>校准版本 {calibration.version}</p>
            </details>
          </>}
        {!compact && <><h3>可回查出处</h3>{sources}</>}
        {differences.length > 0 && <table className="review-detail-differences">
          <caption>{finding?.differences?.length ? '核验差异' : '原文对照'}</caption>
          <thead><tr><th scope="col">核对项</th><th scope="col">文书声明</th><th scope="col">出处原文</th></tr></thead>
          <tbody>{differences.map(({ field, document, source }, index) => <tr key={index}>
            <th scope="row">{field}</th><td>{document}</td><td>{source}</td>
          </tr>)}</tbody>
        </table>}
        {dependencies.length > 0 && <div className="review-detail-dependencies">
          <h3>关联声明</h3>
          {dependencies.map(({ check, sourceId, source, reason }) => <div key={`${sourceId}:${check}`}>
            <p>{profile.dimensionChecks[check]} · {reason}</p>
            {!compact && source && <Button variant="ghost" size="sm" onClick={() => { app.setFilter('all'); app.select(source.id) }}>查看关联声明</Button>}
          </div>)}
        </div>}
        {compact ? <ul className="review-highlight-checks" aria-label="核验维度">
          {highlightCheckCodes.map(code => {
            const check = finding?.checks?.[code]
            const outcome = check?.outcome ?? 'pending'
            return <li key={code} data-outcome={outcome} title={check?.reason}>
              {profile.dimensionChecks[code]} · {highlightCheckStatus[outcome]}
              {check?.reason && <span className="sr-only">，{check.reason}</span>}
            </li>
          })}
        </ul> : checks.length > 0 && <fieldset className="declaration-checks">
          <legend>逐项复核</legend>
          {checks.map(({ code, check, outcome }) => <label key={code}>
            <input type="checkbox" checked={checked.includes(code)} disabled={app.busy || confirmed || !element.domainReviewable}
              onChange={event => setChecked(current => event.target.checked ? [...current, code] : current.filter(item => item !== code))} />
            <span><b>{profile.dimensionChecks[code]} · {STATUS_NAMES[outcome]}</b><small>{check.reason}</small></span>
          </label>)}
        </fieldset>}
        {!finding && <p className="review-view-empty">暂无当前版本的逐项核验结果。</p>}
      </details>
      {!compact && <>
      <div className={`advise ${sk}`}>
        {element.verdict === 'miss'
          ? '请补充案件原材料，或手动重新关联出处。'
          : element.verdict === 'fail'
            ? '请核对出处并修改声明后复检。'
            : confirmed
              ? element.declaration ? '已记录律师对本条声明的确认。' : '已记录律师对整段的确认。'
              : '请核对出处后确认或添加人工意见。'}
      </div>
      {!element.declaration && <div className="mat-description">确认、驳回和批注均按整段保存。</div>}
      {suggestion && !declined && <div className="advise g">
        <b>已核修改建议</b>
        <p>原文 · {element.original.text.slice(suggestion.start, suggestion.end)}</p>
        <p>建议 · {suggestion.replacement}</p>
        {element.declaration?.verifiedSources?.map((source, index) => <p key={index}>出处 · {source.name} {source.locator}</p>)}
        {pendingEdit !== 'adopt' && <div className="inline-actions">
          <Button className="op" disabled={app.busy} onClick={() => setPendingEdit('adopt')}>采纳建议</Button>
          <Button className="op" disabled={app.busy} onClick={async () => { if (await app.declineSuggestion(element)) setDeclined(true) }}>拒绝建议</Button>
        </div>}
      </div>}
      {confirmation}
      {element.declaration && element.original.note && element.original.note !== declarationNote && <div className="advise g">
        <b>历史整段批注：</b>{element.original.note}
      </div>}
      {declarationNote && !noteOpen && (
        <div className="advise g">
          <b>律师批注：</b>
          {declarationNote}
        </div>
      )}
      {noteOpen && (
        <div className="note-box">
          <Textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder={element.declaration ? '填写本条声明的批注…' : '填写整段批注…'}
          />
          <div className="inline-actions">
            <Button
              className="op pri"
              disabled={app.busy}
              onClick={async () => {
                if (await app.saveNote(element, note)) setNoteOpen(false)
              }}
            >
              保存批注
            </Button>
            <Button className="op" onClick={() => setNoteOpen(false)}>
              取消
            </Button>
          </div>
        </div>
      )}
      {!editing && (
        <div className="ops">
          <Button
            className={`op pri ${confirmed ? 'ok' : ''}`}
            disabled={app.busy || confirmed || Boolean(element.declaration && (!element.domainReviewable || checks.some(({ code }) => !checked.includes(code))))}
            onClick={() => void app.confirm(element, false, checked)}
          >
            {element.declaration ? confirmed ? '已确认声明' : '确认声明' : confirmed ? '✓ 整段已确认' : '确认整段'}
          </Button>
          <Button
            className="op bye"
            disabled={app.busy}
            onClick={() => void app.reject(element)}
          >
            {element.declaration ? '驳回声明' : '驳回整段'}
          </Button>
          <Button
            className="op"
            disabled={app.busy}
            onClick={() => setEditing(true)}
          >
            修改声明
          </Button>
          <Button className="op" onClick={() => app.setReferenceTarget(element)}>
            管理引用
          </Button>
          {element.declaration && element.verdict === 'warn' && <Button className="op" disabled={app.busy}
            onClick={() => void app.toggleWarning(element)}>{element.ignored ? '恢复预警' : '忽略预警'}</Button>}
          {canDelete && pendingEdit !== 'delete' && <Button className="op bye" disabled={app.busy}
            onClick={() => setPendingEdit('delete')}>删除缺源声明</Button>}
          <Button
            className={`op ${noteOpen ? 'on' : ''}`}
            onClick={() => setNoteOpen(!noteOpen)}
          >
            批注
          </Button>
        </div>
      )}
      {(history.length > 0 || localHistory.length > 0) && <details className="audit">
        <summary className="audit-t">操作记录</summary>
        {history.map(item => <div className="audit-i" key={item.id}>
          <time dateTime={item.at}>{new Date(item.at).toLocaleString('zh-CN')}</time>
          <span>{item.actor} · {VERIFICATION_ACTION_LABELS[item.action]}{item.note && ` · ${item.note}`}</span>
        </div>)}
        {localHistory.map(item => <div className="audit-i" key={item.id}>
          <time dateTime={item.t}>{new Date(item.t).toLocaleString('zh-CN')}</time>
          <span>{item.account} · {item.msg}</span>
        </div>)}
      </details>}
      </>}
    </div>
  )
}

export function Workspace() {
  const app = useApp()
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 880px)').matches)
  const [materialsOpen, setMaterialsOpen] = useState<boolean>()
  const [reviewPane, setReviewPane] = useState<{ selected: string; open?: boolean }>({ selected: '' })
  const [summarySelection, setSummarySelection] = useState<{ documentId: string; id: string }>()
  const [memoryCase, setMemoryCase] = useState<string | null>(null)
  const [documentSelection, setDocumentSelection] = useState<AssistantSelection & { documentId: string; left?: number; top?: number }>()
  const [contextSelection, setContextSelection] = useState<AssistantSelection>()
  const main = useRef<HTMLElement>(null)
  const review = useRef<HTMLElement>(null)
  const detailHeading = useRef<HTMLHeadingElement>(null)
  const todoTrigger = useRef<HTMLButtonElement>(null)
  const assistantWasOpen = useRef(false)
  const { busy, certificate, element, setAssistantRequest, assistantRequest } = app
  const [backgroundAssistantRequest, setBackgroundAssistantRequest] = useState<typeof assistantRequest>(null)
  const caseId = app.project?.id
  const documentId = app.docId
  const selection = documentSelection?.documentId === documentId ? documentSelection : undefined
  const memory = Boolean(caseId && memoryCase === caseId)
  const selected = element?.id ?? ''
  const compactReview = Boolean(selected && summarySelection?.documentId === documentId && summarySelection.id === selected)
  const assistantTab = Boolean(assistantRequest && assistantRequest !== backgroundAssistantRequest)
  const rightOpen = !narrow || assistantTab || Boolean(selected && selected !== reviewPane.selected) || reviewPane.open === true
  const leftOpen = !narrow || (materialsOpen && !rightOpen)
  const showHighlightDetail = compactReview && rightOpen && !assistantTab

  useEffect(() => whenUiIdle(() => { void Promise.all([loadCaseMemory(), loadWorkspaceAssistant()]).catch(() => {}) }), [])
  useEffect(() => {
    const media = window.matchMedia('(max-width: 880px)')
    const update = (event: MediaQueryListEvent) => setNarrow(event.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  useEffect(() => {
    const updateSelection = () => {
      const current = readDocumentSelection(main.current, certificate)
      if (!current) { setDocumentSelection(undefined); return }
      const { body, range, ...content } = current
      const rect = range.getBoundingClientRect()
      const canvas = body.closest('.document-editor-canvas')?.getBoundingClientRect()
      const visible = canvas && rect.bottom > canvas.top && rect.top < canvas.bottom && rect.width > 0
      if (!visible) { setDocumentSelection({ documentId, ...content }); return }
      const top = rect.top - canvas.top >= 42 ? rect.top - 6 : rect.bottom + 42
      const left = Math.min(innerWidth - 122, Math.max(122, rect.left + rect.width / 2))
      setDocumentSelection({ documentId, ...content, left, top })
    }
    document.addEventListener('selectionchange', updateSelection)
    window.addEventListener('resize', updateSelection)
    window.addEventListener('scroll', updateSelection, true)
    return () => {
      document.removeEventListener('selectionchange', updateSelection)
      window.removeEventListener('resize', updateSelection)
      window.removeEventListener('scroll', updateSelection, true)
    }
  }, [documentId, certificate])
  useEffect(() => {
    if (assistantWasOpen.current && !assistantRequest) {
      const current = window.getSelection()
      if (current && main.current?.querySelector('.whole-document-content')?.contains(current.anchorNode)) current.removeAllRanges()
    }
    assistantWasOpen.current = Boolean(assistantRequest)
  }, [assistantRequest])
  useEffect(() => {
    if (!selected || memory) return
    const frame = requestAnimationFrame(() => {
      const matches = main.current?.querySelectorAll<HTMLElement>('[data-el]')
      const mark = Array.from(matches ?? []).find(node => node.dataset.el === selected)
      if (mark) mark.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    })
    return () => cancelAnimationFrame(frame)
  }, [selected, memory])
  useEffect(() => {
    const shortcuts = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || busy || event.defaultPrevented || event.isComposing
        || document.querySelector('[data-state="open"][role="dialog"]')) return
      const key = event.key.toLowerCase()
      if (key === 'j' && !event.shiftKey) {
        event.preventDefault()
        setMemoryCase(null)
        if (assistantTab && !memory) setAssistantRequest(null)
        else if (assistantRequest && !selection) setBackgroundAssistantRequest(null)
        else setAssistantRequest({ mode: 'case', quote: selection?.text, anchor: selection?.anchor, declarationIds: selection?.declarationIds })
      }
    }
    window.addEventListener('keydown', shortcuts)
    return () => window.removeEventListener('keydown', shortcuts)
  }, [busy, selection, assistantRequest, assistantTab, setAssistantRequest, memory])
  if (!app.project) return null
  const ask = (prompt?: string, selected?: AssistantSelection, mode: (typeof selectionActions)[number][0] = 'case') => {
    setMemoryCase(null)
    setAssistantRequest({ mode, prompt: prompt ?? selected?.text, quote: selected?.text, anchor: selected?.anchor, declarationIds: selected?.declarationIds })
    if (selected) window.getSelection()?.removeAllRanges()
  }
  const openAssistant = () => {
    if (assistantRequest) setBackgroundAssistantRequest(null)
    else ask()
  }
  const assistantIcon = <img className="workspace-assistant-icon" src={walnut} alt="" />
  const openReview = (id: string, trigger: HTMLButtonElement, manual = false) => {
    todoTrigger.current = trigger
    setSummarySelection(manual ? undefined : { documentId, id })
    app.setFilter('all')
    app.select(id)
    requestAnimationFrame(() => detailHeading.current?.focus({ preventScroll: true }))
  }
  const returnToTodos = () => {
    const trigger = todoTrigger.current
    todoTrigger.current = null
    setSummarySelection(undefined)
    setReviewPane({ selected: '', open: true })
    app.select('')
    requestAnimationFrame(() => {
      const target = trigger?.isConnected ? trigger : review.current?.querySelector<HTMLElement>('#review-todos-heading')
      target?.focus({ preventScroll: true })
    })
  }

  return (
    <div className="page active" id="pg-ws">
      <Topbar memory={memory} onMemory={() => setMemoryCase(memory ? null : caseId ?? null)} />
      <EssentialDialogs />
      {memory && <Suspense fallback={<div className="boot-status" role="status">正在读取案件记忆…</div>}>
        <CaseMemory key={caseId} onBack={() => setMemoryCase(null)} onDraft={() => {
          setMemoryCase(null)
          setAssistantRequest({ mode: 'document' })
        }} onAssistant={prompt => {
          setMemoryCase(null)
          setAssistantRequest({ mode: 'case', prompt })
        }} />
      </Suspense>}
      <div className={`workspace-content ${memory ? 'workspace-content-hidden' : ''}`}>
        <div className={`ws ${leftOpen ? '' : 'no-l'} ${rightOpen ? '' : 'no-r'}${showHighlightDetail ? ' has-highlight-detail' : ''}`}>
          <WorkspaceMaterials key={caseId} />
          <main className="pane-c" ref={main}>
            <DocumentHeader paneControls={narrow && (
              <div className="workspace-pane-controls">
                <Button variant="ghost" size="icon" aria-label="案件材料" title="案件材料" aria-controls="workspace-materials"
                  aria-expanded={Boolean(leftOpen)} onClick={() => {
                    setBackgroundAssistantRequest(assistantRequest)
                    setMaterialsOpen(!leftOpen)
                    setReviewPane({ selected, open: false })
                  }}><PanelLeft size={16} /></Button>
                <Button variant="ghost" size="icon" aria-label="核验结果" title="核验结果" aria-controls="workspace-review"
                  aria-expanded={rightOpen} onClick={() => {
                    setBackgroundAssistantRequest(assistantRequest)
                    setReviewPane({ selected, open: !rightOpen })
                    setMaterialsOpen(false)
                  }}><PanelRight size={16} /></Button>
                {!rightOpen && <Button variant="ghost" size="icon" aria-label="AI 助手" title="AI 助手"
                  aria-controls="workspace-review" onClick={openAssistant}>{assistantIcon}</Button>}
              </div>
            )} />
            <ContextMenu.Root key={documentId} onOpenChange={open => { if (open) setContextSelection(readDocumentSelection(main.current, certificate)) }}>
              <ContextMenu.Trigger asChild><div className="workspace-document-body" onClick={event => {
                const target = event.target
                if (!(target instanceof Element) || !target.closest('.whole-document-content')) return
                const id = target.closest<HTMLElement>('[data-el]')?.dataset.el ?? ''
                todoTrigger.current = null
                setSummarySelection(id ? { documentId, id } : undefined)
                if (id) {
                  setBackgroundAssistantRequest(assistantRequest)
                  if (narrow) setReviewPane({ selected: id, open: true })
                }
                app.select(id)
              }}>
                <DocumentPaper />
              </div></ContextMenu.Trigger>
              <ContextMenu.Portal><ContextMenu.Content className="new-case-menu workspace-document-menu">
                <ContextMenu.Item className="context-action" disabled={busy}
                  onSelect={() => ask(contextSelection ? selectionActions[0][2] : undefined, contextSelection)}>
                  {contextSelection ? '引用选中内容问 AI' : '打开 AI 助手'}
                </ContextMenu.Item>
                {selectionActions.slice(1).map(([mode, label, prompt]) => <ContextMenu.Item key={mode} className="context-action"
                  disabled={busy || (mode === 'rewrite' && !contextSelection)} onSelect={() => ask(contextSelection ? prompt : undefined, contextSelection, mode)}>
                  {label}
                </ContextMenu.Item>)}
                <ContextMenu.Item className="context-action" disabled={busy || !certificate?.verification?.dirty || !certificate.linkageInputKey}
                  onSelect={async () => { if (await app.prepareDocument()) void app.recheckDirty() }}>局部重核</ContextMenu.Item>
              </ContextMenu.Content></ContextMenu.Portal>
            </ContextMenu.Root>
            {!busy && !memory && selection?.top !== undefined && <div className="document-selection-actions" role="group" aria-label="选中文字的操作"
              style={{ top: selection.top, left: selection.left }} onMouseDown={event => event.preventDefault()}>
              {selectionActions.map(([mode, label, prompt]) => <Button key={mode} variant="ghost" size="sm"
                onClick={() => ask(prompt, selection, mode)}>{label}</Button>)}
            </div>}
          </main>
          <aside className="pane-r" id="workspace-review" aria-label="核验结果与 AI 助手" ref={review}>
            <Tabs className="workspace-right-tabs" value={assistantTab ? 'assistant' : 'review'} activationMode="manual"
              onValueChange={value => {
                if (value === 'assistant') openAssistant()
                else {
                  setBackgroundAssistantRequest(assistantRequest)
                  setReviewPane({ selected, open: true })
                }
              }}>
              <TabsList className="workspace-right-tablist" variant="line" aria-label="右侧栏">
                <TabsTrigger value="review">核验结果</TabsTrigger>
                <TabsTrigger value="assistant" aria-label="AI 助手" title="AI 助手">
                  {assistantIcon}
                </TabsTrigger>
              </TabsList>
              <TabsContent className="workspace-right-panel" value="review" forceMount hidden={assistantTab}>
                <ReviewTodos key={app.docId} hidden={Boolean(element)} onOpen={openReview} />
                {element && <>
                  <div className="review-pane-head review-detail-bar">
                    <h2 ref={detailHeading} tabIndex={-1}>本句核验</h2>
                    <div className="flex flex-wrap justify-end gap-1">
                      {!compactReview && <Button variant="ghost" size="sm"
                        onClick={() => setSummarySelection({ documentId, id: element.id })}>返回核验详情</Button>}
                      <Button variant="ghost" size="sm" onClick={returnToTodos}>返回待办</Button>
                    </div>
                  </div>
                  <div className="rp" key={element.id}>
                    <LinkageCard key={`${element.verificationRevision ?? ''}:${compactReview}`} element={element} compact={compactReview} />
                  </div>
                </>}
                {!compactReview && <div className="case-review-bar">
                  <span>人工审阅 {app.caseReview.total - app.caseReview.unreviewed}/{app.caseReview.total} 段 · 红灯 {app.caseReview.red} 项</span>
                  <Button className="btn btn-gh btn-sm" onClick={async () => { if (await app.prepareDocument()) app.setReviewListOpen(true) }} disabled={!certificate}>审阅清单</Button>
                  <Button className="btn btn-gh btn-sm" disabled={busy || !app.caseReview.ready} onClick={async () => { if (await app.prepareDocument()) void app.markCaseReady() }}>标记案件完成</Button>
                  {app.workspace?.cases.find(item => item.id === caseId)?.status === 'ready' && app.caseReview.ready && <span>待归档</span>}
                </div>}
              </TabsContent>
              <TabsContent className="workspace-right-panel" value="assistant" forceMount hidden={!assistantTab}>
                {assistantRequest && <Suspense fallback={<div className="assistant-panel-loading" role="status">正在加载助手…</div>}>
                  <WorkspaceAssistant key={caseId} visible={assistantTab && !memory} />
                </Suspense>}
              </TabsContent>
            </Tabs>
          </aside>
        </div>
      </div>
    </div>
  )
}
