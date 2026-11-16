import { useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/react'
import type { Certificate } from '../types'
import { draftKey, readDraft, removeDraft, writeDraft, type ParagraphDraft } from '../draft-store'
import { contentSnapshot, documentBlocks, documentHtml, type DocumentBlock } from './documentContent'

type LegacyDraft = Pick<ParagraphDraft, 'key' | 'revision'>
type Recovery = { draft: ParagraphDraft; legacy: LegacyDraft[] }

export function useDocumentDraft(certificate: Certificate,
  commit: (blocks: DocumentBlock[], expected: DocumentBlock[]) => Promise<DocumentBlock[]>) {
  const account = useRef(sessionStorage.getItem('lawverify-login-account') || '')
  const key = JSON.stringify(['lawverify-document', account.current.trim().toLowerCase(), certificate.id])
  const base = useRef(contentSnapshot(certificate.paragraphs))
  const [initialHtml, setInitialHtml] = useState(() => documentHtml(certificate.paragraphs))
  const pending = useRef<ParagraphDraft | null>(null)
  const legacy = useRef<LegacyDraft[]>([])
  const queue = useRef<Promise<void>>(Promise.resolve())
  const savingRef = useRef(false)
  const live = useRef(true)
  const [ready, setReady] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [recovery, setRecovery] = useState<Recovery | null>(null)
  const [notice, setNotice] = useState('')
  const [draftError, setDraftError] = useState(false)

  useEffect(() => {
    live.current = true
    void (async () => {
      const whole = await readDraft(key)
      if (!live.current) return
      if (whole) {
        const expected = JSON.parse(whole.baseText) as DocumentBlock[]
        if (!Array.isArray(expected)) throw new Error('草稿快照格式不正确')
        setRecovery({ draft: whole, legacy: JSON.parse(whole.baseRichText || '[]') as LegacyDraft[] })
        return
      }
      const drafts = await Promise.all(certificate.paragraphs.map(paragraph =>
        readDraft(draftKey(account.current, certificate.id, paragraph.id))))
      if (!live.current) return
      const old = drafts.filter((draft): draft is ParagraphDraft => Boolean(draft))
      if (!old.length) return
      const expected = contentSnapshot(certificate.paragraphs)
      const blocks = contentSnapshot(certificate.paragraphs)
      drafts.forEach((draft, index) => {
        if (!draft) return
        expected[index] = { id: blocks[index].id, text: draft.baseText, richText: draft.baseRichText || undefined }
        blocks[index] = { id: blocks[index].id, text: draft.text, richText: draft.richText }
      })
      setRecovery({ draft: { key, revision: crypto.randomUUID(), text: JSON.stringify(blocks),
        richText: documentHtml(blocks), baseText: JSON.stringify(expected), baseRichText: JSON.stringify(old.map(({ key, revision }) => ({ key, revision }))) }, legacy: old })
    })().catch(() => {
      if (live.current) { setDraftError(true); setNotice('无法读取文书草稿，请检查本机存储后重试。') }
    }).finally(() => { if (live.current) setReady(true) })
    return () => { live.current = false }
    // 文书打开时读取一次，后台刷新通过基线比较处理。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  useEffect(() => {
    if (savingRef.current) return
    const latest = contentSnapshot(certificate.paragraphs)
    if (JSON.stringify(latest) === JSON.stringify(base.current)) return
    if (pending.current || recovery) setConflict(true)
    else {
      base.current = latest
      setInitialHtml(documentHtml(latest))
      setConflict(false)
    }
  }, [certificate.paragraphs, recovery])

  const persist = (draft: ParagraphDraft) => {
    pending.current = draft
    setDirty(true)
    setNotice('正在保存本机草稿…')
    queue.current = queue.current.catch(() => {}).then(() => writeDraft(draft)).then(() => {
      if (live.current && pending.current?.revision === draft.revision) {
        setDraftError(false)
        setNotice('修改已保存在本机草稿')
      }
    }).catch(() => {
      if (live.current) { setDraftError(true); setNotice('本机草稿保存失败，请保存文书或重试后再离开。') }
    })
  }
  const capture = (html: string) => persist({ key, richText: html, text: JSON.stringify(documentBlocks(html)),
    baseText: JSON.stringify(base.current), baseRichText: JSON.stringify(legacy.current), revision: crypto.randomUUID() })

  const restore = (editor: Editor) => {
    if (!recovery) return
    base.current = JSON.parse(recovery.draft.baseText) as DocumentBlock[]
    legacy.current = recovery.legacy
    editor.commands.setContent(recovery.draft.richText, { emitUpdate: false, parseOptions: { preserveWhitespace: 'full' } })
    setConflict(JSON.stringify(base.current) !== JSON.stringify(contentSnapshot(certificate.paragraphs)))
    setRecovery(null)
    persist(recovery.draft)
  }
  const discardRecovery = async () => {
    if (!recovery) return
    try {
      await removeDraft(key, recovery.draft.revision)
      await Promise.all(recovery.legacy.map(draft => removeDraft(draft.key, draft.revision)))
      setRecovery(null)
      setNotice('已载入保存的文书')
    } catch { setNotice('草稿清理失败，请重试。') }
  }
  const save = async (editor: Editor) => {
    if (savingRef.current || conflict || recovery) return false
    if (!pending.current) return true
    savingRef.current = true
    editor.setEditable(false, false)
    setSaving(true)
    const draft = pending.current
    try {
      await queue.current
      const saved = await commit(JSON.parse(draft.text) as DocumentBlock[], base.current)
      base.current = contentSnapshot(saved)
      await removeDraft(key, draft.revision)
      await Promise.all(legacy.current.map(item => removeDraft(item.key, item.revision)))
      pending.current = null
      legacy.current = []
      setDirty(false)
      setDraftError(false)
      setConflict(false)
      setNotice('整篇文书已保存')
      return true
    } catch (cause) {
      if (cause instanceof Error && 'status' in cause && cause.status === 409) setConflict(true)
      setNotice(cause instanceof Error ? cause.message : '保存失败，本机草稿已保留。')
      return false
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }
  const adoptLatestBase = (editor: Editor) => {
    base.current = contentSnapshot(certificate.paragraphs)
    setConflict(false)
    capture(editor.getHTML())
  }
  const flush = async () => {
    if (pending.current) {
      try { await queue.current; await writeDraft(pending.current); return true }
      catch { setDraftError(true); setNotice('草稿未保存，请重试后再离开。'); return false }
    }
    return true
  }
  return { initialHtml, ready, dirty, saving, conflict, recovery, notice, draftError,
    capture, restore, discardRecovery, save, adoptLatestBase, flush }
}
