import { useState } from 'react'
import type { EvidenceLink, ParagraphReference } from '../types'
import { Button } from './components/ui/button'
import { Input } from './components/ui/input'
import { Textarea } from './components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './components/ui/select'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './components/ui/dialog'
import { useApp } from './AppContext'
import { statementRanges, type ReviewElement } from './model'

export function ReferenceEditor({ target, onClose, suggested }: {
  target: ReviewElement
  onClose: () => void
  suggested?: EvidenceLink | ParagraphReference
}) {
  const app = useApp()
  const paragraph = target.original
  const [links, setLinks] = useState(() => [
    ...(paragraph.links?.length ? paragraph.links : paragraph.link ? [paragraph.link] : []),
    ...(suggested && 'evidenceId' in suggested ? [suggested] : []),
  ])
  const [references, setReferences] = useState(() => [
    ...(paragraph.references ?? []),
    ...(suggested && 'targetId' in suggested ? [suggested] : []),
  ])
  const [kind, setKind] = useState('evidence')
  const [sourceId, setSourceId] = useState('')
  const [locator, setLocator] = useState('')
  const [quote, setQuote] = useState('')
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')
  const workspace = app.workspace!
  const bindings = app.certificate?.verification?.manualReferences
  const visible = (id?: string) => !id || !bindings?.[id] || bindings[id] === target.id || !target.declaration
  const options = kind === 'evidence'
    ? workspace.evidences.filter(item => item.caseId === app.project?.id).map(item => ({ id: item.id, label: item.name, locator: '', quote: item.ocrText, warning: undefined }))
    : kind === 'statute'
      ? workspace.knowledgeStatutes.flatMap(doc => doc.articles.map(article => ({ id: article.id, label: `${doc.title} ${article.articleNumber}`, locator: article.articleNumber,
        quote: article.content || article.plainText, warning: doc.effectiveStatus === 'repealed' ? 'statute-repealed' as const : doc.effectiveStatus === 'amended' ? 'statute-amended' as const : !article.content && !article.plainText ? 'statute-content-missing' as const : undefined })))
      : workspace.knowledgeCases.flatMap(item => item.excerpts?.length
        ? item.excerpts.map(excerpt => ({ id: excerpt.id, label: `${item.caseNumber} · ${excerpt.locator || item.title}`, locator: excerpt.locator, quote: excerpt.content, warning: undefined }))
        : [{ id: item.id, label: `${item.caseNumber} ${item.title}`, locator: '裁判要旨', quote: item.holdingSummary, warning: undefined }])
  const add = () => {
    const source = options.find(item => item.id === sourceId)
    if (!source || !locator.trim() || !quote.trim()) { setError('请选择出处并填写定位和原文引文。'); return }
    const sentence = target.sentenceIndex === undefined ? undefined : statementRanges(paragraph.text)[target.sentenceIndex]
    if (target.sentenceIndex !== undefined && (!sentence || target.start < sentence.start || target.end > sentence.end)) {
      setError('当前声明无法精确定位，请重新打开后再挂靠出处。'); return
    }
    const anchor = { sentenceIndex: target.sentenceIndex, sentenceText: sentence?.text ?? target.quote }
    if (kind === 'evidence') {
      if (links.some(item => visible(item.id) && item.evidenceId === sourceId && item.locator === locator && item.sentenceIndex === target.sentenceIndex)) { setError('该引用已存在。'); return }
      setLinks(current => [...current, { id: crypto.randomUUID(), evidenceId: sourceId, locator, quote, relation: 'context', note: '人工挂靠出处', ...anchor }])
    } else {
      if (references.some(item => visible(item.id) && item.targetId === sourceId && item.sentenceIndex === target.sentenceIndex)) { setError('该引用已存在。'); return }
      setReferences(current => [...current, { id: crypto.randomUUID(), type: kind === 'statute' ? 'statute' : 'case', targetId: sourceId,
        sourceTitle: source.label, label: source.label, locator, quote, warning: source.warning, reason: '人工挂靠出处', ...anchor }])
    }
    setError(''); setSourceId(''); setLocator(''); setQuote('')
  }
  const save = async () => {
    if ([...links, ...references].some(item => visible(item.id) && (!item.locator.trim() || !item.quote.trim()))) { setError('请补齐引用的定位与引文，或移除无效引用。'); return }
    if (suggested && !await app.prepareDocument()) return
    if (await app.saveReferences(target, { links, link: links[0], references })) onClose()
  }
  const fields = (item: EvidenceLink | ParagraphReference, index: number, isLink: boolean) => {
    const patch = (value: Partial<EvidenceLink & ParagraphReference>) => {
      if (isLink) setLinks(current => current.map((source, i) => i === index ? { ...source, ...value } : source))
      else setReferences(current => current.map((source, i) => i === index ? { ...source, ...value } : source))
    }
    const name = 'evidenceId' in item ? workspace.evidences.find(evidence => evidence.id === item.evidenceId)?.name || '材料已不存在' : item.sourceTitle
    return <div className="essential-reference-item" key={`${isLink ? 'link' : 'reference'}-${index}`}>
      <div className="essential-reference-heading"><b>{name}</b><Button variant="ghost" className="op bye" disabled={app.busy}
        onClick={() => isLink ? setLinks(current => current.filter((_, i) => i !== index)) : setReferences(current => current.filter((_, i) => i !== index))}>移除引用</Button></div>
      <small>{item.sentenceText ? `声明：${item.sentenceText}` : '作用范围：整段'}</small>
      <label>定位<Input aria-label={`引用定位 ${isLink ? '材料' : '知识'} ${index + 1}`} value={item.locator} onChange={event => patch({ locator: event.target.value })} /></label>
      <label>原文引文<Textarea aria-label={`引用原文 ${isLink ? '材料' : '知识'} ${index + 1}`} value={item.quote} onChange={event => patch({ quote: event.target.value })} /></label>
      {isLink && (item as EvidenceLink).relation === 'support' && target.verdict === 'fail' && <Button variant="ghost" className="op" disabled={app.busy}
        onClick={() => patch({ reason: '人工维护引用关系，请重新审阅。' })}>
        {item.reason === '人工维护引用关系，请重新审阅。' ? '已选择人工支持判断' : '核对后采用人工支持判断'}
      </Button>}
      {isLink && <Select value={(item as EvidenceLink).relation || 'context'} onValueChange={value => patch({ relation: value as EvidenceLink['relation'] })}>
        <SelectTrigger aria-label="材料支撑关系"><SelectValue /></SelectTrigger><SelectContent>
          <SelectItem value="context">待复核 / 背景</SelectItem><SelectItem value="support">支持</SelectItem><SelectItem value="contradict">冲突</SelectItem>
        </SelectContent></Select>}
    </div>
  }
  return <Dialog open onOpenChange={open => { if (!open && !app.busy) onClose() }}>
    <DialogContent className="fm-box new-form essential-reference-dialog" onInteractOutside={event => event.preventDefault()}>
      <DialogHeader><DialogTitle>{suggested ? '关联检索结果' : '管理引用'}</DialogTitle>
        <DialogDescription>{suggested ? '请核对检索结果的定位和原文，保存后该引用待重新核验。'
          : '新增引用挂靠当前声明。请填写真实出处的定位与引文，保存后重新核验。'}</DialogDescription></DialogHeader>
      <blockquote>{target.quote}</blockquote>
      <div className="essential-reference-list">{links.map((item, index) => visible(item.id) && fields(item, index, true))}{references.map((item, index) => visible(item.id) && fields(item, index, false))}
        {![...links, ...references].some(item => visible(item.id)) && <p>当前声明暂无引用，可在下方添加。</p>}</div>
      <h3>添加出处</h3>
      <Select value={kind} onValueChange={value => { setKind(value); setSourceId(''); setLocator(''); setQuote('') }}><SelectTrigger aria-label="引用类型"><SelectValue /></SelectTrigger><SelectContent>
        <SelectItem value="evidence">案件材料</SelectItem><SelectItem value="statute">法条条文</SelectItem><SelectItem value="case">案例片段</SelectItem></SelectContent></Select>
      <Input placeholder="搜索当前资料库出处…" aria-label="搜索引用出处" value={query} onChange={event => setQuery(event.target.value)} />
      <Select value={sourceId} onValueChange={value => { const source = options.find(item => item.id === value); setSourceId(value); setLocator(source?.locator || ''); setQuote(source?.quote || '') }}>
        <SelectTrigger aria-label="选择引用出处"><SelectValue placeholder="选择出处" /></SelectTrigger><SelectContent>{options.filter(item => item.label.toLowerCase().includes(query.toLowerCase()))
          .map(item => <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>)}</SelectContent></Select>
      <Input aria-label="新增引用定位" placeholder="页码、段落、条号或片段位置" value={locator} onChange={event => setLocator(event.target.value)} />
      <Textarea aria-label="新增引用原文" placeholder="核对后填写真实引文" value={quote} onChange={event => setQuote(event.target.value)} />
      <Button className="btn btn-gh" disabled={app.busy} onClick={add}>添加到待保存引用</Button>
      {error && <p className="text-fail" role="alert">{error}</p>}
      <div className="fm-ft"><Button className="btn btn-gh" disabled={app.busy} onClick={onClose}>取消</Button>
        <Button className="btn btn-pri" disabled={app.busy} onClick={() => void save()}>保存引用</Button></div>
    </DialogContent>
  </Dialog>
}
