import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { VoiceInputButton } from '../AssistantControls'
import { useApp } from './AppContext'
import { Button } from './components/ui/button'
import { Textarea } from './components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './components/ui/select'
import { runDocumentAction } from './documentBilling'
import './document-assistant.css'

type GeneratedDraft = { title: string; paragraphs: string[] }

export function DocumentAssistant() {
  const app = useApp()
  const caseId = app.project!.id
  const evidence = app.workspace!.evidences.filter(item => item.caseId === caseId)
  const account = sessionStorage.getItem('lawverify-login-account')
  const session = sessionStorage.getItem('lawverify-auth-session')
  const token = localStorage.getItem('lawverify-cloud-token')
  const [mode, setMode] = useState<'generate' | 'rewrite'>('generate')
  const [prompt, setPrompt] = useState('')
  const [model, setModel] = useState('default')
  const [models, setModels] = useState<Array<{ id: string; label: string }>>([])
  const [selected, setSelected] = useState<string[]>(() => evidence.map(item => item.id))
  const [running, setRunning] = useState(false)
  const [voiceBusy, setVoiceBusy] = useState(false)
  const voiceDone = useRef<(() => void) | null>(null)
  const [draft, setDraft] = useState<GeneratedDraft | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [unsaved, setUnsaved] = useState(false)
  const controller = useRef<AbortController | null>(null)
  const live = useRef(true)
  const pending = useRef<GeneratedDraft>({ title: '', paragraphs: [] })
  const active = useRef(false)
  const current = () => live.current &&
    account === sessionStorage.getItem('lawverify-login-account') &&
    session === sessionStorage.getItem('lawverify-auth-session') &&
    token === localStorage.getItem('lawverify-cloud-token')

  useEffect(() => {
    live.current = true
    let mounted = true
    void api.assistantCapabilities().then(result => {
      if (mounted) setModels(result.models)
    }).catch(cause => {
      if (mounted) setError(cause instanceof Error ? cause.message : '模型列表暂不可用')
    })
    return () => { mounted = false; live.current = false; controller.current?.abort(); voiceDone.current?.() }
  }, [])

  const savePartial = async () => {
    const paragraphs = pending.current.paragraphs.filter(text => text.trim())
    if (!paragraphs.length || !current()) return ''
    const result = await api.importCertificate({
      caseId,
      title: `${pending.current.title || app.project!.name}（中断草稿）`,
      sourceFileName: '生成中断草稿',
      content: paragraphs.join('\n\n'),
      paragraphs: paragraphs.map(text => ({ text })),
    })
    if (!current()) return ''
    setUnsaved(false)
    return result.certificate.id
  }
  const retryDraft = async () => {
    let documentId = ''
    if (await app.run(async () => { documentId = await savePartial() }, '已保存中断草稿')) {
      if (documentId && current()) app.setCaseIdForUpload(caseId, documentId)
    }
  }
  const start = async () => {
    if (active.current || app.busy) return
    const evidenceIds = selected.filter(id => evidence.some(item => item.id === id))
    setError('')
    setNotice('')
    if (mode === 'generate' && !evidenceIds.length) { setError('请勾选本次起草使用的材料'); return }
    if (mode === 'rewrite' && (!app.certificate || !prompt.trim())) { setError('请先选择文书并填写改写要求'); return }
    active.current = true
    try {
      if (!(await app.prepareDocument()) || !current()) return
      let certificate = app.certificate
      const operationKey = `pleading_full:${certificate?.id || caseId}:${crypto.randomUUID()}`
      const abort = new AbortController()
      controller.current = abort
      pending.current = { title: mode === 'rewrite' ? certificate!.title : `${app.project!.name}法律文书`, paragraphs: [] }
      setDraft({ ...pending.current })
      setUnsaved(false)
      setRunning(true)
      let completed = false
      let documentId = ''
      const saved = await app.run(async () => {
        try {
          if (mode === 'rewrite') {
            certificate = (await api.getWorkspace()).workspace.certificates.find(item => item.id === certificate?.id && item.caseId === caseId)
            if (!certificate) throw new Error('当前文书已不存在，请重新选择文书。')
          }
          await runDocumentAction({ cloudBilling: app.workspace?.aiBillingMode === 'cloud', token, operationKey, isCurrent: current }, {
            charge: () => api.consumeCloudPointAction({
              actionType: 'pleading_full', idempotencyKey: operationKey, workspaceId: caseId,
              resourceType: mode === 'rewrite' ? 'certificate' : 'case',
              resourceId: mode === 'rewrite' ? certificate!.id : caseId,
              note: mode === 'rewrite' ? `整文改写：${certificate!.title}` : `整文生成：${app.project!.name}`,
            }, token!),
            refund: (entryId, key, note) => api.refundCloudPointAction({ sourceEntryId: entryId, refundOperationKey: key, note }, token!),
            refresh: () => window.dispatchEvent(new Event('lawverify-points-changed')),
          }, async () => {
            abort.signal.throwIfAborted()
            if (!current()) throw new Error('账号会话已变化，已停止本次文书操作。')
            const handlers = {
              onMeta: (event: { title?: string }) => {
                if (!current()) return
                if (event.title) pending.current.title = event.title
                setDraft({ ...pending.current, paragraphs: [...pending.current.paragraphs] })
              },
              onParagraph: (event: { index: number; text: string }) => {
                if (!current()) return
                pending.current.paragraphs[event.index] = event.text
                setDraft({ ...pending.current, paragraphs: [...pending.current.paragraphs] })
              },
              onDone: (result: { certificate: { id: string }; agentReply?: string }) => {
                completed = true
                if (!current()) return
                documentId = result.certificate.id
                setNotice(result.agentReply || '文书已保存，可继续编辑与核验')
              },
            }
            if (mode === 'rewrite') {
              const linked = certificate!.paragraphs.flatMap(paragraph =>
                (paragraph.links?.length ? paragraph.links : paragraph.link ? [paragraph.link] : []).map(link => link.evidenceId))
              await api.rewriteCertificateStream({ certificateId: certificate!.id, evidenceIds: evidenceIds.length ? evidenceIds : [...new Set(linked)], prompt: prompt.trim(), model: model === 'default' ? undefined : model }, handlers, abort.signal)
            } else {
              const folder = app.workspace!.cases.find(item => item.id === caseId)
              await api.generateCertificateStream({ caseId, evidenceIds, prompt: prompt.trim() || undefined,
                focus: prompt.trim() || '请结合本案证据起草法律文书', role: folder?.agent?.position?.role === 'defendant' ? 'defendant' : 'plaintiff', model: model === 'default' ? undefined : model }, handlers, abort.signal)
            }
          })
        } catch (cause) {
          if (!current()) throw cause
          if (!completed && abort.signal.aborted) {
            try {
              documentId = await savePartial()
              setNotice(documentId ? '已停止，生成内容已保存为中断草稿' : '已停止本次生成')
            } catch (saveError) {
              setUnsaved(true)
              throw saveError
            }
          } else {
            if (pending.current.paragraphs.some(text => text?.trim())) setUnsaved(true)
            throw cause
          }
        }
      })
      if (current() && saved) {
        if (documentId) app.setCaseIdForUpload(caseId, documentId)
        if (completed) setPrompt('')
      }
    } catch (cause) {
      if (current()) setError(cause instanceof Error ? cause.message : '文书处理失败')
    } finally {
      controller.current = null
      active.current = false
      if (live.current) setRunning(false)
    }
  }
  const onVoiceBusy = (value: boolean) => {
    if (!value) {
      voiceDone.current?.()
      voiceDone.current = null
      if (live.current) setVoiceBusy(false)
      return
    }
    setVoiceBusy(true)
    void app.run(() => new Promise<void>(resolve => { voiceDone.current = resolve }))
  }
  const blocked = running || voiceBusy || app.busy
  return <section className="document-assistant" aria-label="文书起草与改写">
    <div className="document-assistant-mode" role="group" aria-label="文书操作">
      <Button variant={mode === 'generate' ? 'default' : 'outline'} disabled={blocked} onClick={() => setMode('generate')}>起草文书</Button>
      <Button variant={mode === 'rewrite' ? 'default' : 'outline'} disabled={blocked || !app.certificate} onClick={() => setMode('rewrite')}>改写当前文书</Button>
    </div>
    <label className="document-assistant-label">使用模型</label>
    <Select value={model} onValueChange={setModel} disabled={blocked}>
      <SelectTrigger aria-label="文书生成模型"><SelectValue /></SelectTrigger>
      <SelectContent><SelectItem value="default">默认模型</SelectItem>{models.map(item => <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>)}</SelectContent>
    </Select>
    <details className="document-evidence-selection" open>
      <summary>本次使用的材料 · 已选 {selected.filter(id => evidence.some(item => item.id === id)).length}/{evidence.length}</summary>
      <div className="document-evidence-actions">
        <Button variant="ghost" disabled={blocked} onClick={() => setSelected(evidence.map(item => item.id))}>全选</Button>
        <Button variant="ghost" disabled={blocked} onClick={() => setSelected([])}>清空</Button>
      </div>
      {evidence.map(item => <label className="document-evidence-option" key={item.id}>
        <input type="checkbox" checked={selected.includes(item.id)} disabled={blocked} onChange={event => setSelected(currentIds => event.target.checked ? [...currentIds, item.id] : currentIds.filter(id => id !== item.id))} />
        <span>{item.number} {item.name || item.fileName}</span>
      </label>)}
      {!evidence.length && <p>请先链接案件材料目录</p>}
    </details>
    <label htmlFor="document-ai-prompt" className="document-assistant-label">{mode === 'generate' ? '文书类型与起草要求' : '改写要求'}</label>
    <Textarea id="document-ai-prompt" value={prompt} maxLength={6000} disabled={blocked} onChange={event => setPrompt(event.target.value)} placeholder={mode === 'generate' ? '例如，起草民事起诉状，明确诉讼请求和事实理由。' : '说明需要调整的内容、论证或表达。'} />
    <VoiceInputButton disabled={app.busy || running} onBusy={onVoiceBusy}
      onError={text => { if (current()) setError(text) }}
      onText={text => { if (current()) setPrompt(value => [value, text].filter(Boolean).join('\n').slice(0, 6000)) }} />
    <div className="document-assistant-actions">
      {running ? <Button variant="outline" onClick={() => controller.current?.abort()}>停止生成</Button>
        : <Button disabled={app.busy || unsaved || (mode === 'generate' ? !selected.length : !app.certificate || !prompt.trim())} onClick={() => void start()}>{mode === 'generate' ? '开始起草' : '开始改写'}</Button>}
      {unsaved && <Button variant="outline" disabled={app.busy} onClick={() => void retryDraft()}>保存已生成草稿</Button>}
    </div>
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {draft && <div className="document-generated-preview" aria-live="polite" aria-busy={running}>
      <h3>{draft.title}</h3>
      {draft.paragraphs.filter(Boolean).map((text, index) => <p key={index}>{text}</p>)}
      {running && !draft.paragraphs.length && <p>正在准备文书…</p>}
    </div>}
  </section>
}
