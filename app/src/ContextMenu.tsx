import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import './context-menu.css'

export type ContextMenuItem = {
  id: string
  label: string
  onSelect: () => void
  danger?: boolean
  disabled?: boolean
  dividerBefore?: boolean
}

export function ContextMenu({ items, x, y, onClose }: {
  items: ContextMenuItem[]
  x: number
  y: number
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ top: y, left: x })

  // 挂到 body 上，避免被文书区、侧栏等 overflow 容器裁剪。
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const rect = element.getBoundingClientRect()
    setPosition({
      top: y + rect.height > window.innerHeight - 8
        ? Math.max(8, y - rect.height)
        : y,
      left: x + rect.width > window.innerWidth - 8
        ? Math.max(8, window.innerWidth - rect.width - 8)
        : x,
    })
  }, [x, y, items.length])

  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    const dismiss = () => onClose()
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', dismiss, true)
    window.addEventListener('resize', dismiss)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('resize', dismiss)
    }
  }, [onClose])

  return createPortal(
    <div ref={ref} className="context-menu" role="menu" style={{ top: position.top, left: position.left }}>
      {items.map(item => <button
        key={item.id}
        type="button"
        role="menuitem"
        disabled={item.disabled}
        className={`context-menu-item ${item.danger ? 'danger' : ''} ${item.dividerBefore ? 'has-divider' : ''}`}
        onClick={() => {
          if (item.disabled) return
          onClose()
          item.onSelect()
        }}
      >
        {item.label}
      </button>)}
    </div>,
    document.body,
  )
}
