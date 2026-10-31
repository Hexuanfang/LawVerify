import { useState, useTransition, type ReactNode } from 'react'

export type IdeNavigationTarget = 'files' | 'document' | 'assistant' | 'knowledge'

const navigationItems = [
  ['files', '资源管理器', 'M3 5h6l2 2h10v13H3z M3 10h18'],
  ['document', '文书工作区', 'M6 3h8l4 4v14H6z M14 3v5h4 M9 12h6 M9 16h6'],
  ['assistant', '案件助手', 'M12 3l3 6 6 3-6 3-3 6-3-6-6-3 6-3z'],
  ['knowledge', '知识库', 'M3 4h7l2 2 2-2h7v16h-7l-2 2-2-2H3z M12 6v16'],
] as const

export function IdeActivityBar({ active, identity, accountOpen, onNavigate, onFeedback, onAccount, children }: {
  active: Record<IdeNavigationTarget, boolean>
  identity: string
  accountOpen: boolean
  onNavigate: (target: IdeNavigationTarget) => void
  onFeedback: () => void
  onAccount: () => void
  children?: ReactNode
}) {
  const [pendingTarget, setPendingTarget] = useState<IdeNavigationTarget | null>(null)
  const [isPending, startTransition] = useTransition()

  return <nav className="ide-activity-bar" aria-label="功能导航">
    <div className="ide-brand-mark" title="LawVerify">L</div>
    {navigationItems.map(([key, label, path]) => (
      <button key={key} type="button" aria-label={label} title={label}
        aria-pressed={active[key]} aria-busy={isPending && pendingTarget === key}
        onClick={() => {
          // Paint the click feedback before rendering the document or knowledge panel.
          setPendingTarget(key)
          startTransition(() => onNavigate(key))
        }}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"
          strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={path} /></svg>
      </button>
    ))}
    <div className="ide-activity-spacer" />
    <button type="button" title="产品反馈" aria-label="产品反馈" onClick={onFeedback}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"
        strokeLinejoin="round" aria-hidden="true"><path d="M4 4h16v12H9l-5 4z M8 8h8 M8 12h5" /></svg>
    </button>
    <button type="button" title={identity} aria-label={`账户：${identity}`}
      aria-expanded={accountOpen} onClick={onAccount}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"
        aria-hidden="true"><circle cx="12" cy="8" r="4" /><path d="M4 21v-2a8 8 0 0 1 16 0v2" /></svg>
    </button>
    {children}
  </nav>
}
