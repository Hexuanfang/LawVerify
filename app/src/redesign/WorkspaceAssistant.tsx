import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ArrowUp, ChevronDown, Ellipsis, LoaderCircle, Maximize2, Minimize2, X } from 'lucide-react'
import { api } from '../api'
import type { EvidenceLink, ParagraphReference, RoleType } from '../types'
import type { AnalysisOutput } from '../../../server/src/assistant/analysis'
import type { RetrievalCard, RetrievalResult } from '../../../server/src/assistant/retrieval'
import { useApp } from './AppContext'
import { Button } from './components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from './components/ui/dialog'
import { Textarea } from './components/ui/textarea'
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from './components/ui/dropdown-menu'
import { useCaseAssistant } from './CaseAssistant'
import { useDocumentAssistant } from './DocumentAssistant'
import { AssistantCaseReport } from './AssistantCaseReport'
import { caseCitations, caseReportSupplement, type CaseReportSupplement } from './caseResearchReport'
import { AssistantAnalysisCard } from './AssistantAnalysisCard'
import { assistantIntent, isRetrievalTurn } from './assistantIntent'
import { statementRanges, type ReviewElement } from './model'
import { ReferenceEditor } from './ReferenceEditor'
import { rewriteAnchor } from './rewriteAnchor'
import { readCaseNote } from './caseNotes'

const modes = [
  { id: 'draft', mode: 'document', icon: '✍️', label: '起草文书', description: '按代理立场出稿', starter: '起草一份起诉状' },
  { id: 'statute-mcp', mode: 'law', icon: '📖', label: '查法条', description: '现行有效与替代', starter: '查民法典第577条' },
  { id: 'case-mcp', mode: 'similar', icon: '⚖️', label: '查类案', description: '相似案情检索', starter: '检索民间借贷类案' },
] as const

const moreModes = [
  { id: 'case-report', icon: '📦', label: '案例报告', group: '交付', starter: '生成本文的案例检索报告' },
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
type PreviousSkill = NonNullable<Parameters<typeof assistantIntent>[1]> & {
  caseId: string; certificateId?: string; selectionId?: string; instruction?: string
}

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
const supplementStarter = '请在选区最后一项声明之后补写。'
const draftStarters: Partial<Record<RoleType, string>> = {
  defendant: '起草一份答辩状',
  third_party: '起草一份第三人意见书',
  applicant: '起草一份程序申请书',
  respondent: '起草一份程序申请答复意见',
  other: '起草一份代理词',
}

export function WorkspaceAssistant({ visible }: { visible: boolean }) {
  const app = useApp()
  const { setAssistantRequest } = app
  const request = app.assistantRequest!
  const [origin, setOrigin] = useState(request)
  const [tool, setTool] = useState<Tool>(requestTools[request.mode])
  const [prompt, setPrompt] = useState(request.prompt ?? '')
  const [quote, setQuote] = useState(request.quote)
  const [turn, setTurn] = useState<Turn>()
  const [cards, setCards] = useState<LookupCard[]>([])
  const [reportSupplements, setReportSupplements] = useState<CaseReportSupplement[]>([])
  const [notice, setNotice] = useState('')
  const [pending, setPending] = useState(false)
  const [analysis, setAnalysis] = useState<AnalysisOutput>()
  const [association, setAssociation] = useState<{ target: ReviewElement; suggested: EvidenceLink | ParagraphReference }>()
  const [externalAssociation, setExternalAssociation] = useState<{ target: ReviewElement; card: LookupCard }>()
  const [expanded, setExpanded] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const moreMenu = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const scroll = useRef<HTMLDivElement>(null)
  const active = useRef(true)
  const adoptionLock = useRef(false)
  const controller = useRef<AbortController | null>(null)
  const previousSkill = useRef<PreviousSkill | undefined>(undefined)
  const caseId = app.project!.id
  const certificateId = app.certificate?.id
  const lawyerNote = readCaseNote(app.workspace!.user.id, caseId).trim().slice(0, 20000) || undefined
  const anchor = quote ? request.anchor : undefined
  const selectionAnchor = quote ? rewriteAnchor(app.certificate, quote, anchor) : undefined
  const coveredDeclarations = selectionAnchor ? app.elements.filter(item => item.declaration
    && item.paragraphId === selectionAnchor.paragraphId && item.start <= selectionAnchor.start && item.end >= selectionAnchor.end) : []
  const matchedDeclarations = quote && request.declarationIds?.length
    ? app.elements.filter(item => item.declaration && request.declarationIds?.includes(item.id)) : coveredDeclarations
  const currentDeclaration = matchedDeclarations.length === 1 ? matchedDeclarations[0]
    : !matchedDeclarations.length && app.element?.declaration && (quote ? app.element.quote === quote : !request.quote) ? app.element : undefined
  const documentContext = {
    certificateId, selectionText: quote?.slice(0, 6000),
    declarationIds: matchedDeclarations.length ? matchedDeclarations.map(item => item.id).slice(0, 12)
      : currentDeclaration ? [currentDeclaration.id] : undefined,
  }
  const session = sessionStorage.getItem('lawverify-auth-session')
  const isCurrent = () => active.current && session === sessionStorage.getItem('lawverify-auth-session')

  if (request !== origin) {
    setOrigin(request)
    setTool(requestTools[request.mode])
    setPrompt(request.prompt ?? '')
    setQuote(request.quote)
  }

  const documents = useDocumentAssistant(quote, anchor)
  const draftStarter = documents.draftRole ? draftStarters[documents.draftRole] : undefined
  const conversation = useCaseAssistant()
  const waiting = pending || documents.running || conversation.pending
  const disabled = app.busy || waiting
  const selectedMoreMode = moreModes.find(option => option.id === tool)

  useEffect(() => {
    active.current = true
    if (!document.activeElement?.closest('.workspace-right-tablist')) input.current?.focus({ preventScroll: true })
    return () => { active.current = false; controller.current?.abort() }
  }, [])

  useEffect(() => {
    if (!visible) return
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || menuOpen
        || document.querySelector('[data-state="open"][role="dialog"]')) return
      event.preventDefault()
      setAssistantRequest(null)
    }
    window.addEventListener('keydown', onEscape)
    return () => window.removeEventListener('keydown', onEscape)
  }, [visible, menuOpen, setAssistantRequest])

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
  }, [visible, turn, notice, waiting, conversation.messageCount, documents.paragraphCount])

  const search = async (skill: Exclude<Skill, 'draft' | 'rewrite' | 'case-report'>, query: string) => {
    if (controller.current || app.busy) return
    const abort = new AbortController()
    controller.current = abort
    setPending(true)
    const startedAt = performance.now()
    try {
      const result = await api.executeAssistantSkill<AnalysisOutput | LookupResult>(skill, { caseId, certificateId, query }, abort.signal)
      if (!isCurrent()) return
      if ('cards' in result) {
        const sourceLabel = skill === 'statute-mcp' ? '法条库' : skill === 'case-mcp' ? '案例库' : '卷内材料'
        setCards(result.cards)
        setNotice(`${sourceLabel} · ${Math.round(performance.now() - startedAt)} 毫秒 · 返回 ${result.cards.length} 条。${result.message}`)
        void app.auditAssistantAction(certificateId, `助手检索${sourceLabel}，返回 ${result.cards.length} 条`, currentDeclaration)
      } else {
        setAnalysis(result)
        const label = moreModes.find(option => option.id === skill)?.label
        if (label) void app.auditAssistantAction(certificateId, `助手生成${label}结果`, currentDeclaration)
      }
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
    const previous = previousSkill.current
    const scopedPrevious = previous?.caseId === caseId && previous.certificateId === certificateId ? previous : undefined
    const continuation = tool === 'auto' || tool === scopedPrevious?.skill ? scopedPrevious : undefined
    const routed = assistantIntent(text, continuation)
    const skill = tool !== 'auto' ? tool : routed?.skill
    if (!skill) {
      previousSkill.current = undefined
      setTurn(undefined)
      if (await conversation.send(text, lawyerNote, documentContext)) setPrompt('')
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
    previousSkill.current = { skill, query, caseId, certificateId, selectionId: selectionAnchor?.id, instruction: text }
    setPrompt('')
    setNotice('')
    setCards([])
    setAnalysis(undefined)
    if (skill === 'draft' || skill === 'rewrite') {
      setTurn({ type: 'document', prompt: text })
      const writingContinuation = routed?.continuation && skill === routed.skill && scopedPrevious?.selectionId === selectionAnchor?.id
        ? scopedPrevious?.instruction : undefined
      await documents.start(skill === 'draft' ? 'generate' : 'rewrite', text, lawyerNote, documentContext, writingContinuation)
    } else if (skill === 'case-report') {
      setTurn({ type: 'report', prompt: text || '生成本文的案例检索报告' })
      void app.auditAssistantAction(certificateId, '助手生成案例检索报告预览')
    } else {
      setTurn({ type: 'skill', prompt: text })
      if (!modeNames[skill]) setTool('auto')
      await search(skill, query || text)
    }
  }

  const toggleMode = (id: (typeof modes)[number]['id'] | 'case-report', starter: string) => {
    setTool(tool === id ? 'auto' : id)
    if (tool === id && prompt === starter) setPrompt('')
    if (tool !== id && (!prompt.trim() || prompt === supplementStarter || prompt === draftStarter
      || [...modes, ...moreModes].some(option => option.starter === prompt))) setPrompt(starter)
    input.current?.focus()
  }

  const adopt = async (card: LookupCard, target?: ReviewElement) => {
    const candidateId = card.candidateId
    if (!candidateId || !certificateId || adoptionLock.current || app.busy) return
    adoptionLock.current = true
    try {
      if (!await app.prepareDocument() || !isCurrent()) return
      let elementId = ''
      const saved = await app.run(async () => {
        const result = await api.adoptAssistantCandidate(candidateId, { caseId, certificateId, declarationId: target?.id })
        elementId = result.elementId ?? ''
      }, target ? '出处已关联，声明待重核' : '已引用到文末，新增声明待核验')
      if (saved && isCurrent()) {
        setCards(items => items.map(item => ({ ...item, candidateId: undefined })))
        setExternalAssociation(undefined)
        app.setFilter('all')
        app.select(elementId)
      }
    } finally {
      adoptionLock.current = false
    }
  }

  const associate = (card: LookupCard) => {
    const target = currentDeclaration
    if (!target || card.status !== 'verified' || target.sentenceIndex === undefined) return
    const sentence = statementRanges(target.original.text)[target.sentenceIndex]
    if (!sentence || target.start < sentence.start || target.end > sentence.end) {
      app.toast('当前声明的原文位置已变化，请重新定位。')
      return
    }
    const existing = target.sources.some(source => source.st === card.source.tier
      && source.targetId === (card.reference?.targetId ?? card.source.id) && source.loc === card.source.locator && source.quote === card.source.quote)
    if (existing) { app.toast('当前声明已关联该出处。'); return }
    if (!card.evidenceLink && !card.reference) {
      setExternalAssociation({ target, card })
      return
    }
    const anchor = { id: crypto.randomUUID(), sentenceIndex: target.sentenceIndex, sentenceText: sentence.text }
    const suggested = card.evidenceLink ? { ...card.evidenceLink, ...anchor, relation: 'context' as const, note: '律师采纳卷内检索出处，待核验' }
      : { ...card.reference!, ...anchor, reason: '检索挂靠出处' }
    setAssociation({ target, suggested })
  }

  const discardCitation = async (card: LookupCard) => {
    const candidateId = card.candidateId
    if (!candidateId || adoptionLock.current || disabled) return
    adoptionLock.current = true
    setPending(true)
    try {
      await api.discardAssistantCandidate(candidateId)
      if (!isCurrent()) return
      setCards(items => items.map(item => item.candidateId === candidateId ? { ...item, candidateId: undefined } : item))
      await app.auditAssistantAction(certificateId, `律师放弃检索引用候选 · ${card.label}`, currentDeclaration)
    } catch (cause) {
      if (isCurrent()) setNotice(cause instanceof Error ? cause.message : '暂时无法放弃该引用候选。')
    } finally {
      adoptionLock.current = false
      if (isCurrent()) setPending(false)
    }
  }

  const placeholder = (tool === 'draft' && quote ? '描述要在选区后补写的内容…' : placeholders[tool])
    ?? (quote ? '描述你想怎么处理这段文字…' : '描述你想起草、查找或核验的内容…')

  return <section className={'workspace-ai-panel' + (expanded ? ' is-expanded' : '')} aria-label="AI 助手" aria-busy={waiting}>
    <header className="workspace-ai-header">
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
        onClick={() => toggleMode(id, id === 'draft' ? quote ? supplementStarter : draftStarter ?? starter : starter)}>
        <span aria-hidden="true">{icon}</span><b>{label}</b><small>{id === 'draft' && quote ? '在选区后补写' : description}</small>
      </Button>)}
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen} modal={false}>
        <DropdownMenuTrigger asChild><Button variant="outline" className="workspace-ai-card workspace-ai-more"
          data-active={selectedMoreMode ? '' : undefined} title={selectedMoreMode?.label ?? '更多技能'}
          disabled={disabled}>
          <span className="workspace-ai-more-icons" aria-hidden="true">
            {selectedMoreMode?.icon ?? <Ellipsis size={15} />}<ChevronDown size={13} />
          </span>
          <b>{selectedMoreMode?.label ?? '更多技能'}</b>
        </Button></DropdownMenuTrigger>
        <DropdownMenuContent ref={moreMenu} align="end" side="bottom" className="new-case-menu workspace-ai-menu" aria-label="更多技能"
          onCloseAutoFocus={event => { event.preventDefault(); input.current?.focus() }}>
          <DropdownMenuRadioGroup value={selectedMoreMode?.id ?? ''}>
            {moreModes.map(({ id, icon, label, group, starter }) => <DropdownMenuRadioItem key={id} value={id} aria-label={label}
              onSelect={() => {
                if (id === 'case-report') { toggleMode(id, starter); return }
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
        <p>{quote
          ? '选中文段已附在输入框上方。可以直接描述，或从「更多技能」选择改写润色。'
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
                <Button variant="ghost" size="sm" disabled={disabled} onClick={() => void discardCitation(card)}>放弃引用</Button>
              </details>}
              {card.candidateId && currentDeclaration?.sentenceIndex !== undefined &&
                <Button variant="outline" size="sm" disabled={disabled} onClick={() => associate(card)}>关联当前声明</Button>}
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
        <small>
          <span><kbd>Enter</kbd> 发送</span><span><kbd>Shift Enter</kbd> 换行</span>
        </small>
        <Button type="submit" className="workspace-ai-send" size="icon" aria-label={waiting ? '处理中' : '发送'}
          disabled={disabled || (!prompt.trim() && tool !== 'case-report')}>
          {waiting ? <LoaderCircle size={16} className="workspace-ai-spinner" /> : <ArrowUp size={16} />}
        </Button>
      </div>
    </form>
    {association && <ReferenceEditor target={association.target} suggested={association.suggested} onClose={() => setAssociation(undefined)} />}
    {externalAssociation && <Dialog open onOpenChange={open => { if (!open && !app.busy && !adoptionLock.current) setExternalAssociation(undefined) }}>
      <DialogContent className="fm-box new-form essential-reference-dialog">
        <DialogTitle>关联外部出处</DialogTitle>
        <DialogDescription>请对照声明和检索出处。确认后将出处关联到当前声明，进入待重核。</DialogDescription>
        <blockquote>{externalAssociation.target.quote}</blockquote>
        <p>{externalAssociation.card.label} · {externalAssociation.card.locator}</p>
        <blockquote>{externalAssociation.card.excerpt}</blockquote>
        {externalAssociation.card.source?.url && /^https?:\/\//iu.test(externalAssociation.card.source.url) &&
          <a href={externalAssociation.card.source.url} target="_blank" rel="noreferrer">回查来源 ↗</a>}
        <DialogFooter>
          <Button variant="outline" disabled={app.busy} onClick={() => setExternalAssociation(undefined)}>取消</Button>
          <Button disabled={app.busy} onClick={() => void adopt(externalAssociation.card, externalAssociation.target)}>确认关联</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>}
  </section>
}
