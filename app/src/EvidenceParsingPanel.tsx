import { useEffect, useState } from 'react'
import { api } from './api'
import { EVIDENCE_PARSING_LABELS, type Evidence } from './types'

export function EvidenceParsingPanel({ evidence, busy }: { evidence: Evidence; busy?: boolean }) {
  const [text, setText] = useState(evidence.ocrText)
  const [revision, setRevision] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [blocks, setBlocks] = useState<Array<{ page: number; bbox: number[]; text: string; locator?: string }>>([])
  const [continuity, setContinuity] = useState<Array<{ evidenceId: string; name: string; position: 'before' | 'after'; overlapMessages: number }>>([])
  const parsing = evidence.parsing
  const parsingRevision = parsing?.revision
  const parsingUpdatedAt = parsing?.updatedAt
  useEffect(() => {
    let active = true
    if (!parsingRevision) return
    void api.getEvidenceParsing(evidence.id).then(result => {
      if (!active) return
      setText(result.text)
      setRevision(result.parsing?.revision ?? '')
      setBlocks([...(result.result?.blocks ?? []), ...(result.result?.layout?.blocks ?? [])])
      setContinuity(result.continuityCandidates ?? [])
      setError('')
    }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : '解析结果读取失败') })
    return () => { active = false }
  }, [evidence.id, parsingRevision, parsingUpdatedAt])
  if (!parsing && !['pdf', 'image'].includes(evidence.type)
    && !/\.(docx?|rtf|txt|md|markdown|csv|tsv|json|log)$/i.test(evidence.fileName)) return null
  const running = parsing?.status === 'queued' || parsing?.status === 'processing'
  const disabled = Boolean(busy || saving || running)
  async function perform(action: () => Promise<unknown>) {
    setSaving(true)
    setError('')
    try { await action() } catch (cause) { setError(cause instanceof Error ? cause.message : '操作失败，请重试') }
    finally { setSaving(false) }
  }
  return (
    <section className="evidence-manage" aria-label="材料解析与审核">
      <div className="evidence-manage-head">
        <strong>{parsing ? EVIDENCE_PARSING_LABELS[parsing.status] : '材料解析'}</strong>
        {parsing?.engineVersion && <span>MinerU {parsing.engineVersion}</span>}
      </div>
      {parsing?.error && <p className="evidence-manage-error" role="alert">{parsing.error}</p>}
      {!!parsing?.warnings?.length && <ul>{parsing.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
      {continuity.map(candidate => <p key={`${candidate.evidenceId}-${candidate.position}`}>
        与“{candidate.name}”存在 {candidate.overlapMessages} 条连续重叠消息，对方图片可能在本图{candidate.position === 'before' ? '之前' : '之后'}，请核对原图确认连续性。
      </p>)}
      {parsing && !running && (
        <>
          <label className="field-block">
            对照上方原件核对正文
            <textarea aria-label="待审核解析正文" rows={9} value={text} disabled={saving}
              onChange={event => setText(event.target.value)} />
          </label>
          <details>
            <summary>查看解析来源位置（{blocks.length} 个区域）</summary>
            <div style={{ maxHeight: 200, overflow: 'auto' }}>{blocks.map((block, index) => (
              <p key={index}>{block.locator || `第 ${block.page} 页`}{block.bbox.length > 0 && ` · ${block.bbox.join(', ')}`}<br />{block.text}</p>
            ))}</div>
          </details>
          {parsing.reviewedAt && <p>正文已经人工确认</p>}
        </>
      )}
      {error && <p role="alert" className="evidence-manage-error">{error}</p>}
      <div className="evidence-manage-actions">
        {parsing && <button type="button" className="primary-button" disabled={disabled || !revision || !text.trim()}
          onClick={() => void perform(() => api.reviewEvidenceParsing(evidence.id, revision, text))}>确认正文并继续理解</button>}
        <button type="button" className="ghost-button" disabled={disabled}
          onClick={() => void perform(() => api.retryEvidenceParsing(evidence.id))}>{parsing ? '重新解析' : '开始解析'}</button>
        {evidence.type === 'image' && <button type="button" className="ghost-button" disabled={disabled}
          onClick={() => void perform(() => api.retryEvidenceParsing(evidence.id, 'chat'))}>按聊天截图解析</button>}
      </div>
    </section>
  )
}
