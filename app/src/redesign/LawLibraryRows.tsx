import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { KnowledgeStatuteDocument } from '../types'
import { Button } from './components/ui/button'
import { createLawCursor, readLawBatch, sameLawRows, type LawCursor, type LibraryRow } from './libraryRows'

type Page = { source: LawCursor; rows: LibraryRow[]; hasMore: boolean }

export function LawLibraryRows({ statutes, query, renderRow }: {
  statutes: KnowledgeStatuteDocument[]
  query: string
  renderRow: (row: LibraryRow) => ReactNode
}) {
  const [input, setInput] = useState(() => ({ statutes, query, source: createLawCursor(statutes, query) }))
  if (input.statutes !== statutes || input.query !== query) {
    const unchanged = input.query === query && sameLawRows(input.statutes, statutes)
    setInput({ statutes, query, source: unchanged ? input.source : createLawCursor(statutes, query) })
  }
  const source = input.source
  const [page, setPage] = useState<Page | null>(null)
  const scheduled = useRef<number | null>(null)
  const sentinel = useRef<HTMLDivElement>(null)
  const loadMore = useCallback(() => {
    if (scheduled.current !== null) return
    scheduled.current = requestAnimationFrame(() => {
      scheduled.current = null
      const batch = readLawBatch(source)
      setPage(current => current?.source === source
        ? { source, rows: [...current.rows, ...batch.rows], hasMore: batch.hasMore } : current)
    })
  }, [source])
  useEffect(() => {
    scheduled.current = requestAnimationFrame(() => {
      scheduled.current = null
      setPage({ source, ...readLawBatch(source) })
    })
    return () => {
      if (scheduled.current !== null) cancelAnimationFrame(scheduled.current)
      scheduled.current = null
    }
  }, [source])
  const current = page?.source === source ? page : null
  useEffect(() => {
    const target = sentinel.current
    if (!target || !current?.hasMore || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) loadMore()
    }, { root: target.closest('.lib'), rootMargin: '160px' })
    observer.observe(target)
    return () => observer.disconnect()
  }, [current?.hasMore, source, loadMore])
  if (!current) return <div className="lib-empty" role="status">正在加载法条…</div>
  if (!current.rows.length) return <div className="lib-empty">未找到，试试清空搜索或新增一条</div>
  return <>
    {current.rows.map(renderRow)}
    {current.hasMore && <div ref={sentinel} className="library-load-more">
      <span>已显示 {current.rows.length} 条</span>
      <Button variant="outline" onClick={loadMore}>加载更多法条</Button>
    </div>}
  </>
}
