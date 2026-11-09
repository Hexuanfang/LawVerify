import { useState } from 'react'
import type { Evidence } from './types'
import './evidence-manage.css'

export function EvidenceManagePanel({ evidence, busy, onUpdate, onDelete }: {
  evidence: Evidence
  busy?: boolean
  onUpdate: (patch: { name?: string; ocrText?: string }) => void | Promise<void>
  onDelete: () => void | Promise<void>
}) {
  const [name, setName] = useState(evidence.name)
  const [ocrText, setOcrText] = useState(evidence.ocrText)
  const [syncedSource, setSyncedSource] = useState(`${evidence.name}\u0000${evidence.ocrText}`)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  // 服务端回写材料后同步草稿；切换材料由 key 变化触发重挂载，无需在此处理。
  const sourceKey = `${evidence.name}\u0000${evidence.ocrText}`
  if (sourceKey !== syncedSource) {
    setSyncedSource(sourceKey)
    setName(evidence.name)
    setOcrText(evidence.ocrText)
  }

  const trimmedName = name.trim()
  const dirty = trimmedName !== evidence.name || ocrText !== evidence.ocrText
  const nameInvalid = !trimmedName
  const savingNow = saving || Boolean(busy)

  async function save() {
    if (!dirty || nameInvalid || savingNow) return
    setSaving(true)
    setError('')
    try {
      const patch: { name?: string; ocrText?: string } = {}
      if (trimmedName !== evidence.name) patch.name = trimmedName
      if (ocrText !== evidence.ocrText) patch.ocrText = ocrText
      await onUpdate(patch)
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败，请重试。')
    } finally {
      setSaving(false)
    }
  }

  async function remove() {
    if (!confirmingDelete || savingNow) return
    setSaving(true)
    setError('')
    try {
      await onDelete()
    } catch (e) {
      setError(e instanceof Error ? e.message : '删除失败，请重试。')
      setSaving(false)
    }
  }

  return (
    <section className="evidence-manage" aria-label="材料信息">
      <div className="evidence-manage-head">
        <strong>材料信息</strong>
        <span>修正名称与抽取文本会直接影响 AI 匹配与证据联动结果</span>
      </div>

      <label className="field-block">
        材料名称
        <input
          value={name}
          onChange={event => setName(event.target.value)}
          placeholder="填写证据的规范名称"
          aria-invalid={nameInvalid}
        />
      </label>

      <label className="field-block">
        抽取文本
        <textarea
          value={ocrText}
          onChange={event => setOcrText(event.target.value)}
          placeholder="填写材料正文，AI 将据此做证据联动与逐句核验"
        />
      </label>

      <div className="evidence-manage-meta">
        <span>材料编号</span>
        <strong>{evidence.number}</strong>
        <span>原始文件</span>
        <strong title={evidence.fileName}>{evidence.fileName}</strong>
        <span>原始目录</span>
        <strong title={evidence.relativePath ?? evidence.fileName}>
          {evidence.relativePath ?? evidence.fileName}
        </strong>
      </div>

      {nameInvalid ? <p className="evidence-manage-error" role="alert">材料名称不能为空。</p> : null}
      {error ? <p className="evidence-manage-error" role="alert">{error}</p> : null}

      <div className="evidence-manage-actions">
        <button
          className="primary-button"
          type="button"
          onClick={() => void save()}
          disabled={!dirty || nameInvalid || savingNow}
        >
          {saving ? '保存中…' : '保存修改'}
        </button>
        <button
          className="ghost-button"
          type="button"
          onClick={() => {
            setName(evidence.name)
            setOcrText(evidence.ocrText)
            setError('')
          }}
          disabled={!dirty || savingNow}
        >
          放弃修改
        </button>
        {confirmingDelete ? (
          <>
            <button className="danger-button" type="button" onClick={() => void remove()} disabled={savingNow}>
              确认删除
            </button>
            <button className="ghost-button" type="button" onClick={() => setConfirmingDelete(false)} disabled={savingNow}>
              取消
            </button>
          </>
        ) : (
          <button className="ghost-button danger" type="button" onClick={() => setConfirmingDelete(true)} disabled={savingNow}>
            删除材料
          </button>
        )}
      </div>
    </section>
  )
}
