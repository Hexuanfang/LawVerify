import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api'
import type { SearchResult, SearchScope } from './types'
import './command-palette.css'

const SCOPE_ORDER: SearchScope[] = ['evidence', 'paragraph', 'statute', 'case']

const SCOPE_LABELS: Record<SearchScope, string> = {
  evidence: '材料',
  paragraph: '文书段落',
  statute: '法条',
  case: '案例',
}

// 输入防抖：每敲一个字就发一次请求会把本地服务打满。
const SEARCH_DEBOUNCE_MS = 200
const CLIENT_LIMIT = 50

export function CommandPalette({
  open,
  caseId,
  onOpen,
  onClose,
  onSelect,
  onExternalCaseSearch,
}: {
  open: boolean
  caseId: string | null
  onOpen: () => void
  onClose: () => void
  onSelect: (result: SearchResult) => void
  onExternalCaseSearch: (query: string) => void
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [truncated, setTruncated] = useState(false)
  const [externalAvailable, setExternalAvailable] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const requestIdRef = useRef(0)

  // ⌘K / Ctrl+K 全局唤起：注册放在组件内，App 只负责开关状态。
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        if (open) {
          onClose()
        } else {
          onOpen()
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, onOpen, onClose])

  useEffect(() => {
    if (!open) {
      return
    }
    setQuery('')
    setResults([])
    setTruncated(false)
    setError('')
    setActiveIndex(0)
    // 等弹窗渲染出来再聚焦，否则输入框拿不到焦点。
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => window.clearTimeout(timer)
  }, [open])

  useEffect(() => {
    const keyword = query.trim()
    if (!keyword) {
      return
    }

    const requestId = requestIdRef.current + 1
    requestIdRef.current = requestId
    setLoading(true)
    const timer = window.setTimeout(() => {
      api.searchWorkspace(keyword, { caseId: caseId ?? undefined, limit: CLIENT_LIMIT })
        .then((response) => {
          if (requestIdRef.current !== requestId) return
          setResults(response.results.slice(0, CLIENT_LIMIT))
          setTruncated(response.truncated)
          setExternalAvailable(response.externalCaseSearch.available)
          setError('')
          setActiveIndex(0)
        })
        .catch((reason: unknown) => {
          if (requestIdRef.current !== requestId) return
          setResults([])
          setError(reason instanceof Error ? reason.message : '搜索失败，请稍后重试。')
        })
        .finally(() => {
          if (requestIdRef.current === requestId) setLoading(false)
        })
    }, SEARCH_DEBOUNCE_MS)

    return () => window.clearTimeout(timer)
  }, [query, caseId])

  const grouped = useMemo(() => {
    return SCOPE_ORDER
      .map(scope => ({
        scope,
        label: SCOPE_LABELS[scope],
        items: results.filter(result => result.scope === scope),
      }))
      .filter(group => group.items.length > 0)
  }, [results])

  // 扁平顺序与分组渲染顺序一致，键盘上下键才和看到的顺序对得上。
  const flatResults = useMemo(() => grouped.flatMap(group => group.items), [grouped])
  const flatIndexById = useMemo(() => {
    const map = new Map<string, number>()
    flatResults.forEach((item, index) => map.set(item.id, index))
    return map
  }, [flatResults])

  useEffect(() => {
    if (!open) return
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setActiveIndex(index => (flatResults.length ? (index + 1) % flatResults.length : 0))
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setActiveIndex(index => (flatResults.length ? (index - 1 + flatResults.length) % flatResults.length : 0))
        return
      }
      if (event.key === 'Enter') {
        event.preventDefault()
        const target = flatResults[activeIndex]
        if (target) {
          onSelect(target)
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, flatResults, activeIndex, onClose, onSelect])

  useEffect(() => {
    const node = listRef.current?.querySelector('.command-palette-item.is-active')
    node?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, grouped])

  if (!open) {
    return null
  }

  return (
    <div className="command-palette-backdrop" onClick={onClose}>
      <div
        className="command-palette"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="全局搜索"
      >
        <div className="command-palette-input">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
            <circle cx="7" cy="7" r="4.25" />
            <path d="m10.25 10.25 3 3" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              const value = event.target.value
              setQuery(value)
              // 清空输入时直接清掉旧结果，避免再发一次空查询。
              if (!value.trim()) {
                setResults([])
                setTruncated(false)
                setError('')
                setActiveIndex(0)
              }
            }}
            placeholder="搜索材料、文书段落、法条或本地案例"
            aria-label="搜索关键词"
          />
          {loading ? <span className="command-palette-status">检索中…</span> : null}
        </div>

        <div className="command-palette-results" ref={listRef}>
          {error ? <p className="command-palette-empty">{error}</p> : null}
          {!error && !query.trim() ? (
            <p className="command-palette-empty">输入关键词开始检索，当前范围为本案材料与文书、全部法条与本地案例。</p>
          ) : null}
          {!error && query.trim() && !loading && !flatResults.length ? (
            <p className="command-palette-empty">未在当前案件与知识库中找到。</p>
          ) : null}

          {grouped.map(group => (
            <section className="command-palette-group" key={group.scope}>
              <h4>{group.label}</h4>
              {group.items.map(item => {
                const index = flatIndexById.get(item.id) ?? 0
                return (
                  <button
                    type="button"
                    key={item.id}
                    className={`command-palette-item${index === activeIndex ? ' is-active' : ''}`}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => onSelect(item)}
                  >
                    <strong>{item.title}</strong>
                    <span>{item.snippet}</span>
                  </button>
                )
              })}
            </section>
          ))}

          {query.trim() && !flatResults.length && externalAvailable ? (
            <div className="command-palette-external">
              <button type="button" className="text-link" onClick={() => onExternalCaseSearch(query.trim())}>
                到外部案例库检索该关键词
              </button>
            </div>
          ) : null}

          {truncated ? (
            <p className="command-palette-note">部分材料正文超过 2 万字，仅检索前 2 万字。</p>
          ) : null}
        </div>

        <div className="command-palette-footer">
          <span>↑↓ 选择</span>
          <span>Enter 打开</span>
          <span>Esc 关闭</span>
          <span>⌘K 唤起</span>
        </div>
      </div>
    </div>
  )
}
