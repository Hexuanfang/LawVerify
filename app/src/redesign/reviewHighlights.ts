import type { SuperDoc, SuperDocVisualHandle, TextAddress } from 'superdoc'
import { matchesFilter, STATUS_NAMES, type ReviewElement } from './model.ts'

type ReviewState = { elements: ReviewElement[]; selected: string; filter: string }
export type ReviewTargetBlock = { blockId: string; text: string; offset?: number; separator?: string }
type Highlight = {
  layer: SuperDocVisualHandle
  targets: TextAddress[]
  title: string
  className: string
  hit: boolean
}

export function reviewTextTargets(original: string, quote: string, start: number, end: number,
  blocks: readonly ReviewTargetBlock[]): TextAddress[] {
  if (!quote || start < 0 || end > original.length || original.slice(start, end) !== quote) return []
  for (const separator of ['\n', '']) {
    let text = ''
    const pieces = blocks.map((block, index) => {
      if (index) text += block.separator ?? separator
      const position = text.length
      text += block.text
      return { block, position }
    })
    // 修改后的正文不再展示旧核验结果，保存并重核后由最新数据重新装饰。
    if (text !== original && text.trim() !== original) continue
    const trimmed = text === original ? 0 : text.length - text.trimStart().length
    return pieces.flatMap(({ block, position }) => {
      const from = Math.max(0, trimmed + start - position)
      const to = Math.min(block.text.length, trimmed + end - position)
      const offset = block.offset ?? 0
      return from < to ? [{ kind: 'text', blockId: block.blockId, range: { start: offset + from, end: offset + to } }] : []
    })
  }
  return []
}

export function createReviewHighlights(editor: SuperDoc, onClick: (id: string) => void) {
  const { decorations, viewport } = editor.ui
  const highlights = new Map<string, Highlight>()
  let sequence = 0
  let disposed = false

  const unsubscribe = decorations.subscribe(event => {
    const id = event.data?.el
    if (typeof id !== 'string') return
    const highlight = highlights.get(id)
    if (!highlight?.hit || highlight.layer.id !== event.id) return
    if (event.type === 'click') onClick(id)
    if (event.type === 'hover-enter') {
      const mark = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>(`.${event.id}`)
      if (mark) mark.title = highlight.title
    }
  })

  return {
    refresh(review: ReviewState, paragraphs: ReadonlyMap<string, readonly ReviewTargetBlock[]>) {
      if (disposed) return
      const visible = new Set<string>()
      for (const element of review.elements) {
        const blocks = paragraphs.get(element.paragraphId)
        if (!blocks) continue
        const targets = reviewTextTargets(element.original.text, element.quote, element.start, element.end, blocks)
        if (!targets.length) continue
        visible.add(element.id)
        const hit = matchesFilter(element.verdict, review.filter)
        const selected = review.selected === element.id
        const className = `lawverify-review mk mk-${element.src} st-${element.verdict}${hit ? ' hit' : ''}${selected ? ' sel' : ''}`
        const status = STATUS_NAMES[element.verdict].replace(/^[绿黄红]·/, '')
        const title = `${element.type} · ${status}\n${element.sources.map(source => `${source.name} ${source.loc}`).join('\n') || '未找到出处'}`
        const previous = highlights.get(element.id)
        const layer = previous?.layer ?? decorations.highlight(`lawverify-review-${++sequence}`, { data: { el: element.id } })
        const unchanged = previous?.className === className && previous.targets.length === targets.length &&
          targets.every((target, index) => {
            const old = previous.targets[index]
            return old.blockId === target.blockId && old.range.start === target.range.start && old.range.end === target.range.end
          })
        highlights.set(element.id, { layer, targets, title, className, hit })
        if (!unchanged) layer.replace(targets.map(target => ({ target, className: `${className} ${layer.id}` })))
      }
      for (const [id, highlight] of highlights) {
        if (visible.has(id)) continue
        // 先清空图层，通知 SuperDoc 重绘当前页，随后释放图层。
        highlight.layer.clear()
        highlight.layer.dispose()
        highlights.delete(id)
      }
    },
    async locate(id: string) {
      const target = highlights.get(id)?.targets[0]
      if (target) await viewport.scrollIntoView({ target, block: 'center', behavior: 'instant' })
    },
    dispose() {
      if (disposed) return
      disposed = true
      unsubscribe()
      for (const highlight of highlights.values()) {
        highlight.layer.clear()
        highlight.layer.dispose()
      }
      highlights.clear()
    },
  }
}
