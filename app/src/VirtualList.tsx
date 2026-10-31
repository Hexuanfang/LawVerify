import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'

function MeasuredRow({ id, onHeight, children }: { id: string; onHeight: (id: string, height: number) => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const observer = new ResizeObserver(() => onHeight(id, element.getBoundingClientRect().height))
    observer.observe(element)
    return () => observer.disconnect()
  }, [id, onHeight])
  return <div ref={ref}>{children}</div>
}

export function VirtualList<T>({ items, itemKey, renderItem, estimateHeight, focusKey }: {
  items: T[]
  itemKey: (item: T) => string
  renderItem: (item: T) => ReactNode
  estimateHeight: (item: T) => number
  focusKey?: string | null
}) {
  const host = useRef<HTMLDivElement>(null)
  const lastFocus = useRef<string | null | undefined>(undefined)
  const [heights, setHeights] = useState(new Map<string, number>())
  const [viewport, setViewport] = useState({ top: 0, height: 600 })
  const measure = useCallback((id: string, height: number) => {
    const rounded = Math.ceil(height)
    if (rounded <= 0) return
    setHeights(current => {
      if (current.get(id) === rounded) return current
      return new Map(current).set(id, rounded)
    })
  }, [])
  const offsets = useMemo(() => {
    const result = [0]
    for (const item of items) result.push(result[result.length - 1] + (heights.get(itemKey(item)) ?? estimateHeight(item)))
    return result
  }, [items, itemKey, estimateHeight, heights])
  useEffect(() => {
    const element = host.current
    if (!element) return
    let frame = 0
    const update = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => setViewport({ top: element.scrollTop, height: element.clientHeight }))
    }
    const observer = new ResizeObserver(update)
    observer.observe(element)
    element.addEventListener('scroll', update, { passive: true })
    update()
    return () => { cancelAnimationFrame(frame); observer.disconnect(); element.removeEventListener('scroll', update) }
  }, [])
  useEffect(() => {
    const valid = new Set(items.map(itemKey))
    setHeights(current => {
      if ([...current.keys()].every(key => valid.has(key))) return current
      return new Map([...current].filter(([key]) => valid.has(key)))
    })
  }, [items, itemKey])
  useEffect(() => {
    const element = host.current
    if (lastFocus.current === focusKey) return
    const index = items.findIndex(item => itemKey(item) === focusKey)
    if (!element || index < 0) return
    lastFocus.current = focusKey
    if (offsets[index] < element.scrollTop || offsets[index + 1] > element.scrollTop + element.clientHeight) {
      element.scrollTop = Math.max(0, offsets[index] - 40)
    }
  }, [focusKey, items, itemKey, offsets])
  let start = 0
  while (start < items.length && offsets[start + 1] < viewport.top - 300) start++
  let end = start
  while (end < items.length && offsets[end] < viewport.top + viewport.height + 300) end++
  return <div className="virtual-evidence-list" ref={host}>
    <div style={{ paddingTop: offsets[start], paddingBottom: offsets[items.length] - offsets[end] }}>
      {items.slice(start, end).map(item => <MeasuredRow key={itemKey(item)} id={itemKey(item)} onHeight={measure}>
        {renderItem(item)}
      </MeasuredRow>)}
    </div>
  </div>
}
