import { useEffect, useRef, useState } from 'react'
import type { CertificateParagraph, EvidenceLink } from './types'
import './paragraph-review.css'

function formatSavedTime() {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(now.getHours())}:${pad(now.getMinutes())}`
}

export function ParagraphReviewPanel({ paragraph, link, locator, onLocatorChange, onLocatorCommit, onNoteChange }: {
  paragraph: CertificateParagraph | null
  link: EvidenceLink | null
  locator: string
  onLocatorChange: (value: string) => void
  onLocatorCommit: (locator: string) => void | Promise<boolean | void>
  onNoteChange: (note: string) => void | Promise<boolean | void>
}) {
  const [note, setNote] = useState(paragraph?.note ?? '')
  const [savedNote, setSavedNote] = useState(paragraph?.note ?? '')
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)

  // 切换段落时同步批注草稿，避免沿用上一段的内容或已保存状态。
  useEffect(() => {
    setNote(paragraph?.note ?? '')
    setSavedNote(paragraph?.note ?? '')
    setStatus('')
    setError('')
  }, [paragraph?.id])

  if (!paragraph) return null

  const noteDirty = note !== savedNote
  const locatorDirty = Boolean(link) && locator !== (link?.locator ?? '')

  async function saveNote() {
    // 失焦与点击可能同时触发，用 ref 兜住并发，避免重复提交与状态错乱。
    if (savingRef.current || note === savedNote) return
    savingRef.current = true
    setSaving(true)
    setError('')
    try {
      const result = await Promise.resolve(onNoteChange(note))
      if (result === false) {
        setError('批注保存失败，请检查网络后重试。')
        return
      }
      setSavedNote(note)
      setStatus(`批注已保存 ${formatSavedTime()}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : '批注保存失败，请稍后重试。')
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  async function saveLocator() {
    if (!link || !locatorDirty) return
    const result = await Promise.resolve(onLocatorCommit(locator))
    if (result === false) {
      setError('定位信息更新失败，请稍后重试。')
      return
    }
    setStatus('定位信息已更新')
  }

  return (
    <section className="paragraph-review" aria-label="段落核验">
      <div className="paragraph-review-head">
        <strong>段落核验</strong>
        <span>定位与批注会随文书一并导出</span>
      </div>

      <label className="field-block">
        定位信息
        <input
          value={locator}
          onChange={event => onLocatorChange(event.target.value)}
          placeholder="如：第 3 页 / 图片签名区域 / 段落 2"
          disabled={!link}
        />
      </label>
      {link ? null : (
        <p className="paragraph-review-hint">当前段落尚未绑定证据，定位信息需先建立证据关联。</p>
      )}

      <label className="field-block">
        核验批注
        <textarea
          value={note}
          onChange={event => { setNote(event.target.value); setStatus(''); setError('') }}
          onKeyDown={event => {
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
              event.preventDefault()
              void saveNote()
            }
          }}
          placeholder="记录修改理由、待补证点或庭审提醒"
        />
      </label>
      <p className="paragraph-review-hint">修改后点击「保存批注」，或按 Ctrl/⌘ + Enter 保存。</p>

      <div className="paragraph-review-actions">
        {link ? (
          <button
            className="ghost-button"
            type="button"
            onClick={() => void saveLocator()}
            disabled={!locatorDirty}
          >
            保存定位
          </button>
        ) : null}
        <button
          className="ghost-button"
          type="button"
          onClick={() => { void saveNote() }}
          disabled={!noteDirty || saving}
        >
          {saving ? '保存中...' : '保存批注'}
        </button>
        {status ? <span className="paragraph-review-status" role="status">{status}</span> : null}
        {error ? <span className="paragraph-review-error" role="alert">{error}</span> : null}
      </div>
    </section>
  )
}
