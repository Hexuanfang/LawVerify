import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, PanelLeft, PanelRight } from 'lucide-react'
import { api } from '../api'
import walnut from '../features/auth/walnut.jpg'
import { whenUiIdle } from '../redesign-loader'
import { Button } from './components/ui/button'
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
import { DocumentTypeSelect } from './DocumentTypeSelect'
import { WorkspaceMaterials } from './WorkspaceMaterials'
import { ReviewTodos } from './ReviewTodos'
import { ReviewSentence } from './ReviewSentence'
import { documentBadge } from './reviewOverview'
import type { DocumentSelection } from './documentSelection'

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
    const name = basics?.[side]
    const ours = basics?.ourSide === side
    if (!name && !ours) return []
    const label = side === 'plaintiff' ? '原告' : '被告'
    return [`${label}${ours ? '（我方）' : ''}${name ? `：${name}` : ''}`]
  })
  const identity = [
    ...(parties.length ? parties : (memoryRecord?.parties ?? []).slice(0, 2)), basics?.caseNumber, basics?.court || folder?.description,
  ].filter(Boolean).join(' ｜ ')
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
      <Button className="btn btn-pri btn-sm" disabled={app.busy} onClick={onMemory}>{memory ? '返回工作台' : '案件记忆'}</Button>
    </div>
  )
}

function DocumentHeader({ paneControls }: { paneControls: ReactNode }) {
  const app = useApp()
  const project = app.project!
  const certificate = app.certificate
  return <header className="workspace-document-header">
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
      <h1 className="sr-only">{certificate.title}</h1>
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
    </div>}
  </header>
}

const selectionActions = [
  ['case', '问 AI', '请核对所选文字的事实与引用依据。'],
  ['rewrite', '改写', '请把所选文字改写得更严谨。'],
  ['law', '查法条'],
  ['similar', '查类案'],
] as const

type AssistantSelection = Pick<DocumentSelection, 'text' | 'declarationIds' | 'anchor'>

export function Workspace() {
  const app = useApp()
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 880px)').matches)
  const [materialsOpen, setMaterialsOpen] = useState<boolean>()
  const [reviewPane, setReviewPane] = useState<{ selected: string; open?: boolean }>({ selected: '' })
  const [memoryCase, setMemoryCase] = useState<string | null>(null)
  const [documentSelection, setDocumentSelection] = useState<AssistantSelection & { documentId: string; left?: number; top?: number }>()
  const [contextSelection, setContextSelection] = useState<AssistantSelection>()
  const main = useRef<HTMLElement>(null)
  const review = useRef<HTMLElement>(null)
  const clearDocumentSelection = useRef<(() => void) | null>(null)
  const detailHeading = useRef<HTMLHeadingElement>(null)
  const assistantWasOpen = useRef(false)
  const { busy, certificate, element, setAssistantRequest, assistantRequest } = app
  const [backgroundAssistantRequest, setBackgroundAssistantRequest] = useState<typeof assistantRequest>(null)
  const caseId = app.project?.id
  const documentId = app.docId
  const selection = documentSelection?.documentId === documentId ? documentSelection : undefined
  const memory = Boolean(caseId && memoryCase === caseId)
  const selected = element?.id ?? ''
  const assistantTab = Boolean(assistantRequest && assistantRequest !== backgroundAssistantRequest)
  const rightOpen = !narrow || assistantTab || Boolean(selected && selected !== reviewPane.selected) || reviewPane.open === true
  const leftOpen = !narrow || (materialsOpen && !rightOpen)
  const hasReviewResults = app.elements.length > 0 && Boolean(certificate?.linkageInputKey)
    && (!certificate?.linkageStale || Boolean(certificate.verification?.dirty))

  useEffect(() => whenUiIdle(() => { void Promise.all([loadCaseMemory(), loadWorkspaceAssistant()]).catch(() => {}) }), [])
  useEffect(() => {
    const media = window.matchMedia('(max-width: 880px)')
    const update = (event: MediaQueryListEvent) => setNarrow(event.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  const updateSelection = (current?: DocumentSelection) => {
    if (!current) { setDocumentSelection(undefined); return }
    const { rect, ...content } = current
    const canvas = main.current?.querySelector('.document-editor-canvas')?.getBoundingClientRect()
    if (!rect || !canvas || rect.bottom <= canvas.top || rect.top >= canvas.bottom || !rect.width) {
      setDocumentSelection({ documentId, ...content }); return
    }
    const top = rect.top - canvas.top >= 42 ? rect.top - 6 : rect.bottom + 42
    const left = Math.min(innerWidth - 122, Math.max(122, rect.left + rect.width / 2))
    setDocumentSelection({ documentId, ...content, left, top })
  }
  useEffect(() => {
    if (assistantWasOpen.current && !assistantRequest) clearDocumentSelection.current?.()
    assistantWasOpen.current = Boolean(assistantRequest)
  }, [assistantRequest])
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
  const ask = (prompt?: string, selected?: AssistantSelection, mode: (typeof selectionActions)[number][0] | 'document' = 'case') => {
    setMemoryCase(null)
    setAssistantRequest({ mode, prompt: prompt ?? selected?.text, quote: selected?.text, anchor: selected?.anchor, declarationIds: selected?.declarationIds })
    if (selected) clearDocumentSelection.current?.()
  }
  const openAssistant = () => {
    if (assistantRequest) setBackgroundAssistantRequest(null)
    else ask()
  }
  const assistantIcon = <img className="workspace-assistant-icon" src={walnut} alt="" />
  const openReview = (id: string) => {
    app.setFilter('all')
    app.select(id)
    requestAnimationFrame(() => detailHeading.current?.focus({ preventScroll: true }))
  }
  const clearReview = () => {
    setReviewPane({ selected: '', open: true })
    app.select('')
    requestAnimationFrame(() => {
      const pane = review.current
      const card = Array.from(pane?.querySelectorAll<HTMLButtonElement>('.review-todo-card') ?? [])
        .find(button => button.dataset.elementId === selected && button.getClientRects().length)
      const target = card ?? pane?.querySelector<HTMLElement>('#review-todos-heading')
      target?.focus()
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
        <div className={`ws ${leftOpen ? '' : 'no-l'} ${rightOpen ? '' : 'no-r'}`}>
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
            <ContextMenu.Root key={documentId} onOpenChange={open => { if (open) setContextSelection(selection) }}>
              <ContextMenu.Trigger asChild><div className="workspace-document-body">
                <DocumentPaper onSelectionChange={updateSelection} onClearSelectionReady={clear => { clearDocumentSelection.current = clear }} onReviewSelect={id => {
                  if (id) {
                    setBackgroundAssistantRequest(assistantRequest)
                    if (narrow) setReviewPane({ selected: id, open: true })
                  }
                  app.select(id)
                }} />
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
          <aside className="pane-r" id="workspace-review" ref={review} aria-label="核验结果与 AI 助手">
            <Tabs className="workspace-right-tabs" value={assistantTab ? 'assistant' : 'review'} activationMode="manual"
              onValueChange={value => {
                if (value === 'assistant') openAssistant()
                else {
                  setBackgroundAssistantRequest(assistantRequest)
                  setReviewPane({ selected, open: true })
                }
              }}>
              <TabsContent className="workspace-right-panel" value="review" forceMount hidden={assistantTab}>
                <ReviewTodos key={documentId} hasResults={hasReviewResults} onOpen={openReview}
                  detail={element && <section className="review-detail" aria-labelledby="review-sentence-heading">
                    <header className="review-pane-head review-detail-bar">
                      <h2 id="review-sentence-heading" ref={detailHeading} tabIndex={-1}>本句核验</h2>
                      <button type="button" className="btn-txt" onClick={clearReview}>返回待办</button>
                    </header>
                    <div className="review-sentence-body">
                      <ReviewSentence key={`${element.id}:${element.verificationRevision ?? ''}`} element={element} onOpen={openReview} />
                    </div>
                  </section>} />
              </TabsContent>
              <TabsContent className="workspace-right-panel" value="assistant" forceMount hidden={!assistantTab}>
                {assistantRequest && <Suspense fallback={<div className="assistant-panel-loading" role="status">正在加载助手…</div>}>
                  <WorkspaceAssistant key={caseId} visible={assistantTab && !memory} />
                </Suspense>}
              </TabsContent>
              <div className="workspace-review-footer">
                {hasReviewResults && <Button type="button" className="btn btn-pri btn-sm workspace-review-report" disabled={busy}
                  onClick={async () => {
                    if (await app.prepareDocument()) { setAssistantRequest(null); app.setPage('report') }
                  }}>查看核验报告</Button>}
                <TabsList className="workspace-right-tablist" variant="line" aria-label="右侧栏">
                  <TabsTrigger value="review" data-workspace-review-tab>核验结果</TabsTrigger>
                  <TabsTrigger value="assistant" aria-label="AI 助手" title="AI 助手">{assistantIcon}</TabsTrigger>
                </TabsList>
              </div>
            </Tabs>
          </aside>
        </div>
      </div>
    </div>
  )
}
