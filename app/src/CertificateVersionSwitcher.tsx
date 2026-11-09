import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Certificate } from './types'
import './certificate-version.css'

const MENU_WIDTH = 320

function formatVersionTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const pad = (input: number) => String(input).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function CertificateVersionSwitcher({ certificates, activeId, onSelect }: {
  certificates: Certificate[]
  activeId?: string
  onSelect: (certificateId: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)

  // 文书面板与标签行都是 overflow 裁剪容器，下拉必须挂到 body 上才能完整显示。
  const reposition = useCallback(() => {
    const rect = trigger.current?.getBoundingClientRect()
    if (!rect) return
    const left = Math.max(8, Math.min(rect.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8))
    setPosition({ top: rect.bottom + 6, left })
  }, [])

  useLayoutEffect(() => {
    if (!open) return
    reposition()
    const sync = () => reposition()
    window.addEventListener('scroll', sync, true)
    window.addEventListener('resize', sync)
    return () => {
      window.removeEventListener('scroll', sync, true)
      window.removeEventListener('resize', sync)
    }
  }, [open, reposition])

  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent) => {
      const target = event.target as Node
      if (trigger.current?.contains(target)) return
      if (menu.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [open])

  if (!certificates.length) return null

  const active = certificates.find(item => item.id === activeId) ?? certificates[0]
  const activeIndex = certificates.findIndex(item => item.id === active.id)

  return <div className="ide-version-switcher">
    <button
      ref={trigger}
      type="button"
      className="ide-version-trigger"
      aria-haspopup="listbox"
      aria-expanded={open}
      title={`共 ${certificates.length} 个文书版本，当前为第 ${activeIndex + 1} 个`}
      onClick={() => setOpen(current => !current)}
      onKeyDown={event => {
        if (event.key === 'ArrowDown' && !open) {
          event.preventDefault()
          setOpen(true)
        }
      }}
    >
      <span className="ide-version-label">版本</span>
      <strong>{activeIndex + 1}/{certificates.length}</strong>
      <span className="ide-version-title">{active.title}</span>
      <svg className="ide-version-chevron" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
    {open && position ? createPortal(
      <div
        ref={menu}
        className="ide-version-menu"
        style={{ top: position.top, left: position.left }}
        role="listbox"
        aria-label="文书版本"
        onKeyDown={event => {
          if (event.key === 'Escape') {
            setOpen(false)
            trigger.current?.focus()
            event.stopPropagation()
          }
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            const choices = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('.ide-version-item') ?? [])
            const index = choices.indexOf(document.activeElement as HTMLButtonElement)
            const next = event.key === 'ArrowDown'
              ? (index + 1) % choices.length
              : (index - 1 + choices.length) % choices.length
            choices[next]?.focus()
          }
        }}
      >
        {certificates.map((certificate, index) => <button
          key={certificate.id}
          type="button"
          role="option"
          aria-selected={certificate.id === active.id}
          className={`ide-version-item ${certificate.id === active.id ? 'active' : ''}`}
          onClick={() => {
            onSelect(certificate.id)
            setOpen(false)
            trigger.current?.focus()
          }}
        >
          <span className="ide-version-item-top">
            <strong>{index + 1}. {certificate.title}</strong>
            {certificate.id === active.id ? <b aria-hidden="true">当前</b> : null}
          </span>
          <span className="ide-version-item-meta">
            {certificate.role === 'plaintiff' ? '原告' : '被告'} · {certificate.paragraphs.length} 段 · {formatVersionTime(certificate.createdAt)}
          </span>
        </button>)}
      </div>,
      document.body,
    ) : null}
  </div>
}
