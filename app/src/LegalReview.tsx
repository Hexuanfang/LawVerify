import { useEffect, useRef, useState } from 'react'
import { Extension } from '@tiptap/core'
import type { Editor } from '@tiptap/react'
import type { Node } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { api } from './api'
import './legal-review.css'

export type LegalFinding = {
  from: number; to: number; text: string; kind: 'statute' | 'case'
  status: 'repealed' | 'amended' | 'verified' | 'unverified' | 'invalid_format'
  message: string; sourceUrl?: string; checkedAt?: string
}
function reviewText(doc: Node) {
  let text = '', lastEnd = -1
  const positions: number[] = []
  doc.descendants((node, pos) => {
    if (!node.isText) return
    if (lastEnd >= 0 && pos > lastEnd) { text += '\n'; positions.push(lastEnd) }
    for (let i = 0; i < node.text!.length; i++) { text += node.text![i]; positions.push(pos + i) }
    lastEnd = pos + node.nodeSize
  })
  return { text, positions }
}
const key = new PluginKey<LegalFinding[]>('lawverifyLegalReview')
let localChecks: Promise<unknown> = Promise.resolve()
function queueLocalCheck<T>(task: () => Promise<T>) {
  const result = localChecks.then(task)
  localChecks = result.catch(() => {})
  return result
}
export const LegalReviewExtension = Extension.create({
  name: 'legalReview',
  addProseMirrorPlugins() {
    return [new Plugin<LegalFinding[]>({
      key,
      state: { init: () => [], apply: (tr, current) => tr.getMeta(key) ?? (tr.docChanged ? [] : current) },
      props: {
        decorations(state) {
          const { positions } = reviewText(state.doc)
          return DecorationSet.create(state.doc, (key.getState(state) ?? []).filter(f => f.status !== 'verified').flatMap(f => {
            const from = positions[f.from], end = positions[f.to - 1]
            return from === undefined || end === undefined ? [] : [Decoration.inline(from, end + 1, {
              class: `legal-risk legal-risk-${f.status}`, title: `${f.text}：${f.message}`,
            })]
          }))
        },
      },
    })]
  },
})

export function LegalReview({ editor, active, account, automatic = true, showPanel = true }: {
  editor: Editor | null; active: boolean; account: string; automatic?: boolean; showPanel?: boolean
}) {
  const [findings, setFindings] = useState<LegalFinding[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [truncated, setTruncated] = useState(false)
  const revision = useRef(0)
  const check = useRef<(online: boolean) => void>(() => {})
  useEffect(() => {
    if (!editor) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    const run = async (online: boolean) => {
      const current = ++revision.current
      const doc = editor.state.doc
      const { text } = reviewText(doc)
      if (!text || text.length > 30000) { setError(text.length > 30000 ? '本段较长，请拆分后核验。' : ''); return }
      setBusy(true); setError('')
      try {
        const lookup = () => {
          if (disposed || current !== revision.current || editor.isDestroyed || !editor.state.doc.eq(doc)) return Promise.resolve(null)
          return api.verifyLegalText(text, online)
        }
        const result = online ? await lookup() : await queueLocalCheck(lookup)
        if (!result) return
        if (disposed || current !== revision.current || editor.isDestroyed || !editor.state.doc.eq(doc)) return
        editor.view.dispatch(editor.state.tr.setMeta(key, result.findings))
        setFindings(result.findings); setTruncated(result.truncated)
        if (result.timedOut) setError('部分来源查询超时，未完成的引用仍标为未能核实。')
      } catch (e) {
        if (!disposed && current === revision.current) setError(e instanceof Error ? e.message : '核验失败，请重试。')
      } finally { if (!disposed && current === revision.current) setBusy(false) }
    }
    check.current = online => { clearTimeout(timer); void run(online) }
    const changed = () => {
      revision.current++; setFindings([]); setTruncated(false); setBusy(false)
      clearTimeout(timer)
      if (automatic) timer = setTimeout(() => void run(false), 900)
    }
    editor.on('update', changed)
    const syncFindings = () => setFindings(key.getState(editor.state) ?? [])
    syncFindings()
    editor.on('transaction', syncFindings)
    if (automatic) timer = setTimeout(() => void run(false), 300)
    return () => { disposed = true; revision.current++; clearTimeout(timer); editor.off('update', changed); editor.off('transaction', syncFindings) }
  }, [editor, active, account, automatic])
  if (!active || !editor || !showPanel) return null
  return <aside className="legal-review" aria-label="法律引用核验" onClick={e => e.stopPropagation()}>
    <div className="legal-review-head">
      <strong>法律引用核验</strong>
      <button type="button" disabled={busy} onClick={() => check.current(true)}>{busy ? '核验中…' : '核对官方来源'}</button>
    </div>
    {error ? <p role="alert">{error}</p> : null}
    {truncated ? <p role="alert">本次仅核对前 20 条法律引用和 10 个案号，请分段继续核对。</p> : null}
    {findings.map((f, i) => <div className={`legal-finding legal-finding-${f.status}`} key={`${f.from}:${i}`}>
      <button type="button" className="legal-finding-locate" onClick={() => {
        const { positions } = reviewText(editor.state.doc)
        const from = positions[f.from], to = positions[f.to - 1]
        if (from !== undefined && to !== undefined) editor.chain().focus().setTextSelection({ from, to: to + 1 }).run()
      }}>{f.text}</button>
      <span>{f.message}</span>
      {f.sourceUrl && /^https?:\/\//.test(f.sourceUrl) ? <a href={f.sourceUrl} target="_blank" rel="noreferrer">查看来源</a> : null}
    </div>)}
  </aside>
}
