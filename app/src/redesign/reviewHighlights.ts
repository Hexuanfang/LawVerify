import { Extension, type Editor } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { matchesFilter, STATUS_NAMES, type ReviewElement } from './model'

type ReviewState = { elements: ReviewElement[]; selected: string; filter: string }
const reviewKey = new PluginKey<{ review: ReviewState; decorations: DecorationSet }>('lawverifyInlineReview')
const blocks = new Set(['paragraph', 'heading', 'blockquote', 'bulletList', 'orderedList', 'listItem', 'codeBlock', 'table', 'tableRow'])
const cells = new Set(['tableCell', 'tableHeader'])

function textPositions(node: ProseMirrorNode, position: number, separators = true) {
  let text = ''
  const pieces: { start: number; end: number; position: number }[] = []
  const walk = (current: ProseMirrorNode, start: number) => {
    if (current.isText) {
      pieces.push({ start: text.length, end: text.length + current.text!.length, position: start })
      text += current.text
      return
    }
    if (current.type.name === 'hardBreak') {
      if (separators) text += '\n'
      return
    }
    let previous: ProseMirrorNode | null = null
    current.forEach((child, offset) => {
      if (separators && previous) {
        if (cells.has(previous.type.name) && cells.has(child.type.name)) text += '\t'
        else if (blocks.has(previous.type.name) || blocks.has(child.type.name)) text += '\n'
      }
      walk(child, start + 1 + offset)
      previous = child
    })
  }
  walk(node, position)
  return { text, pieces }
}

function buildDecorations(doc: ProseMirrorNode, review: ReviewState) {
  const byParagraph = new Map<string, ReviewElement[]>()
  for (const element of review.elements) {
    const entries = byParagraph.get(element.paragraphId) ?? []
    entries.push(element)
    byParagraph.set(element.paragraphId, entries)
  }
  const decorations: Decoration[] = []
  doc.forEach((node, position) => {
    const elements = byParagraph.get(node.attrs.documentId)
    if (!elements?.length) return
    let index = textPositions(node, position)
    const original = elements[0].original.text
    if (index.text !== original) index = textPositions(node, position, false)
    // 修改后的正文不再展示旧核验结果，保存并重核后由最新数据重新装饰。
    if (index.text !== original) return
    for (const element of elements) {
      if (index.text.slice(element.start, element.end) !== element.quote) continue
      const classes = `mk mk-${element.src} st-${element.verdict} ${matchesFilter(element.verdict, review.filter) ? 'hit' : ''} ${review.selected === element.id ? 'sel' : ''}`
      const title = `${element.type} · ${STATUS_NAMES[element.verdict]}\n${element.sources.map(source => `${source.name} ${source.loc}`).join('\n') || '未找到出处'}`
      for (const piece of index.pieces) {
        const start = Math.max(element.start, piece.start)
        const end = Math.min(element.end, piece.end)
        if (start < end) decorations.push(Decoration.inline(piece.position + start - piece.start, piece.position + end - piece.start,
          { class: classes, 'data-el': element.id, title }))
      }
    }
  })
  return DecorationSet.create(doc, decorations)
}

export const reviewHighlights = Extension.create({
  name: 'lawverifyInlineReview',
  addProseMirrorPlugins() {
    return [new Plugin<{ review: ReviewState; decorations: DecorationSet }>({
      key: reviewKey,
      state: {
        init: () => ({ review: { elements: [], selected: '', filter: 'all' }, decorations: DecorationSet.empty }),
        apply(transaction, previous, _old, state) {
          const review = transaction.getMeta(reviewKey) as ReviewState | undefined
          if (!transaction.docChanged && !review) return previous
          const current = review ?? previous.review
          return { review: current, decorations: buildDecorations(state.doc, current) }
        },
      },
      props: { decorations: state => reviewKey.getState(state)?.decorations },
    })]
  },
})

export function refreshReviewHighlights(editor: Editor, review: ReviewState) {
  editor.view.dispatch(editor.state.tr.setMeta(reviewKey, review).setMeta('addToHistory', false))
}
