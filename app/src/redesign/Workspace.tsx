import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react'
import type { CheckCode } from '../../../server/src/intelligence/verification/protocol'
import { declarationEditRange } from '../../../server/src/intelligence/verification/review-status.ts'
import { Check, ChevronDown, PanelLeft, PanelRight, Pencil, Sparkles } from 'lucide-react'
import { api } from '../api'
import { Button } from './components/ui/button'
import { Textarea } from './components/ui/textarea'
import { Tabs, TabsList, TabsTrigger } from './components/ui/tabs'
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
import { documentBadge } from './reviewOverview'
import { CaseReportButton } from './CaseReportButton'
import { CASE_MATCH_LABELS, caseCitations } from './caseResearchReport'

const CaseMemory = lazy(() => import('./CaseMemory').then(module => ({ default: module.CaseMemory })))
const WorkspaceAssistant = lazy(() => import('./WorkspaceAssistant').then(module => ({ default: module.WorkspaceAssistant })))

function Topbar({ memory, onMemory }: { memory: boolean; onMemory: () => void }) {
  const app = useApp()
  const project = app.project
  if (!project) return null
  const folder = app.workspace?.cases.find(item => item.id === project.id)
  const memoryRecord = app.workspace?.caseContextMemories.find(item => item.caseId === project.id)
  const basics = folder?.basicInfo
  const parties = (['plaintiff', 'defendant'] as const).flatMap(side => {
    const name = basics?.[side]
    const ours = basics?.ourSide === side
    if (!name && !ours) return []
    const label = side === 'plaintiff' ? '原告' : '被告'
    return [`${label}${ours ? '（我方）' : ''}${name ? `：${name}` : ''}`]
  })
  const identity = [...(parties.length ? parties : (memoryRecord?.parties ?? []).slice(0, 2)), basics?.caseNumber, basics?.court || folder?.description]
    .filter(Boolean).join(' ｜ ')
  return (
    <div className="topbar workspace-topbar">
      <BrandHome onHome={async () => { if (await app.flushDocument()) app.setPage('home') }} />
      <DropdownMenu>
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
      </DropdownMenu>
      {identity && <span className="workspace-case-identity" title={identity}>{identity}</span>}
      <Button className="btn btn-gh btn-sm workspace-report-button" disabled={!app.certificate || app.busy}
        onClick={async () => { if (await app.prepareDocument()) { app.setAssistantRequest(null); app.setPage('report') } }}>导出文书</Button>
      <Button className="btn btn-pri btn-sm" disabled={app.busy} onClick={onMemory}>{memory ? '返回工作台' : '案件记忆'}</Button>
    </div>
  )
}

function DocumentHeader({ onAssistant, selectedQuote, paneControls, editing, onEdit }: {
  onAssistant: () => void; selectedQuote: string; paneControls: ReactNode; editing: boolean; onEdit: () => void
}) {
  const app = useApp()
  const project = app.project!
  const certificate = app.certificate
  return <>
    <div className="workspace-doc-strip">
      {paneControls}
      <span className="workspace-doc-count">文书 {project.docs.length}</span>
      <Tabs value={app.docId} activationMode="manual" className="doc-switch"
        onValueChange={async id => { if (await app.flushDocument()) app.switchDocument(id) }}>
        <TabsList className="new-doc-tabs" aria-label="案件文书">
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
      <Button className="btn btn-gh btn-sm" disabled={app.busy} aria-expanded={Boolean(app.assistantRequest)} onClick={onAssistant}>
        <Sparkles size={14} />{selectedQuote && !app.assistantRequest ? '问 AI' : 'AI 助手'}
      </Button>
    </div>
    {certificate && <div className="ctool workspace-document-heading">
      <h1>{certificate.title}</h1>
      {certificate.linkageStale && <span className="workspace-stale">待重核</span>}
      <DocumentTypeSelect value={certificate.docKey} disabled={app.busy} label="当前文书类型" onChange={docKey => {
        void app.run(async () => { await api.classifyCertificate(certificate.id, docKey) }, '文书类型已保存，请重新核验')
      }} />
      <DropdownMenu>
        <DropdownMenuTrigger asChild><Button variant="ghost" size="sm">高亮筛选 <ChevronDown size={12} /></Button></DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="new-case-menu assistant-more-menu">
          {([['all', '全部'], ['fail', '红灯'], ['warn', '预警'], ['pass', '存在支持']] as const).map(([key, label]) =>
            <DropdownMenuItem key={key} onSelect={() => { app.select(''); app.setFilter(key) }}>{app.filter === key ? '✓ ' : ''}{label}</DropdownMenuItem>)}
        </DropdownMenuContent>
      </DropdownMenu>
      <Button variant="outline" size="sm" className="workspace-edit-toggle" aria-pressed={editing} disabled={app.busy} onClick={onEdit}>
        {editing ? <Check size={14} /> : <Pencil size={14} />}{editing ? '完成编辑' : '在线编辑'}
      </Button>
      {app.certificate?.verification?.dirty && app.certificate.linkageInputKey && <Button className="btn btn-gh btn-sm" disabled={app.busy}
        onClick={async () => { if (await app.prepareDocument()) void app.recheckDirty() }}>局部重核</Button>}
      <Button className="btn btn-pri btn-sm" disabled={app.busy}
        onClick={async () => { if (await app.prepareDocument()) void app.verify() }}>{app.certificate?.verification?.revision ? '全文重核' : 'AI 核验'}</Button>
    </div>}
  </>
}

function focusDocument() {
  document.querySelector<HTMLElement>('#pg-ws .whole-document-content')?.focus()
}

const selectionActions = [
  ['case', '问 AI', '请核对所选文字的事实与引用依据。'],
  ['rewrite', '改写', '请把所选文字改写得更严谨。'],
  ['law', '查法条'],
  ['similar', '查类案'],
] as const

function readDocumentSelection(container: HTMLElement | null) {
  const body = container?.querySelector('.whole-document-content')
  const selection = window.getSelection()
  if (!body || !selection || selection.isCollapsed || !body.contains(selection.anchorNode) || !body.contains(selection.focusNode)) return
  const text = selection.toString().trim()
  if (text) return { body, text, range: selection.getRangeAt(0) }
}

function LinkageCard({ element }: { element: ReviewElement }) {
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
  const checks = Object.entries(element.declaration?.checks ?? {}).flatMap(([code, check]) => check.outcome === 'not-applicable'
    ? [] : [{ code: code as CheckCode, check, outcome: check.outcome }])
  const suggestion = element.declaration && element.sources.length > 0 && declarationEditRange(element.original.text, element.declaration, 'adopt')
  const canDelete = element.verdict === 'miss' && element.declaration && declarationEditRange(element.original.text, element.declaration, 'delete')
  const sk = ['pass', 'note'].includes(element.verdict)
    ? 'ok'
    : element.verdict === 'warn'
      ? 'warn'
      : 'bad'
  const names = { l1: '案件原材料', l2: '法条', l3: '案例', l0: '未联动' }
  const caseRows = caseCitations([element], app.workspace?.knowledgeCases ?? [])
  const calibration = element.declaration?.confidenceCalibration
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
  return (
    <div className={`rc st-${sk}`}>
      <div className="rc-h">
        <span className={`src-dot ${element.src}`} />
        <span className="rc-type">
          {element.type} · {names[element.src]}
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
      <div className="rc-q">
        {editing ? (
          <>
            <Textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              aria-label="修改声明"
            />
            <div className="inline-actions">
              <Button
                className="op pri"
                disabled={app.busy}
                onClick={async () => {
                  if (await app.edit(element, text)) setEditing(false)
                }}
              >
                保存并局部重核
              </Button>
              <Button
                className="op"
                disabled={app.busy}
                onClick={() => {
                  setEditing(false)
                  setText(element.quote)
                }}
              >
                取消
              </Button>
            </div>
          </>
        ) : (
          element.quote
        )}
      </div>
      <div className="rc-reason">
        <b>一句话结论：</b>
        {element.reason}
      </div>
      <div className="workspace-linkage-assistant">
        <Button variant="ghost" size="sm" disabled={app.busy} onClick={() => app.setAssistantRequest({
          mode: 'case', prompt: '请根据卷内材料核对这条声明，并指出需要补证的事项。', quote: element.quote,
        })}><Sparkles size={14} />问 AI</Button>
        {!!caseRows.length && <CaseReportButton rows={caseRows}>导出本句案例</CaseReportButton>}
      </div>
      {element.conf !== null && calibration ? (
        <>
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
        </>
      ) : <p className="confidence-details">结论置信度 · 暂无校准数据</p>}
      {element.sources.map((source, index) => (
        <button
          className="rc-loc"
          key={`${source.targetId}-${index}`}
          onClick={() => app.setDrawer(source)}
        >
          <span className={`src-dot ${source.st}`} />
          <span className="nm">{source.name}</span>
          <span className="mat-description">· {source.loc}</span>
          <span className="source-preview-link">预览 →</span>
        </button>
      ))}
      {!element.sources.length && (
        <div className="rc-loc text-fail">
          <span className="src-dot color-fail" />
          未找到出处 · AI 不编造
        </div>
      )}
      {element.verdict === 'fail' && element.sources[0]?.quote && (
        <div className="diff">
          <div className="diff-r">
            <div className="h">对照</div>
            <div className="h">文书声明</div>
            <div className="h">出处原文</div>
          </div>
          <div className="diff-r">
            <div className="h">内容</div>
            <div className="bad">{element.quote}</div>
            <div className="good">{element.sources[0].quote}</div>
          </div>
        </div>
      )}
      <div className={`advise ${sk}`}>
        {element.verdict === 'miss'
          ? '请补充案件原材料，或手动重新关联出处。'
          : element.verdict === 'fail'
            ? '请核对出处并修改声明后复检。'
            : confirmed
              ? element.declaration ? '已记录律师对本条声明的确认。' : '已记录律师对整段的确认。'
              : '请核对出处后确认或添加人工意见。'}
      </div>
      {checks.length > 0 && <fieldset className="declaration-checks">
        <legend>逐项复核</legend>
        {checks.map(({ code, check, outcome }) => <label key={code}>
          <input type="checkbox" checked={checked.includes(code)} disabled={app.busy || confirmed || !element.domainReviewable}
            onChange={event => setChecked(current => event.target.checked ? [...current, code] : current.filter(item => item !== code))} />
          <span><b>{code} · {STATUS_NAMES[outcome]}</b><small>{check.reason}</small></span>
        </label>)}
      </fieldset>}
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
      {pendingEdit && <div className="advise y" role="group" aria-label="确认修改声明">
        <p>{pendingEdit === 'adopt' ? '确认替换上方原文，保存后进入待重核。' : `确认从正文移除「${element.quote}」，原文和操作将保留在报告中。`}</p>
        <Button className="op pri" disabled={app.busy} onClick={async () => {
          if (await app.applyDeclarationEdit(element, pendingEdit)) setPendingEdit(null)
        }}>{pendingEdit === 'adopt' ? '确认替换' : '确认删除'}</Button>
        <Button className="op" disabled={app.busy} onClick={() => setPendingEdit(null)}>取消</Button>
      </div>}
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
      <div className="audit">
        <div className="audit-t">本机操作记录</div>
        {app.audits
          .filter((item) => item.certificateId === element.certificateId && item.paragraphId === element.paragraphId)
          .map((item) => (
            <div className="audit-i" key={item.id}>
              <time>{new Date(item.t).toLocaleTimeString('zh-CN')}</time>
              <span>{item.msg}</span>
            </div>
          ))}
      </div>
    </div>
  )
}

export function Workspace() {
  const app = useApp()
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 880px)').matches)
  const [materialsOpen, setMaterialsOpen] = useState<boolean>()
  const [reviewPane, setReviewPane] = useState<{ selected: string; open?: boolean }>({ selected: '' })
  const [memoryCase, setMemoryCase] = useState<string | null>(null)
  const [editingDocument, setEditingDocument] = useState('')
  const [documentSelection, setDocumentSelection] = useState<{ documentId: string; text: string; left?: number; top?: number }>()
  const [contextQuote, setContextQuote] = useState('')
  const main = useRef<HTMLElement>(null)
  const assistantWasOpen = useRef(false)
  const { busy, certificate, element, setAssistantRequest, assistantRequest } = app
  const caseId = app.project?.id
  const documentId = app.docId
  const editing = Boolean(certificate && editingDocument === documentId)
  const selection = documentSelection?.documentId === documentId ? documentSelection : undefined
  const selectedQuote = selection?.text ?? ''
  const memory = Boolean(caseId && memoryCase === caseId)
  const selected = element?.id ?? ''
  const rightOpen = !narrow || Boolean(selected && selected !== reviewPane.selected) || reviewPane.open === true
  const leftOpen = !narrow || (materialsOpen && !rightOpen)

  useEffect(() => {
    const media = window.matchMedia('(max-width: 880px)')
    const update = (event: MediaQueryListEvent) => setNarrow(event.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  useEffect(() => {
    const updateSelection = () => {
      const current = readDocumentSelection(main.current)
      if (!current) { setDocumentSelection(undefined); return }
      const { body, text, range } = current
      const rect = range.getBoundingClientRect()
      const canvas = body.closest('.document-editor-canvas')?.getBoundingClientRect()
      const visible = canvas && rect.bottom > canvas.top && rect.top < canvas.bottom && rect.width > 0
      if (!visible) { setDocumentSelection({ documentId, text }); return }
      const top = rect.top - canvas.top >= 42 ? rect.top - 6 : rect.bottom + 42
      const left = Math.min(innerWidth - 122, Math.max(122, rect.left + rect.width / 2))
      setDocumentSelection({ documentId, text, left, top })
    }
    document.addEventListener('selectionchange', updateSelection)
    window.addEventListener('resize', updateSelection)
    window.addEventListener('scroll', updateSelection, true)
    return () => {
      document.removeEventListener('selectionchange', updateSelection)
      window.removeEventListener('resize', updateSelection)
      window.removeEventListener('scroll', updateSelection, true)
    }
  }, [documentId])
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
        setAssistantRequest(assistantRequest && !memory ? null : { mode: 'case', quote: selectedQuote || undefined })
      }
      if (key === 'e' && event.shiftKey && certificate && !memory) {
        event.preventDefault()
        setEditingDocument(certificate.id)
        focusDocument()
      }
    }
    window.addEventListener('keydown', shortcuts)
    return () => window.removeEventListener('keydown', shortcuts)
  }, [busy, certificate, selectedQuote, assistantRequest, setAssistantRequest, memory])
  if (!app.project) return null
  const ask = (prompt?: string, quote?: string, mode: (typeof selectionActions)[number][0] = 'case') => {
    setMemoryCase(null)
    setAssistantRequest({ mode, prompt: prompt ?? quote, quote })
    if (quote) window.getSelection()?.removeAllRanges()
  }
  const enterEdit = () => { setEditingDocument(documentId); focusDocument() }

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
          setAssistantRequest({ mode: 'case', prompt, position: !prompt })
        }} />
      </Suspense>}
      <div className={`workspace-content ${memory ? 'workspace-content-hidden' : ''}`}>
        <div className={`ws ${leftOpen ? '' : 'no-l'} ${rightOpen ? '' : 'no-r'}`}>
          <WorkspaceMaterials key={caseId} />
          <main className={`pane-c${editing ? ' is-editing-document' : ''}`} ref={main}>
            <DocumentHeader selectedQuote={selectedQuote} editing={editing} onEdit={async () => {
              if (editing) {
                if (await app.prepareDocument()) setEditingDocument('')
              } else {
                enterEdit()
              }
            }} paneControls={narrow && (
              <div className="workspace-pane-controls">
                <Button variant="ghost" size="icon" aria-label="案件材料" title="案件材料" aria-controls="workspace-materials"
                  aria-expanded={Boolean(leftOpen)} onClick={() => {
                    setMaterialsOpen(!leftOpen)
                    setReviewPane({ selected, open: false })
                  }}><PanelLeft size={16} /></Button>
                <Button variant="ghost" size="icon" aria-label="核验结果" title="核验结果" aria-controls="workspace-review"
                  aria-expanded={rightOpen} onClick={() => {
                    setReviewPane({ selected, open: !rightOpen })
                    setMaterialsOpen(false)
                  }}><PanelRight size={16} /></Button>
              </div>
            )} onAssistant={() => {
              if (selectedQuote) ask('请核对所选文字的事实与引用依据。', selectedQuote)
              else if (assistantRequest) setAssistantRequest(null)
              else ask()
            }} />
            {editing && <div className="workspace-editing-notice" role="status">
              正在编辑文书。保存改动后，可重新核验受影响的声明。
            </div>}
            <ContextMenu.Root key={documentId} onOpenChange={open => { if (open) setContextQuote(readDocumentSelection(main.current)?.text ?? '') }}>
              <ContextMenu.Trigger asChild><div className="workspace-document-body">
                <DocumentPaper editing={editing} />
              </div></ContextMenu.Trigger>
              <ContextMenu.Portal><ContextMenu.Content className="new-case-menu workspace-document-menu">
                <ContextMenu.Item className="context-action" disabled={busy}
                  onSelect={() => ask(contextQuote ? selectionActions[0][2] : undefined, contextQuote || undefined)}>
                  {contextQuote ? '引用选中内容问 AI' : '打开 AI 助手'}
                </ContextMenu.Item>
                {selectionActions.slice(1).map(([mode, label, prompt]) => <ContextMenu.Item key={mode} className="context-action"
                  disabled={busy || (mode === 'rewrite' && !contextQuote)} onSelect={() => ask(contextQuote ? prompt : undefined, contextQuote || undefined, mode)}>
                  {label}
                </ContextMenu.Item>)}
                <ContextMenu.Item className="context-action" disabled={busy || !certificate?.verification?.dirty || !certificate.linkageInputKey}
                  onSelect={async () => { if (await app.prepareDocument()) void app.recheckDirty() }}>局部重核</ContextMenu.Item>
                <ContextMenu.Item className="context-action" disabled={busy || !certificate || editing} onSelect={enterEdit}>进入编辑</ContextMenu.Item>
              </ContextMenu.Content></ContextMenu.Portal>
            </ContextMenu.Root>
            {!busy && !memory && selection?.top !== undefined && <div className="document-selection-actions" role="group" aria-label="选中文字的操作"
              style={{ top: selection.top, left: selection.left }} onMouseDown={event => event.preventDefault()}>
              {selectionActions.map(([mode, label, prompt]) => <Button key={mode} variant="ghost" size="sm"
                onClick={() => ask(prompt, selection.text, mode)}>{label}</Button>)}
            </div>}
            {assistantRequest && <Suspense fallback={<div className="assistant-panel-loading" role="status">正在加载助手…</div>}>
              <WorkspaceAssistant key={caseId} />
            </Suspense>}
          </main>
          <aside className="pane-r" id="workspace-review" aria-label="核验结果">
            <ReviewTodos key={app.docId} hidden={Boolean(element)} />
            {element && <>
              <div className="review-pane-head review-detail-bar"><h2>本句核验</h2><Button variant="ghost" size="sm" onClick={() => {
                setReviewPane({ selected: '', open: true })
                app.select('')
              }}>返回待办</Button></div>
              <div className="rp"><LinkageCard key={`${element.id}:${element.verificationRevision ?? ''}`} element={element} /></div>
            </>}
            <div className="case-review-bar">
              <span>人工审阅 {app.caseReview.total - app.caseReview.unreviewed}/{app.caseReview.total} 段 · 红灯 {app.caseReview.red} 项</span>
              <Button className="btn btn-gh btn-sm" onClick={async () => { if (await app.prepareDocument()) app.setReviewListOpen(true) }} disabled={!certificate}>审阅清单</Button>
              <Button className="btn btn-gh btn-sm" disabled={busy || !app.caseReview.ready} onClick={async () => { if (await app.prepareDocument()) void app.markCaseReady() }}>标记案件完成</Button>
              {app.workspace?.cases.find(item => item.id === caseId)?.status === 'ready' && app.caseReview.ready && <span>待归档</span>}
            </div>
          </aside>
        </div>
      </div>
    </div>
  )
}
