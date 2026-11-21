import { useEffect, useRef, useState } from 'react'
import { api, type AssistantDraftPreview } from '../api'
import { useApp } from './AppContext'
import { Button } from './components/ui/button'
import { runDocumentAction } from './documentBilling'
import { rewriteAnchor, type RewriteAnchor } from './rewriteAnchor'
import type { RewriteSelection } from '../../../server/src/intelligence/verification/rewrite-selection'
import type { AssistantDocumentContext } from '../../../server/src/assistant/context'
import './document-assistant.css'

type GeneratedDraft = { title: string; paragraphs: string[] }

export function useDocumentAssistant(quote?: string, selection?: RewriteSelection) {
  const app = useApp()
  const caseId = app.project!.id
  const evidence = app.workspace!.evidences.filter(item => item.caseId === caseId)
  const position = app.workspace!.cases.find(item => item.id === caseId)?.agent?.position
  const draftRole = position?.confirmedAt ? position.role : undefined
  const account = sessionStorage.getItem('lawverify-login-account')
  const session = sessionStorage.getItem('lawverify-auth-session')
  const token = localStorage.getItem('lawverify-cloud-token')
  const [mode, setMode] = useState<'generate' | 'rewrite'>('generate')
  const [running, setRunning] = useState(false)
  const [draft, setDraft] = useState<GeneratedDraft | null>(null)
  const [draftPreview, setDraftPreview] = useState<(AssistantDraftPreview & { targetId?: string; supplementTarget?: RewriteAnchor }) | null>(null)
  const [rewritePreview, setRewritePreview] = useState<{ target: RewriteAnchor; text: string; version: string }>()
  const [recheckId, setRecheckId] = useState<string>()
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const controller = useRef<AbortController | null>(null)
  const live = useRef(true)
  const pending = useRef<GeneratedDraft>({ title: '', paragraphs: [] })
  const lastOutput = useRef<{ mode: 'generate' | 'rewrite'; instruction: string; text: string } | null>(null)
  const active = useRef(false)
  const rewriteTarget = rewriteAnchor(app.certificate, quote, selection)
  const supplementTarget = quote && selection ? rewriteAnchor(app.certificate, selection.quote, selection) : rewriteTarget
  const current = () => live.current &&
    account === sessionStorage.getItem('lawverify-login-account') &&
    session === sessionStorage.getItem('lawverify-auth-session') &&
    token === localStorage.getItem('lawverify-cloud-token')

  useEffect(() => {
    live.current = true
    return () => { live.current = false; controller.current?.abort() }
  }, [])

  const discardDraft = async () => {
    if (!draftPreview || active.current || app.busy || !current()) return
    active.current = true
    try {
      await api.discardAssistantCandidate(draftPreview.candidateId)
      if (!current()) return
      setDraftPreview(null)
      setDraft(null)
      setError('')
      setNotice('已放弃候选。')
      await app.auditAssistantAction(draftPreview.targetId, draftPreview.supplementTarget ? '律师放弃 AI 补写候选' : '律师放弃 AI 起草候选', draftPreview.supplementTarget)
    } catch (cause) {
      if (current()) setError(cause instanceof Error ? cause.message : '暂时无法放弃候选。')
    } finally {
      active.current = false
    }
  }
  const adoptDraft = async () => {
    if (!draftPreview || active.current || app.busy || !current()) return
    const supplement = draftPreview.supplementTarget
    if (supplement && supplement.id !== supplementTarget?.id) { setError('补写选区已变化，请重新生成候选。'); return }
    active.current = true
    try {
      if (!await app.prepareDocument() || !current()) return
      let documentId = ''
      let elementId: string | undefined
      const ok = await app.run(async () => {
        const result = await api.adoptAssistantCandidate(draftPreview.candidateId, { caseId, certificateId: draftPreview.targetId })
        documentId = result.certificateId
        elementId = result.elementId
      }, supplement ? '已插入补写，新增声明待核验' : '已保存草稿，新增声明待核验')
      if (ok && documentId && current()) {
        setDraftPreview(null)
        setDraft(null)
        setNotice(supplement ? '补写已插入选区最后一项声明之后，新增声明待核验。' : '草稿已保存，新增声明待核验。')
        if (!supplement) app.setCaseIdForUpload(caseId, documentId)
        else if (elementId) { app.setFilter('all'); app.select(elementId) }
      }
    } finally {
      active.current = false
    }
  }
  const start = async (mode: 'generate' | 'rewrite', prompt: string, lawyerNote?: string, context?: AssistantDocumentContext, previousInstruction?: string) => {
    if (active.current || app.busy) return
    const evidenceIds = evidence.map(item => item.id)
    const supplement = mode === 'generate' && Boolean(quote)
    const currentInstruction = prompt.trim()
    const previous = lastOutput.current
    const prior = previousInstruction && previous?.mode === mode && previous.instruction === previousInstruction
      ? `\n\n上一轮要求：${previousInstruction.slice(0, 1500)}\n上一轮候选正文（供本轮修改参考）：\n${previous.text}` : ''
    const instruction = currentInstruction + prior.slice(0, Math.max(0, 6000 - currentInstruction.length))
    const target = supplement ? supplementTarget : rewriteTarget
    setError('')
    setNotice('')
    if (mode === 'generate' && !draftRole) { setError('请先在「案件记忆」中确认代理立场。'); return }
    if (mode === 'generate' && !evidenceIds.length) { setError('请先为案件链接原材料。'); return }
    if (supplement && !target) { setError('请在已保存的当前文书中重新选择补写位置。'); return }
    if (mode === 'rewrite' && (!rewriteTarget || !currentInstruction)) { setError('请从当前文书选择可唯一定位的选段，并填写改写要求。'); return }
    active.current = true
    setRunning(true)
    try {
      if (!(await app.prepareDocument()) || !current()) return
      let certificate = app.certificate
      const operationKey = `pleading_full:${certificate?.id || caseId}:${crypto.randomUUID()}`
      const abort = new AbortController()
      controller.current = abort
      setMode(mode)
      pending.current = { title: mode === 'rewrite' ? certificate!.title : supplement ? '选区补写候选' : `${app.project!.name}法律文书`, paragraphs: [] }
      if (draftPreview) {
        const preview = draftPreview
        void api.discardAssistantCandidate(preview.candidateId).then(() => {
          if (current()) void app.auditAssistantAction(preview.targetId, '律师重新生成，放弃上一候选', preview.supplementTarget)
        }).catch(() => {})
      }
      setDraft({ ...pending.current })
      setDraftPreview(null)
      setRewritePreview(undefined)
      let completed = false
      await app.run(async () => {
        try {
          if (mode === 'rewrite' || supplement) {
            certificate = (await api.getWorkspace()).workspace.certificates.find(item => item.id === certificate?.id && item.caseId === caseId)
            if (!certificate) throw new Error('当前文书已不存在，请重新选择文书。')
            const currentTarget = target && rewriteAnchor(certificate, target.quote, target)
            if (!target || !currentTarget || currentTarget.id !== target.id || currentTarget.original.text !== target.original.text)
              throw new Error('正文选区已变化，请重新选择。')
          }
          await runDocumentAction({ cloudBilling: app.workspace?.aiBillingMode === 'cloud', token, operationKey, isCurrent: current }, {
            charge: () => api.consumeCloudPointAction({
              actionType: 'pleading_full', idempotencyKey: operationKey, workspaceId: caseId,
              resourceType: mode === 'rewrite' ? 'certificate' : 'case',
              resourceId: mode === 'rewrite' ? certificate!.id : caseId,
              note: mode === 'rewrite' ? `选区改写：${certificate!.title}` : supplement ? `选区补写：${certificate!.title}` : `整文生成：${app.project!.name}`,
            }, token!),
            refund: (entryId, key, note) => api.refundCloudPointAction({ sourceEntryId: entryId, refundOperationKey: key, note }, token!),
            refresh: () => window.dispatchEvent(new Event('lawverify-points-changed')),
          }, async () => {
            abort.signal.throwIfAborted()
            if (!current()) throw new Error('账号会话已变化，已停止本次文书操作。')
            const handlers = {
              onMeta: (event: { title?: string }) => {
                if (!current()) return
                if (event.title && !supplement) pending.current.title = event.title
                setDraft({ ...pending.current, paragraphs: [...pending.current.paragraphs] })
              },
              onParagraph: (event: { index: number; text: string }) => {
                if (!current()) return
                pending.current.paragraphs[event.index] = event.text
                setDraft({ ...pending.current, paragraphs: [...pending.current.paragraphs] })
              },
            }
            if (mode === 'rewrite') {
              const linked = certificate!.paragraphs.flatMap(paragraph =>
                (paragraph.links?.length ? paragraph.links : paragraph.link ? [paragraph.link] : []).map(link => link.evidenceId))
              await api.rewriteCertificateStream({ certificateId: certificate!.id, evidenceIds: evidenceIds.length ? evidenceIds : [...new Set(linked)],
                selection: { paragraphId: rewriteTarget!.paragraphId, start: rewriteTarget!.start, quote: rewriteTarget!.quote },
                prompt: instruction, lawyerNote, context }, { ...handlers, onDone: result => {
                  if (!current()) return
                  if (!rewriteTarget || !result.rewritePreview || !result.rewriteVersion || result.certificate.id !== rewriteTarget.certificateId)
                    throw new Error('没有收到经校验的选区候选，原文未修改。')
                  completed = true
                  lastOutput.current = { mode, instruction: currentInstruction, text: result.rewritePreview }
                  setRewritePreview({ target: rewriteTarget, text: result.rewritePreview, version: result.rewriteVersion })
                  setDraft({ title: '选区改写候选', paragraphs: [result.rewritePreview] })
                  setNotice('候选尚未写入文书。')
                  void app.auditAssistantAction(rewriteTarget.certificateId, 'AI 生成选区改写候选', rewriteTarget)
                } }, abort.signal)
            } else {
              if (!draftRole) throw new Error('请先确认代理立场。')
              const targetId = certificate?.id
              const selection = supplement && target
                ? { paragraphId: target.paragraphId, start: target.start, quote: target.quote } : undefined
              await api.previewAssistantDraft({ caseId, certificateId: targetId, evidenceIds, prompt: instruction || undefined,
                focus: instruction || '请结合本案证据起草法律文书', role: draftRole, selection, lawyerNote, context },
              { ...handlers, onDone: result => {
                if (!current()) return
                if (!result.candidateId || !result.certificate.paragraphs.length) throw new Error('没有收到可采纳的文书候选。')
                completed = true
                lastOutput.current = { mode, instruction: currentInstruction, text: result.certificate.paragraphs.map(item => item.text).join('\n\n') }
                setDraftPreview({ ...result, targetId, supplementTarget: supplement ? target : undefined })
                setDraft({ title: result.certificate.title, paragraphs: result.certificate.paragraphs.map(item => item.text) })
                setNotice(supplement ? '补写候选已生成，采纳后插入选区最后一项声明之后。' : '起草候选已生成，请核对正文及出处后采纳。')
                void app.auditAssistantAction(targetId, supplement ? 'AI 生成选区补写候选' : 'AI 生成起草候选', supplement ? target : undefined)
              } }, abort.signal)
            }
          })
        } catch (cause) {
          if (!completed && abort.signal.aborted) return
          throw cause
        }
      })
    } catch (cause) {
      if (current()) setError(cause instanceof Error ? cause.message : '文书处理失败')
    } finally {
      controller.current = null
      active.current = false
      if (live.current) setRunning(false)
    }
  }
  const adoptRewrite = async () => {
    if (!rewritePreview || !rewriteTarget || rewritePreview.target.id !== rewriteTarget.id || rewritePreview.target.quote !== rewriteTarget.quote || active.current || app.busy || !current()) return
    active.current = true
    try {
      if (await app.prepareDocument() && current()) {
        const status = await app.applyAssistantRewrite(rewritePreview.target, rewritePreview.text, rewritePreview.version)
        if (!status || !current()) return
        setRewritePreview(undefined)
        setDraft(null)
        setRecheckId(status === 'pending' ? rewritePreview.target.certificateId : undefined)
        setNotice(status === 'complete' ? '已采纳选区改写，局部重核已执行，请查看核验结果。' : '已采纳选区改写，改写内容待核验。')
      }
    } finally {
      active.current = false
    }
  }
  const retryRecheck = async () => {
    if (!recheckId || active.current || app.busy || !current()) return
    active.current = true
    try {
      if (await app.run(() => api.retryAssistantRewriteRecheck(recheckId)) && current()) {
        setRecheckId(undefined)
        setNotice('局部重核已执行，请查看核验结果。')
      }
    } finally {
      active.current = false
    }
  }
  const blocked = running || app.busy
  const result = (error || notice || draft || recheckId) && <section className="document-assistant" aria-label="文书起草与改写">
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {recheckId && <Button variant="outline" disabled={blocked} onClick={() => void retryRecheck()}>重试局部重核</Button>}
    {draft && <div className="document-generated-preview" aria-live="polite" aria-busy={running}>
      <h3>{draft.title}</h3>
      {draft.paragraphs.filter(Boolean).map((text, index) => <p key={index}>{text}</p>)}
      {running && !draft.paragraphs.length && <p>正在准备文书…</p>}
      {mode === 'generate' && draftPreview && <>
        {draftPreview.supplementTarget && <p>插入位置 · 选区最后一项声明之后</p>}
        {draftPreview.authorityNotice && <p>{draftPreview.authorityNotice}</p>}
        {!!draftPreview.draft.items.length && <details>
          <summary>声明与出处 · {draftPreview.draft.items.length} 条待核</summary>
          <ul>{draftPreview.draft.items.map((item, index) => <li key={index}>
            <p>{item.quote}</p>
            {item.sources.length ? <ul>{item.sources.map(source => <li key={`${source.tier}:${source.id}`}>
              {source.name}{source.locator && ` · ${source.locator}`}
            </li>)}</ul> : <small>暂无已核出处</small>}
          </li>)}</ul>
        </details>}
        <div className="document-assistant-actions">
          <Button disabled={blocked || !draftRole || Boolean(draftPreview.supplementTarget && draftPreview.supplementTarget.id !== supplementTarget?.id)}
            onClick={() => void adoptDraft()}>{draftPreview.supplementTarget ? '采纳并插入补写' : '采纳并保存草稿'}</Button>
          <Button variant="outline" disabled={blocked} onClick={() => void discardDraft()}>放弃候选</Button>
        </div>
      </>}
      {mode === 'rewrite' && rewritePreview && <div className="document-assistant-actions">
        <Button disabled={blocked || rewriteTarget?.id !== rewritePreview.target.id || rewritePreview.text === rewritePreview.target.quote}
          onClick={() => void adoptRewrite()}>采纳并替换选区</Button>
        <Button variant="outline" disabled={blocked} onClick={() => {
          const target = rewritePreview.target
          void app.auditAssistantAction(target.certificateId, '律师放弃 AI 改写候选', target)
          setRewritePreview(undefined)
          setDraft(null)
          setNotice('已放弃候选，原文未修改。')
        }}>放弃候选</Button>
      </div>}
    </div>}
  </section>
  return { start, running, result, draftRole, hasResult: Boolean(result), paragraphCount: draft?.paragraphs.length ?? 0 }
}
