import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ArrowUp, Ellipsis, LoaderCircle, Maximize2, Minimize2, X } from 'lucide-react'
import { api } from '../api'
import type { AnalysisOutput } from '../../../server/src/assistant/analysis'
import type { RetrievalCard, RetrievalResult } from '../../../server/src/assistant/retrieval'
import { useApp } from './AppContext'
import { Brand } from './Home'
import { Button } from './components/ui/button'
import { Textarea } from './components/ui/textarea'
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from './components/ui/dropdown-menu'
import { useCaseAssistant } from './CaseAssistant'
import { useDocumentAssistant } from './DocumentAssistant'
import { AssistantCaseReport } from './AssistantCaseReport'
import { caseCitations, caseReportSupplement, type CaseReportSupplement } from './caseResearchReport'
import { AssistantAnalysisCard } from './AssistantAnalysisCard'
import { assistantIntent, isRetrievalTurn } from './assistantIntent'

const modes = [
  { id: 'draft', mode: 'document', icon: '✍️', label: '起草文书', description: '按代理立场出稿', starter: '起草一份起诉状' },
  { id: 'statute-mcp', mode: 'law', icon: '📖', label: '查法条', description: '现行有效与替代', starter: '查民法典第577条' },
  { id: 'case-mcp', mode: 'similar', icon: '⚖️', label: '查类案', description: '相似案情检索', starter: '检索民间借贷类案' },
  { id: 'case-report', mode: 'report', icon: '📦', label: '案例报告', description: '汇总当前文书类案', starter: '生成本文的案例检索报告' },
] as const

const moreModes = [
  { id: 'inbox-search', icon: '📁', label: '卷内检索', group: '检索', starter: '找一下本案的付款凭证' },
  { id: 'rewrite', icon: '🪄', label: '改写润色', group: '写作', starter: '把这段改写得更严谨' },
  { id: 'evidence', icon: '🧩', label: '证据三性', group: '核验', starter: '评估微信截图的证明力' },
  { id: 'chain', icon: '🔗', label: '论证链检查', group: '核验', starter: '检查代理词的论证链' },
  { id: 'calc', icon: '🧮', label: '金额复算', group: '核验', starter: '复算本案利息' },
  { id: 'focus', icon: '🎯', label: '争议焦点', group: '记忆', starter: '归纳本案争议焦点' },
  { id: 'timeline', icon: '🗓️', label: '时间线梳理', group: '记忆', starter: '梳理本案时间线' },
  { id: 'risk', icon: '🛡️', label: '风险与补强', group: '核验', starter: '本案还有哪些证据短板' },
] as const

type Skill = (typeof modes)[number]['id'] | (typeof moreModes)[number]['id']
type Tool = 'auto' | Skill
type LookupCard = RetrievalCard & { candidateId?: string }
type LookupResult = Omit<RetrievalResult, 'cards'> & { cards: LookupCard[] }
type Turn = { type: 'document' | 'report' | 'skill'; prompt: string }
type PreviousRetrieval = NonNullable<Parameters<typeof assistantIntent>[1]> & { caseId: string; certificateId?: string }

const modeNames: Partial<Record<Tool, string>> = {
  draft: '起草', 'statute-mcp': '法条', 'case-mcp': '案例', 'inbox-search': '卷内', rewrite: '改写', 'case-report': '案例报告',
}
const placeholders: Partial<Record<Tool, string>> = {
  draft: '描述要起草的文书与要点…',
  'statute-mcp': '描述要查的法条、效力或请求权基础…',
  'case-mcp': '描述案情、案号或要检索的类案…',
  'case-report': '回车生成案例检索报告',
}
const requestTools = { case: 'auto', document: 'draft', law: 'statute-mcp', similar: 'case-mcp', report: 'case-report', rewrite: 'rewrite' } as const

export function WorkspaceAssistant() {
  const app = useApp()
  const { setAssistantRequest } = app
  const request = app.assistantRequest!
  const [origin, setOrigin] = useState(request)
  const [tool, setTool] = useState<Tool>(requestTools[request.mode])
  const [prompt, setPrompt] = useState(request.prompt ?? '')
  const [quote, setQuote] = useState(request.quote)
  const [positionIntent, setPositionIntent] = useState(Boolean(request.position))
  const [turn, setTurn] = useState<Turn>()
  const [cards, setCards] = useState<LookupCard[]>([])
  const [reportSupplements, setReportSupplements] = useState<CaseReportSupplement[]>([])
  const [notice, setNotice] = useState('')
  const [pending, setPending] = useState(false)
  const [analysis, setAnalysis] = useState<AnalysisOutput>()
  const [expanded, setExpanded] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const moreMenu = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const scroll = useRef<HTMLDivElement>(null)
  const active = useRef(true)
  const adoptionLock = useRef(false)
  const controller = useRef<AbortController | null>(null)
  const previousRetrieval = useRef<PreviousRetrieval | undefined>(undefined)
  const caseId = app.project!.id
  const certificateId = app.certificate?.id
  const session = sessionStorage.getItem('lawverify-auth-session')
  const isCurrent = () => active.current && session === sessionStorage.getItem('lawverify-auth-session')

  if (request !== origin) {
    setOrigin(request)
    setTool(requestTools[request.mode])
    setPrompt(request.prompt ?? '')
    setQuote(request.quote)
    setPositionIntent(Boolean(request.position))
  }

  const documents = useDocumentAssistant(quote)
  const conversation = useCaseAssistant(() => setPositionIntent(false))
  const waiting = pending || documents.running || conversation.pending
  const disabled = app.busy || waiting
  const selectedMoreMode = moreModes.find(option => option.id === tool)

  useEffect(() => {
    active.current = true
    input.current?.focus({ preventScroll: true })
    return () => { active.current = false; controller.current?.abort() }
  }, [])

  useEffect(() => {
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || menuOpen
        || document.querySelector('[data-state="open"][role="dialog"]')) return
      event.preventDefault()
      setAssistantRequest(null)
    }
    window.addEventListener('keydown', onEscape)
    return () => window.removeEventListener('keydown', onEscape)
  }, [menuOpen, setAssistantRequest])

  useEffect(() => {
    if (!menuOpen || !selectedMoreMode) return
    const frame = requestAnimationFrame(() => {
      const selected = moreMenu.current?.querySelector<HTMLElement>('[aria-checked="true"]')
      selected?.focus({ preventScroll: true })
      selected?.scrollIntoView({ block: 'nearest' })
    })
    return () => cancelAnimationFrame(frame)
  }, [menuOpen, selectedMoreMode])

  useEffect(() => {
    const body = scroll.current
    if (body) body.scrollTop = body.scrollHeight
  }, [turn, notice, waiting, conversation.messageCount, documents.paragraphCount])

  const search = async (skill: Exclude<Skill, 'draft' | 'rewrite' | 'case-report'>, query: string) => {
    if (controller.current || app.busy) return
    const abort = new AbortController()
    controller.current = abort
    setPending(true)
    try {
      const result = await api.executeAssistantSkill<AnalysisOutput | LookupResult>(skill, { caseId, certificateId, query }, abort.signal)
      if (!isCurrent()) return
      if ('cards' in result) {
        setCards(result.cards)
        setNotice(result.message)
      } else setAnalysis(result)
    } catch (cause) {
      if (isCurrent()) setNotice(cause instanceof Error ? cause.message : '技能暂不可用，请重试。')
    } finally {
      if (controller.current === abort) controller.current = null
      if (isCurrent()) setPending(false)
    }
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const text = prompt.trim()
    if (disabled || (!text && tool !== 'case-report')) return
    const previous = previousRetrieval.current
    const scopedPrevious = previous?.caseId === caseId && previous.certificateId === certificateId ? previous : undefined
    const continuation = tool === 'auto' || tool === scopedPrevious?.skill ? scopedPrevious : undefined
    const routed = positionIntent ? undefined : assistantIntent(text, continuation)
    const skill = tool !== 'auto' ? tool : routed?.skill
    if (!skill) {
      previousRetrieval.current = undefined
      setTurn(undefined)
      if (await conversation.send(text, quote, positionIntent)) setPrompt('')
      return
    }
    const query = routed?.skill === skill ? routed.query : text
    if (isRetrievalTurn(skill) && !query) {
      setTurn({ type: 'skill', prompt: text })
      setPrompt('')
      setAnalysis(undefined)
      if (!scopedPrevious || scopedPrevious.skill !== skill) setCards([])
      setNotice(`请补充${modeNames[skill]}检索关键词。`)
      return
    }
    previousRetrieval.current = isRetrievalTurn(skill) ? { skill, query, caseId, certificateId } : undefined
    setPrompt('')
    setNotice('')
    setCards([])
    setAnalysis(undefined)
    if (skill === 'draft' || skill === 'rewrite') {
      setTurn({ type: 'document', prompt: text })
      await documents.start(skill === 'draft' ? 'generate' : 'rewrite', text)
    } else if (skill === 'case-report') {
      setTurn({ type: 'report', prompt: text || '生成本文的案例检索报告' })
    } else {
      setTurn({ type: 'skill', prompt: text })
      if (!modeNames[skill]) setTool('auto')
      await search(skill, query || text)
    }
  }

  const toggleMode = (id: (typeof modes)[number]['id'], starter: string) => {
    setPositionIntent(false)
    setTool(tool === id ? 'auto' : id)
    if (tool === id && prompt === starter) setPrompt('')
    if (tool !== id && (!prompt.trim() || [...modes, ...moreModes].some(option => option.starter === prompt))) setPrompt(starter)
    input.current?.focus()
  }

  const adopt = async (card: LookupCard) => {
    const candidateId = card.candidateId
    if (!candidateId || !certificateId || adoptionLock.current || app.busy) return
    adoptionLock.current = true
    try {
      if (!await app.prepareDocument() || !isCurrent()) return
      let elementId = ''
      const saved = await app.run(async () => {
        const result = await api.adoptAssistantCandidate(candidateId, { caseId, certificateId })
        elementId = result.elementId ?? ''
      }, '已引用到文末，新增声明待核验')
      if (saved && isCurrent()) {
        setCards(items => items.map(item => ({ ...item, candidateId: undefined })))
        app.select(elementId)
      }
    } finally {
      adoptionLock.current = false
    }
  }

  const placeholder = placeholders[tool] ?? (positionIntent ? '说明代理哪一方和办案目标…'
    : quote ? '描述你想怎么处理这段文字…' : '描述你想起草、查找或核验的内容…')

  return <section className={'workspace-ai-panel' + (expanded ? ' is-expanded' : '')} aria-label="AI 助手" aria-busy={waiting}>
    <header className="workspace-ai-header">
      <Brand title="AI 助手" size={34} />
      <div className="workspace-ai-header-actions">
        <Button variant="ghost" size="icon" aria-pressed={expanded}
          aria-label={expanded ? '还原 AI 助手' : '加宽 AI 助手'} title={expanded ? '还原 AI 助手' : '加宽 AI 助手'}
          onClick={() => setExpanded(value => !value)}>{expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}</Button>
        <Button variant="ghost" size="icon" aria-label="关闭 AI 助手" title="关闭 AI 助手（Esc）"
          onClick={() => setAssistantRequest(null)}><X size={16} /></Button>
      </div>
    </header>
    <div className="workspace-ai-modes" role="group" aria-label="助手能力">
      {modes.map(({ id, mode, icon, label, description, starter }) => <Button key={id} className="workspace-ai-card" variant="outline"
        data-mode={mode} aria-label={label} title={description} aria-pressed={tool === id} disabled={disabled}
        onClick={() => toggleMode(id, starter)}>
        <span aria-hidden="true">{icon}</span><b>{label}</b><small>{description}</small>
      </Button>)}
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen} modal={false}>
        <DropdownMenuTrigger asChild><Button variant="outline" size="icon-sm" className="workspace-ai-more"
          aria-label={selectedMoreMode ? `${selectedMoreMode.label}，更多技能` : '更多技能'}
          data-active={selectedMoreMode ? '' : undefined} title={selectedMoreMode ? `已选：${selectedMoreMode.label}` : '更多技能'}
          disabled={disabled}>
          <span aria-hidden="true">{selectedMoreMode?.icon ?? <Ellipsis className="size-4" />}</span>
        </Button></DropdownMenuTrigger>
        <DropdownMenuContent ref={moreMenu} align="end" side="bottom" className="new-case-menu workspace-ai-menu" aria-label="更多技能"
          onCloseAutoFocus={event => { event.preventDefault(); input.current?.focus() }}>
          <DropdownMenuRadioGroup value={selectedMoreMode?.id ?? ''}>
            {moreModes.map(({ id, icon, label, group, starter }) => <DropdownMenuRadioItem key={id} value={id} aria-label={label}
              onSelect={() => {
                setPositionIntent(false)
                if (tool === id) {
                  setTool('auto')
                  if (prompt === starter) setPrompt('')
                } else {
                  setTool(id)
                  setPrompt(starter)
                }
              }}>
              <span aria-hidden="true">{icon}</span>{label}<small>{group}</small>
            </DropdownMenuRadioItem>)}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>

    <div className="workspace-ai-body" ref={scroll} role="log" aria-label="对话记录">
      {!turn && !conversation.hasResult && <div className="workspace-ai-hello">
        <h3>{quote ? '这段文字，想怎么处理？' : '需要我做什么？'}</h3>
        <p>{positionIntent ? '说明代理哪一方、希望达成什么目标。' : quote
          ? '选中文段已附在输入框上方。可以直接描述，或从「更多」选择改写润色。'
          : '点上方能力锁定模式，再点一次取消；也可以直接说。'}</p>
        {conversation.stance && <p className="workspace-ai-stance">当前立场 · {conversation.stance}</p>}
      </div>}
      {conversation.result}
      {turn && <div className="workspace-ai-turn">
        <p className="workspace-ai-message">{turn.prompt}</p>
        {turn.type === 'document' && documents.result}
        {turn.type === 'report' && <AssistantCaseReport supplements={reportSupplements} />}
        {turn.type === 'skill' && <div className="workspace-ai-lookup">
          {notice && <p role="status">{notice}</p>}
          {analysis && <AssistantAnalysisCard card={analysis} />}
          {cards.map((card, index) => {
            const source = card.source
            const url = card.url ?? source?.url
            const caseInfo = card.caseVerification
            const statute = card.statuteVerification
            const supplement = caseReportSupplement(card)
            const selectable = supplement && caseCitations(app.elements, app.workspace?.knowledgeCases ?? [], [supplement])
              .some(row => row.entry === supplement)
            return <article className="workspace-ai-result" key={card.label + ':' + index}>
              <h3>{card.label}</h3>
              <p>{[card.status === 'verified' ? '出处已核' : '检索候选 · 待核', card.locator, statute?.validity, statute?.factDate,
                caseInfo?.caseNumber, caseInfo?.court, caseInfo?.judgmentDate,
                card.output && 'hit_level' in card.output ? card.output.hit_level : undefined].filter(Boolean).join(' · ')}</p>
              {card.reason && <p>{card.reason}</p>}
              {card.excerpt && <p>{card.excerpt}</p>}
              {url && /^https?:\/\//i.test(url) && <a href={url} target="_blank" rel="noreferrer">回查来源 ↗</a>}
              {source && (source.tier === 'l1' || card.reference) && <Button variant="outline" size="sm" onClick={() => app.setDrawer({
                st: source.tier, targetId: card.reference?.targetId ?? source.id, name: source.name, loc: source.locator ?? '', quote: source.quote ?? '',
              })}>查看出处</Button>}
              {selectable && <label>
                <input type="checkbox" checked={reportSupplements.some(item => item.id === supplement.id)} disabled={disabled}
                  onChange={event => {
                    const checked = event.currentTarget.checked
                    setReportSupplements(items => checked ? [...items.filter(item => item.id !== supplement.id), supplement]
                      : items.filter(item => item.id !== supplement.id))
                  }} /> 加入案例报告
              </label>}
              {card.candidateId && <details>
                <summary>预览拟引用原文</summary>
                <p>{card.citationText}</p>
                <Button size="sm" disabled={disabled} onClick={() => void adopt(card)}>确认引用到文末</Button>
              </details>}
            </article>
          })}
        </div>}
      </div>}
    </div>

    <form className="assistant-composer" onSubmit={event => void submit(event)}>
      {quote && <div className="workspace-ai-quote">
        <span aria-hidden="true">📎</span><small>选中文段</small><span className="workspace-ai-quote-text" title={quote}>{quote}</span>
        <Button type="button" size="icon" variant="ghost" aria-label="移除引用" disabled={disabled} onClick={() => setQuote(undefined)}><X size={13} /></Button>
      </div>}
      <Textarea ref={input} id="workspace-ai-prompt" rows={1} aria-label="向 AI 助手提问" placeholder={placeholder}
        value={prompt} maxLength={6000} readOnly={waiting} onChange={event => setPrompt(event.target.value)}
        onKeyDown={event => {
          if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return
          event.preventDefault()
          if (!disabled) event.currentTarget.form?.requestSubmit()
        }} />
      <div className="workspace-ai-composer-footer">
        <small><strong aria-live="polite" className={selectedMoreMode ? 'workspace-ai-selected-skill' : undefined}>
          {positionIntent ? '代理立场' : selectedMoreMode?.label ?? modeNames[tool] ?? '自动路由'}
        </strong>
          <span><kbd>Enter</kbd> 发送</span><span><kbd>Shift Enter</kbd> 换行</span>
        </small>
        <Button type="submit" className="workspace-ai-send" size="icon" aria-label={waiting ? '处理中' : '发送'}
          disabled={disabled || (!prompt.trim() && tool !== 'case-report')}>
          {waiting ? <LoaderCircle size={16} className="workspace-ai-spinner" /> : <ArrowUp size={16} />}
        </Button>
      </div>
    </form>
  </section>
}
