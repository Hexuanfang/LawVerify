import { useId, useRef, useState } from 'react'
import { ChevronDown, Sparkles } from 'lucide-react'
import type { CheckCode, CheckOutcome } from '../../../server/src/intelligence/verification/protocol'
import profile from '../../../server/src/intelligence/verification/doc-element-profile.json'
import { declarationEditRange } from '../../../server/src/intelligence/verification/review-status.ts'
import { useApp } from './AppContext'
import { CaseReportButton } from './CaseReportButton'
import { caseCitations } from './caseResearchReport'
import { Button } from './components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './components/ui/dropdown-menu'
import { Input } from './components/ui/input'
import { Textarea } from './components/ui/textarea'
import { needsVerification, statementRanges, type ReviewElement, type Source } from './model'
import { currentReviewFinding, reviewStatusLabel } from './reviewOverview'
import { VERIFICATION_ACTION_LABELS, verificationImpacts } from './verificationMemory'

const checkLabels: Record<CheckOutcome, string> = {
  pass: '通过', warn: '预警', fail: '不通过', miss: '缺少出处', pending: '未核实', 'not-applicable': '不适用',
}
type Mode = 'edit' | 'adopt' | 'note' | 'manual' | 'relink' | 'delete'

export function ReviewSentence({ element, onOpen }: { element: ReviewElement; onOpen: (id: string) => void }) {
  const app = useApp()
  const [mode, setMode] = useState<Mode>()
  const [draft, setDraft] = useState('')
  const [checked, setChecked] = useState<CheckCode[]>([])
  const [saving, setSaving] = useState(false)
  const action = useRef<HTMLDivElement>(null)
  const editor = useRef<HTMLTextAreaElement>(null)
  const menuOpensEditor = useRef(false)
  const inputId = useId()
  const certificate = app.certificate
  const finding = currentReviewFinding(certificate, element)
  const checks = Object.entries(finding?.checks ?? {}).sort(([a], [b]) => a.localeCompare(b)) as
    [CheckCode, { outcome: CheckOutcome; reason: string }][]
  const applicable = checks.filter(([, check]) => check.outcome !== 'not-applicable')
  const [source, ...moreSources] = element.sources
  const suggestion = finding && declarationEditRange(element.original.text, finding, 'adopt')
  const canDelete = element.verdict === 'miss' && finding && declarationEditRange(element.original.text, finding, 'delete')
  const canConfirm = element.declaration ? !!element.domainReviewable
    : Boolean(app.workspace && !needsVerification(app.workspace, element.certificateId)
      && element.sources.some(item => item.loc.trim() && item.quote.trim()))
  const confirmed = element.verified && (!element.declaration || element.declaration.review?.decision === 'confirmed')
  const blocked = ['fail', 'miss', 'pending'].includes(element.verdict)
  const pending = element.verdict === 'pending'
  const history = certificate?.verification?.audit?.filter(item => item.declarationId === element.id || item.affected?.includes(element.id)) ?? []
  const localHistory = app.audits.filter(item => item.certificateId === element.certificateId && item.paragraphId === element.paragraphId
    && (!element.declaration || item.elementId === element.id || item.elementId === `${element.certificateId}:${element.paragraphId}:paragraph`))
  const manualNote = confirmed && finding?.verdict === 'pending'
    && history.filter(item => item.action === 'confirm' && item.declarationId === element.id).at(-1)?.note
  const savedNote = element.declaration ? element.declaration.review?.note ?? '' : element.original.note ?? element.note
  const paragraphNote = element.declaration ? element.original.note?.trim() : ''
  const note = [paragraphNote !== savedNote.trim() ? paragraphNote : '', savedNote].filter(Boolean).join('\n')
  const caseRows = caseCitations([element], app.workspace?.knowledgeCases ?? [])
  const index = certificate?.paragraphs.findIndex(paragraph => paragraph.id === element.paragraphId) ?? -1
  const category = profile.elementTypes[element.type as keyof typeof profile.elementTypes] ?? element.type
  const location = index >= 0 ? `第 ${index + 1} 段` : '正文'
  const differences = finding?.differences ?? (!element.declaration && !certificate?.linkageStale && element.verdict === 'fail' && source?.quote
    ? [{ field: '原文', document: element.quote, source: source.quote }] : [])
  const dependencies = certificate && element.declaration?.dependencies?.length
    ? verificationImpacts(certificate, app.elements).filter(item => item.target.id === element.id) : []
  const busy = app.busy || saving
  const modal = mode === 'edit' || mode === 'adopt' || mode === 'note'
  const noteMode = mode === 'note'
  const manualOpen = mode === 'manual' && !confirmed
  const inlineOpen = manualOpen || mode === 'relink' || mode === 'delete'

  const open = (next: Mode) => {
    setMode(next)
    setDraft(next === 'note' ? savedNote : next === 'adopt' && suggestion ? suggestion.replacement : next === 'edit' ? element.quote : '')
    setChecked([])
  }
  const openFromMenu = (next: 'edit' | 'note') => {
    menuOpensEditor.current = true
    open(next)
  }
  const submit = async (operation: () => Promise<boolean | undefined>) => {
    if (busy) return
    setSaving(true)
    try { if (await operation()) setMode(undefined) }
    finally { setSaving(false) }
  }
  const saveText = async () => {
    if (noteMode) return app.saveNote(element, draft.trim())
    if (mode === 'adopt' && suggestion && draft.trim() === suggestion.replacement.trim()) return app.applyDeclarationEdit(element, 'adopt')
    const saved = await app.edit(element, draft)
    if (saved && element.declaration) void app.recheckDirty()
    return Boolean(saved)
  }
  const primary = pending && canConfirm && !confirmed
    ? { label: '人工核验', run: () => open('manual') }
    : blocked && suggestion ? { label: '采纳修改建议', run: () => open('adopt') }
      : element.verdict === 'miss' ? { label: '关联出处', run: () => open('relink') }
        : blocked || element.verdict === 'warn' ? { label: '修改声明', run: () => open('edit') }
          : !confirmed && canConfirm ? { label: '确认通过', run: () => {
            if (applicable.length) open('manual')
            else void submit(() => app.confirm(element))
          } } : undefined
  const renderSource = (entry: Source, key?: number) => <button type="button" key={key} className="review-result-source"
    onClick={() => app.setDrawer(entry)}>
    <span><b>{entry.name}</b><small>{entry.loc}{entry.reason === '人工挂靠出处' && ' · 人工关联'}</small></span>
    <span aria-hidden="true">↗</span>
  </button>

  return <div className="review-sentence">
    <div className="review-result-status" data-verdict={element.verdict}>{reviewStatusLabel(element)}</div>
    <p className="review-result-conclusion">{manualNote ? `人工核验 · ${manualNote}` : element.reason || '已完成核验。'}</p>
    {differences.length > 0 && <table className="review-result-diff" aria-label="核验差异">
      <thead><tr><th scope="col">核对项</th><th scope="col">文书</th><th scope="col">原材料</th></tr></thead>
      <tbody>{differences.map(({ field, document, source }, index) => <tr key={index}>
        <th scope="row">{field}</th><td>{document}</td><td>{source}</td>
      </tr>)}</tbody>
    </table>}
    {source ? <section aria-label="出处"><h3>出处</h3>{renderSource(source)}</section>
      : <p className="review-result-meta">暂无可回查出处</p>}
    {suggestion && <p className="review-result-advice">建议改为：{suggestion.replacement}
      {/[。！？.!?]$/u.test(suggestion.replacement.trimEnd()) ? ' ' : '。'}改声明后可局部重核。</p>}
    {note && <p className="review-result-advice">律师批注 · {note}</p>}
    {confirmed && <p className="review-result-meta">已确认</p>}
    {element.ignored && <p className="review-result-meta">已忽略，仍列入报告</p>}
    {!inlineOpen && <div className="review-result-actions" ref={action}>
      {primary && <Button className="btn btn-pri btn-sm" disabled={busy} onClick={primary.run}>{primary.label}</Button>}
      <button type="button" className="btn-txt" disabled={busy} onClick={() => app.setAssistantRequest({
        mode: 'case', prompt: '请根据卷内材料核对这条声明，并指出需要补证的事项。', quote: element.quote,
        declarationIds: [element.id], anchor: { paragraphId: element.paragraphId, start: element.start, quote: element.quote },
      })}><Sparkles size={12} aria-hidden="true" /> 问 AI</button>
      {!!caseRows.length && <CaseReportButton rows={caseRows}>📦 本案检索报告</CaseReportButton>}
      <DropdownMenu>
        <DropdownMenuTrigger asChild><button type="button" className="btn-txt" disabled={busy}>更多操作 <ChevronDown size={12} /></button></DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="new-case-menu review-action-menu"
          onCloseAutoFocus={event => {
            if (!menuOpensEditor.current) return
            event.preventDefault()
            menuOpensEditor.current = false
            editor.current?.focus()
          }}>
          {primary?.label !== '修改声明' && <DropdownMenuItem onSelect={() => openFromMenu('edit')}>修改声明</DropdownMenuItem>}
          {primary?.label !== '关联出处' && <DropdownMenuItem onSelect={() => open('relink')}>关联出处</DropdownMenuItem>}
          <DropdownMenuItem onSelect={() => openFromMenu('note')}>批注</DropdownMenuItem>
          {element.declaration && !element.ignored && element.verdict === 'warn' && <DropdownMenuItem
            onSelect={() => void submit(() => app.toggleWarning(element))}>忽略预警</DropdownMenuItem>}
          {canDelete && <DropdownMenuItem onSelect={() => open('delete')}>删除此句</DropdownMenuItem>}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>}
    <details className="review-result-details">
      <summary>核验详情</summary>
      <p>{category} · {location}{element.conf !== null && ` · 置信度 ${element.conf}%`}</p>
      <blockquote>{element.quote}</blockquote>
      {source?.quote && <blockquote>{source.quote}</blockquote>}
      {moreSources.map(renderSource)}
      {dependencies.map(({ check, sourceId, source, reason }) => <p key={`${sourceId}:${check}`}>
        {profile.dimensionChecks[check]} · {reason}
        {source && <button type="button" className="btn-txt" onClick={() => onOpen(source.id)}>查看关联声明</button>}
      </p>)}
      {!!checks.length && <ul className="review-result-checks" aria-label="核验维度">{checks.map(([code, check]) =>
        <li key={code} data-outcome={check.outcome} title={check.reason}>{profile.dimensionChecks[code]} · {checkLabels[check.outcome]}</li>)}</ul>}
      {(history.length > 0 || localHistory.length > 0) && <div className="audit">
        <div className="audit-t">人工操作记录</div>
        {history.map(item => <div className="audit-i" key={item.id}>
          <time dateTime={item.at}>{new Date(item.at).toLocaleString('zh-CN')}</time>
          <span>{item.actor} · {VERIFICATION_ACTION_LABELS[item.action]}{item.note && ` · ${item.note}`}</span>
        </div>)}
        {localHistory.map(item => <div className="audit-i" key={item.id}>
          <time dateTime={item.t}>{new Date(item.t).toLocaleString('zh-CN')}</time><span>{item.account} · {item.msg}</span>
        </div>)}
      </div>}
    </details>
    {modal && <Dialog open onOpenChange={open => { if (!open && !busy) setMode(undefined) }}>
      <DialogContent className="review-wide-editor" showCloseButton={false}
        onOpenAutoFocus={event => { event.preventDefault(); editor.current?.focus() }}
        onCloseAutoFocus={event => { event.preventDefault(); action.current?.querySelector<HTMLElement>('button')?.focus() }}>
        <form onSubmit={event => { event.preventDefault(); void submit(saveText) }}>
          <header>
            <DialogTitle>{noteMode ? '律师批注' : '修改声明'}</DialogTitle>
            <DialogDescription>{noteMode ? '批注会显示在本句核验结果和审阅版 Word 中。' : `${location} · 保存后局部重核`}</DialogDescription>
          </header>
          <div className="review-wide-editor-body">
            <details><summary>查看原文</summary><blockquote>{element.quote}</blockquote></details>
            {noteMode && paragraphNote && paragraphNote !== savedNote.trim() && <p className="review-result-advice">{paragraphNote}</p>}
            <label htmlFor={inputId}>{noteMode ? '批注内容' : '修改后的正文'}</label>
            <Textarea ref={editor} id={inputId} value={draft} maxLength={noteMode ? 20_000 : undefined}
              onChange={event => setDraft(event.target.value)} />
          </div>
          <footer><Button type="button" className="btn btn-gh" disabled={busy} onClick={() => setMode(undefined)}>取消</Button>
            <Button type="submit" className="btn btn-pri" disabled={busy || (!noteMode && !draft.trim())}>
              {noteMode ? '保存批注' : '保存并局部重核'}
            </Button></footer>
        </form>
      </DialogContent>
    </Dialog>}
    {manualOpen && <form className="note-box review-inline-operation" onSubmit={event => {
      event.preventDefault()
      void submit(() => app.confirm(element, false, checked, draft.trim() || undefined))
    }}>
      <fieldset disabled={busy}>
        <legend>{pending ? '对照原文逐项确认，填写本次核验说明。' : '对照原文逐项确认。'}</legend>
        {applicable.map(([code]) => <label key={code}><input type="checkbox" required checked={checked.includes(code)}
          onChange={event => setChecked(current => event.target.checked ? [...current, code] : current.filter(item => item !== code))} />
          {code} {profile.dimensionChecks[code]}</label>)}
        {pending && <Textarea required aria-label="人工核验说明" value={draft} maxLength={20_000}
          onChange={event => setDraft(event.target.value)} />}
      </fieldset>
      <div className="review-result-actions">
        <Button type="submit" className="op pri" disabled={busy || checked.length !== applicable.length || (pending && !draft.trim())}>
          {pending ? '通过并保留人工标注' : '确认通过'}
        </Button>
        <Button type="button" className="op" disabled={busy} onClick={() => setMode(undefined)}>取消</Button>
      </div>
    </form>}
    {mode === 'relink' && <ReviewReferenceForm element={element} onClose={() => setMode(undefined)} />}
    {mode === 'delete' && <div className="note-box review-inline-operation">
      <p>删除后该声明将从正文移除，报告保留操作记录。</p>
      <div className="review-result-actions">
        <Button className="op bye" disabled={busy} onClick={() => void submit(() => app.applyDeclarationEdit(element, 'delete'))}>确认删除</Button>
        <Button className="op" disabled={busy} onClick={() => setMode(undefined)}>取消</Button>
      </div>
    </div>}
  </div>
}

function ReviewReferenceForm({ element, onClose }: { element: ReviewElement; onClose: () => void }) {
  const app = useApp()
  const [sourceId, setSourceId] = useState('')
  const [locator, setLocator] = useState('')
  const [quote, setQuote] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const materials = app.workspace?.evidences.filter(item => item.caseId === app.project?.id) ?? []
  const busy = saving || app.busy
  const save = async () => {
    if (busy || !materials.some(item => item.id === sourceId) || !locator.trim() || !quote.trim()) return
    const paragraph = element.original
    const sentence = element.sentenceIndex === undefined ? undefined : statementRanges(paragraph.text)[element.sentenceIndex]
    if (element.sentenceIndex !== undefined && (!sentence || element.start < sentence.start || element.end > sentence.end)) {
      setError('当前声明无法精确定位，请重新打开后再关联出处。')
      return
    }
    const links = paragraph.links?.length ? paragraph.links : paragraph.link ? [paragraph.link] : []
    const bindings = app.certificate?.verification?.manualReferences
    if (links.some(link => link.evidenceId === sourceId && link.sentenceIndex === element.sentenceIndex
      && link.locator === locator.trim() && link.quote === quote.trim()
      && (!element.declaration || !link.id || !bindings?.[link.id] || bindings[link.id] === element.id))) {
      setError('该引用已存在。')
      return
    }
    setSaving(true)
    try {
      if (!await app.prepareDocument()) return
      const saved = await app.saveReferences(element, { links: [...links, {
        id: crypto.randomUUID(), evidenceId: sourceId, locator: locator.trim(), quote: quote.trim(),
        sentenceIndex: element.sentenceIndex, sentenceText: sentence?.text ?? element.quote, relation: 'context', note: '人工挂靠出处',
      }] })
      if (saved) onClose()
    } finally { setSaving(false) }
  }
  return <form className="note-box review-inline-operation" onSubmit={event => { event.preventDefault(); void save() }}>
    <select aria-label="选择材料" value={sourceId} required onChange={event => setSourceId(event.target.value)}>
      <option value="">{materials.length ? '选择卷内材料' : '暂无卷内材料'}</option>
      {materials.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
    </select>
    <Input aria-label="出处定位" placeholder="页码 / 条款 / 时间戳" required value={locator} onChange={event => setLocator(event.target.value)} />
    <Textarea aria-label="出处原文" placeholder="粘贴命中原文" required value={quote} onChange={event => setQuote(event.target.value)} />
    {error && <p className="text-fail" role="alert">{error}</p>}
    <div className="review-result-actions">
      <Button type="submit" className="op pri" disabled={busy || !sourceId || !locator.trim() || !quote.trim()}>保存挂靠</Button>
      <Button type="button" className="op" disabled={busy} onClick={onClose}>取消</Button>
    </div>
  </form>
}
