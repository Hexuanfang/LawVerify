import { useEffect } from 'react'
import type { CertificateExportOptions } from './export-context'
import './export-options.css'

const OPTIONS: Array<{ key: keyof CertificateExportOptions; label: string; hint: string }> = [
  { key: 'evidenceCatalog', label: '包含《证据编号对照表》', hint: '把目录编号（E0x）与文书引用编号（证据N）并列，便于核对引用是否对得上。' },
  { key: 'verificationRecord', label: '包含《段落核验记录》', hint: '逐段列出核验状态、已挂证据数、法条与案例引用数。' },
  { key: 'declaration', label: '包含《AI 辅助与人工核验声明》', hint: '说明机器辅助范围与人工核验责任，并附核验统计。' },
  { key: 'useWordComments', label: '使用 Word 批注', hint: '关闭后批注以灰色小字附在段落之后。' },
]

export function ExportOptionsDialog({
  open,
  options,
  onChange,
  onConfirm,
  onCancel,
}: {
  open: boolean
  options: CertificateExportOptions
  onChange: (options: CertificateExportOptions) => void
  onConfirm: () => void
  onCancel: () => void
}) {
  useEffect(() => {
    if (!open) return
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCancel()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, onCancel])

  if (!open) {
    return null
  }

  const appendixSelected = options.evidenceCatalog || options.verificationRecord || options.declaration

  function toggle(key: keyof CertificateExportOptions) {
    onChange({ ...options, [key]: !options[key] })
  }

  return (
    <div className="export-options-backdrop" onClick={onCancel}>
      <div
        className="export-options-dialog"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="导出选项"
      >
        <div className="export-options-head">
          <div>
            <span className="eyebrow">导出</span>
            <h2>导出为 Word 文档</h2>
            <p>正文始终导出，以下选项决定是否附带附录与核验痕迹。</p>
          </div>
          <button className="ghost-button" type="button" onClick={onCancel}>
            关闭
          </button>
        </div>

        <div className="export-options-list">
          {OPTIONS.map((option) => (
            <label className="export-option-item" key={option.key}>
              <input
                type="checkbox"
                checked={options[option.key]}
                onChange={() => toggle(option.key)}
              />
              <span>
                <strong>{option.label}</strong>
                <em>{option.hint}</em>
              </span>
            </label>
          ))}
        </div>

        <div className="export-options-actions">
          <button
            className="ghost-button"
            type="button"
            onClick={() => onChange({
              evidenceCatalog: false,
              verificationRecord: false,
              declaration: false,
              useWordComments: options.useWordComments,
            })}
            disabled={!appendixSelected}
          >
            仅导出正文
          </button>
          <button className="ghost-button" type="button" onClick={onCancel}>
            取消
          </button>
          <button className="primary-button" type="button" onClick={onConfirm}>
            导出
          </button>
        </div>
      </div>
    </div>
  )
}
