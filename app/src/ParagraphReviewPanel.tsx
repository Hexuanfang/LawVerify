import { useState } from 'react'
import type { CertificateParagraph, EvidenceLink } from './types'
import './paragraph-review.css'

export function ParagraphReviewPanel({ paragraph, link, locator, onLocatorChange, onLocatorCommit, onNoteChange }: {
  paragraph: CertificateParagraph | null
  link: EvidenceLink | null
  locator: string
  onLocatorChange: (value: string) => void
  onLocatorCommit: (locator: string) => void
  onNoteChange: (note: string) => void
}) {
  const [note, setNote] = useState(paragraph?.note ?? '')
  const [savedNote, setSavedNote] = useState(paragraph?.note ?? '')
  const [status, setStatus] = useState('')

  if (!paragraph) return null

  const noteDirty = note !== savedNote
  const locatorDirty = Boolean(link) && locator !== (link?.locator ?? '')

  async function saveNote() {
    if (!noteDirty) return
    await onNoteChange(note)
    setSavedNote(note)
    setStatus('批注已保存')
  }

  async function saveLocator() {
    if (!link || !locatorDirty) return
    await onLocatorCommit(locator)
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
          onChange={event => setNote(event.target.value)}
          onBlur={() => { void saveNote() }}
          placeholder="记录修改理由、待补证点或庭审提醒"
        />
      </label>

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
          disabled={!noteDirty}
        >
          保存批注
        </button>
        {status ? <span className="paragraph-review-status" role="status">{status}</span> : null}
      </div>
    </section>
  )
}
