import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export function FolderLinkGuidePopup({ anchorRef, onLink, onDismiss, busy }: {
  anchorRef: React.RefObject<HTMLElement | null>
  onLink: () => void
  onDismiss: () => void
  busy?: boolean
}) {
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)
  const panel = useRef<HTMLDivElement>(null)

  // 侧栏是 overflow 裁剪容器，浮层必须挂到 body 上并按锚点定位，
  // 否则右侧会被文书区盖住或被侧栏裁掉。
  const reposition = useCallback(() => {
    const rect = anchorRef.current?.getBoundingClientRect()
    if (!rect) return
    const width = Math.min(320, Math.max(240, window.innerWidth - 32))
    const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))
    const top = Math.min(rect.bottom + 8, window.innerHeight - 200)
    setPosition({ top, left })
  }, [anchorRef])

  useLayoutEffect(() => {
    reposition()
    const sync = () => reposition()
    window.addEventListener('scroll', sync, true)
    window.addEventListener('resize', sync)
    return () => {
      window.removeEventListener('scroll', sync, true)
      window.removeEventListener('resize', sync)
    }
  }, [reposition])

  useEffect(() => {
    const close = (event: PointerEvent) => {
      const target = event.target as Node
      if (panel.current?.contains(target)) return
      if (anchorRef.current?.contains(target)) return
      onDismiss()
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [anchorRef, onDismiss])

  if (!position) return null

  return createPortal(
    <aside className="case-entry-guide-popup" role="status" aria-live="polite"
      ref={panel} style={{ top: position.top, left: position.left }}>
      <button
        aria-label="关闭提示"
        className="case-entry-guide-popup-close"
        type="button"
        onClick={onDismiss}
        disabled={busy}
      >
        ×
      </button>
      <div className="case-entry-guide-popup-body">
        <span className="eyebrow">下一步</span>
        <h2>请先链接本地文件夹</h2>
        <p>案件已经建立完成。把电脑里的案件材料目录接进来后，就可以继续整理证据和生成文书。</p>
      </div>
      <div className="case-entry-guide-actions case-entry-guide-popup-actions">
        <button className="primary-button" type="button" onClick={onLink} disabled={busy}>
          链接本地文件夹
        </button>
        <button className="ghost-button" type="button" onClick={onDismiss} disabled={busy}>
          稍后处理
        </button>
      </div>
    </aside>,
    document.body,
  )
}
