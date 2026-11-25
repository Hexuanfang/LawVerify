import type { TextTarget } from 'superdoc'
import type { ViewportRect } from 'superdoc/ui'
import type { RewriteSelection } from '../../../server/src/intelligence/verification/rewrite-selection'
import type { DocumentBlock } from './documentContent'
import type { ReviewElement } from './model'
import type { ReviewTargetBlock } from './reviewHighlights'

export type DocumentSelection = { text: string; declarationIds: string[]; anchor?: RewriteSelection; rect?: ViewportRect }

export function reviewSelection(target: TextTarget, targets: ReadonlyMap<string, readonly ReviewTargetBlock[]>,
  paragraphs: readonly DocumentBlock[], elements: readonly ReviewElement[]) {
  const byId = new Map(paragraphs.map(paragraph => [paragraph.id, paragraph.text]))
  const selectedBlocks = new Map(target.segments.map(segment => [segment.blockId, segment.range]))
  const selections: Array<{ id: string; text: string; start: number; end: number }> = []
  for (const [id, pieces] of targets) {
    if (!pieces.some(piece => selectedBlocks.has(piece.blockId))) continue
    const combined = pieces.map(piece => (piece.separator ?? '') + piece.text).join('')
    const text = byId.get(id)
    if (text === undefined || (text !== combined && text !== combined.trim())) continue
    let position = text === combined ? 0 : combined.trimStart().length - combined.length
    for (const piece of pieces) {
      position += piece.separator?.length ?? 0
      const range = selectedBlocks.get(piece.blockId)
      const offset = piece.offset ?? 0
      if (range) {
        const start = Math.max(0, position + Math.max(0, range.start - offset))
        const end = Math.min(text.length, position + Math.min(piece.text.length, range.end - offset))
        if (end > start) selections.push({ id, text, start, end })
      }
      position += piece.text.length
    }
  }
  const declarationIds = elements.filter(element => selections.some(range => range.id === element.paragraphId
    && element.start < range.end && element.end > range.start)).slice(0, 12).map(element => element.id)
  const last = selections.at(-1)
  if (!last) return { declarationIds }
  const from = Math.max(last.end - 1000, selections.find(range => range.id === last.id)!.start)
  const raw = last.text.slice(from, last.end)
  const quote = raw.trim()
  const anchor = quote ? { paragraphId: last.id, start: from + raw.indexOf(quote), quote } : undefined
  return { declarationIds, anchor }
}
