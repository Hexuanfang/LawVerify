import { useEffect, useMemo, useRef, useState } from 'react'
import type { Certificate } from '../types'
import { documentDraftKey, draftKey, readDraft, readDrafts, removeDraft, writeDraft, type ParagraphDraft } from '../draft-store'
import { contentSnapshot, documentHtml, type DocumentBlock } from './documentContent'
import type { DocxWork } from './documentFile'

type LegacyDraft = Pick<ParagraphDraft, 'key' | 'revision'>
type Recovery = { draft: ParagraphDraft; legacy: LegacyDraft[] }

export function useDocumentDraft(certificate: Certificate,
  commit: (blocks: DocumentBlock[], expected: DocumentBlock[], office?: DocxWork) => Promise<Certificate>) {
  const account = useRef(sessionStorage.getItem('lawverify-login-account') || '')
  const key = documentDraftKey(account.current, certificate.id)
  const currentBlocks = useMemo(() => contentSnapshot(certificate.paragraphs), [certificate.paragraphs])
  const officeVersion = certificate.officeFile?.sha256 ?? 'none'
  const base = useRef(currentBlocks)
  const baseVersion = useRef(officeVersion)
  const [source, setSource] = useState(() => ({ blocks: currentBlocks, format: certificate.officeFile?.format, version: officeVersion }))
  const edited = useRef(false)
  const pending = useRef<ParagraphDraft | null>(null)
  const legacy = useRef<LegacyDraft[]>([])
  const queue = useRef<Promise<void>>(Promise.resolve())
  const hydration = useRef<Promise<void>>(Promise.resolve())
  const recoveryRequired = useRef(false)
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
    hydration.current = (async () => {
      const whole = await readDraft(key)
      if (!live.current) return
      if (whole) {
        const expected = JSON.parse(whole.baseText) as DocumentBlock[]
        if (!Array.isArray(expected)) throw new Error('草稿快照格式不正确')
        recoveryRequired.current = true
        setRecovery({ draft: whole, legacy: JSON.parse(whole.baseRichText || '[]') as LegacyDraft[] })
        return
      }
      const drafts = await readDrafts(certificate.paragraphs.map(paragraph => draftKey(account.current, certificate.id, paragraph.id)))
      if (!live.current) return
      const old = drafts.filter((draft): draft is ParagraphDraft => Boolean(draft))
      if (!old.length) return
      recoveryRequired.current = true
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
      recoveryRequired.current = true
      if (live.current) { setDraftError(true); setNotice('无法读取文书草稿，请检查本机存储后重试。') }
    }).finally(() => { if (live.current) setReady(true) })
    return () => { live.current = false }
    // 文书打开时读取一次，后台刷新通过基线比较处理。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  useEffect(() => {
    if (savingRef.current) return
    const latest = currentBlocks
    if (officeVersion === baseVersion.current && JSON.stringify(latest) === JSON.stringify(base.current)) return
    if (edited.current || pending.current || recovery) setConflict(true)
    else {
      base.current = latest
      baseVersion.current = officeVersion
      setSource({ blocks: latest, format: certificate.officeFile?.format, version: officeVersion })
      setConflict(false)
    }
  }, [currentBlocks, recovery, officeVersion, certificate.officeFile?.format])

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
  const markDirty = () => {
    edited.current = true
    setDirty(true)
    setNotice('正在保存本机草稿…')
  }
  const capture = (blocks: DocumentBlock[], office?: DocxWork) => persist({ key, richText: '', text: JSON.stringify(blocks),
    baseText: JSON.stringify(base.current), baseRichText: JSON.stringify(legacy.current), revision: crypto.randomUUID(), office })

  const restore = async (load: (draft: ParagraphDraft) => Promise<void>) => {
    if (!recovery) return
    try {
      await load(recovery.draft)
      base.current = JSON.parse(recovery.draft.baseText) as DocumentBlock[]
      baseVersion.current = recovery.draft.office?.expectedFileVersion ?? officeVersion
      legacy.current = recovery.legacy
      edited.current = true
      setConflict(baseVersion.current !== officeVersion || JSON.stringify(base.current) !== JSON.stringify(currentBlocks))
      setRecovery(null)
      recoveryRequired.current = false
      persist(recovery.draft)
    } catch (cause) {
      setDraftError(true)
      setNotice(cause instanceof Error ? cause.message : '恢复草稿失败，本机草稿已保留。')
    }
  }
  const discardRecovery = async () => {
    if (!recovery) return
    try {
      await removeDraft(key, recovery.draft.revision)
      await Promise.all(recovery.legacy.map(draft => removeDraft(draft.key, draft.revision)))
      setRecovery(null)
      recoveryRequired.current = false
      setNotice('已载入保存的文书')
    } catch { setNotice('草稿清理失败，请重试。') }
  }
  const save = async () => {
    if (savingRef.current || conflict || recovery) return false
    if (!pending.current) return true
    savingRef.current = true
    setSaving(true)
    const draft = pending.current
    try {
      await queue.current
      const saved = await commit(JSON.parse(draft.text) as DocumentBlock[], base.current, draft.office)
      base.current = contentSnapshot(saved.paragraphs)
      baseVersion.current = saved.officeFile?.sha256 ?? 'none'
      await removeDraft(key, draft.revision)
      await Promise.all(legacy.current.map(item => removeDraft(item.key, item.revision)))
      pending.current = null
      edited.current = false
      legacy.current = []
      setDirty(false)
      setDraftError(false)
      setConflict(false)
      setNotice('整篇文书已保存')
      return saved
    } catch (cause) {
      if (cause instanceof Error && 'status' in cause && cause.status === 409) setConflict(true)
      setNotice(cause instanceof Error ? cause.message : '保存失败，本机草稿已保留。')
      return false
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }
  const adoptLatestBase = () => {
    base.current = currentBlocks
    baseVersion.current = officeVersion
    setConflict(false)
    if (pending.current) capture(JSON.parse(pending.current.text) as DocumentBlock[], pending.current.office && {
      ...pending.current.office, expectedFileVersion: officeVersion,
    })
  }
  const flush = async () => {
    if (pending.current) {
      try { await queue.current; await writeDraft(pending.current); return true }
      catch { setDraftError(true); setNotice('草稿未保存，请重试后再离开。'); return false }
    }
    return true
  }
  const checkLoadedDraft = async () => {
    await hydration.current
    return !recoveryRequired.current && !edited.current
  }
  return { source, ready, dirty, saving, conflict, recovery, notice, draftError,
    markDirty, capture, restore, discardRecovery, save, adoptLatestBase, flush, checkLoadedDraft }
}
