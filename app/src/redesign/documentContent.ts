import { richTextIndex } from './richTextIndex'
import type { CertificateParagraph } from '../types'
import type { SuperDoc } from 'superdoc'

export type DocumentBlock = Pick<CertificateParagraph, 'id' | 'text' | 'richText'>

export function contentSnapshot(paragraphs: DocumentBlock[]): DocumentBlock[] {
  return paragraphs.map(({ id, text, richText }) => ({ id, text, richText }))
}

export function documentHtml(paragraphs: DocumentBlock[]) {
  const container = document.createElement('div')
  for (const paragraph of paragraphs) {
    const section = document.createElement('div')
    if (paragraph.richText) section.innerHTML = paragraph.richText
    else {
      const block = document.createElement('p')
      paragraph.text.split('\n').forEach((line, index) => {
        if (index) block.append(document.createElement('br'))
        block.append(document.createTextNode(line))
      })
      section.append(block)
    }
    for (const child of Array.from(section.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE && !child.textContent?.trim()) continue
      const block = child instanceof HTMLElement ? child : document.createElement('p')
      if (child.nodeType === Node.TEXT_NODE) block.textContent = child.textContent
      container.append(block)
    }
  }
  if (!container.children.length) {
    const block = document.createElement('p')
    container.append(block)
  }
  return container.innerHTML
}

export type SuperDocTarget = { blockId: string; text: string; offset?: number; separator?: string }

type DocumentApi = NonNullable<NonNullable<SuperDoc['activeEditor']>['doc']>
type HtmlProjection = Awaited<ReturnType<DocumentApi['projectHtml']>>
type StructuredDocument = Awaited<ReturnType<DocumentApi['get']>>
type ProjectedUnit = { text: string; richText: string; pieces: Array<SuperDocTarget & { start: number }> }
type ProjectionBaseline = {
  originals: Map<string, { block: DocumentBlock; unit: ProjectedUnit; count: number }>
  empty: Set<string>
  paragraphGranular: boolean
}

const projectionBaselines = new WeakMap<Map<string, string>, ProjectionBaseline>()
const sourceAttribute = 'data-lawverify-source-index'
const sourceSelector = `[${sourceAttribute}]`
const bodyStory = { kind: 'story', storyType: 'body' } as const

function paragraphStyles(body: StructuredDocument['body']) {
  const styles = new Map<string, { alignment?: string; indent?: { left?: number; start?: number; right?: number; end?: number; firstLine?: number; hanging?: number } }>()
  const walk = (content: StructuredDocument['body']) => {
    for (const node of content) {
      if (node.kind === 'paragraph' || node.kind === 'heading') {
        const id = node.paragraphIds?.paraId
        const props = (node.kind === 'paragraph' ? node.paragraph : node.heading).props
        if (id && props) styles.set(id, props)
      } else if (node.kind === 'table') {
        for (const row of node.table.rows) for (const cell of row.cells) walk(cell.content)
      } else if (node.kind === 'list') {
        for (const item of node.list.items) walk(item.content)
      } else if (node.kind === 'sdt' && node.sdt.content) walk(node.sdt.content)
      else if (node.kind === 'customXml' && node.customXml.content) walk(node.customXml.content)
    }
  }
  walk(body)
  return styles
}

function projectUnits(projection: HtmlProjection, structured: StructuredDocument, native: boolean): ProjectedUnit[] {
  const sources = projection.blocks.filter(block => ['paragraph', 'heading', 'listItem'].includes(block.nodeType))
    .sort((left, right) => left.output.start - right.output.start)
  const html: string[] = []
  let cursor = 0
  sources.forEach(({ output }, index) => {
    const opening = /^<[a-z][\w-]*/i.exec(projection.content.slice(output.start, output.start + 24))?.[0]
    if (!opening || output.start < cursor) return
    const end = output.start + opening.length
    html.push(projection.content.slice(cursor, end), ` ${sourceAttribute}="${index}"`)
    cursor = end
  })
  html.push(projection.content.slice(cursor))
  const { body } = new DOMParser().parseFromString(html.join(''), 'text/html')

  // 编号来自 Word 列表定义，正文坐标不包含投影为 HTML 添加的可见编号。
  body.querySelectorAll('[data-superdoc-list-label]').forEach(label => {
    const item = label.parentElement
    item?.style.removeProperty('list-style-type')
    if (item?.getAttribute('style') === '') item.removeAttribute('style')
    label.remove()
  })
  body.querySelectorAll('[data-superdoc-list-labels]').forEach(list => list.removeAttribute('data-superdoc-list-labels'))
  body.querySelectorAll('[data-superdoc-placeholder]').forEach(placeholder => placeholder.remove())
  const styles = paragraphStyles(structured.body)
  const sourceNodes = Array.from(body.querySelectorAll<HTMLElement>(sourceSelector))
  for (const node of sourceNodes) {
    const source = sources[Number(node.getAttribute(sourceAttribute))]
    const style = source.identity === 'public' ? styles.get(source.blockId) : undefined
    if (style?.alignment) node.style.textAlign = style.alignment
    if (style?.indent) {
      const { left, start, right, end, firstLine, hanging } = style.indent
      if (left !== undefined || start !== undefined) node.style.marginLeft = `${left ?? start}pt`
      if (right !== undefined || end !== undefined) node.style.marginRight = `${right ?? end}pt`
      if (firstLine !== undefined || hanging !== undefined) node.style.textIndent = `${firstLine ?? -(hanging ?? 0)}pt`
    }
  }

  return (native ? sourceNodes : Array.from(body.children)).map(node => {
    const element = node.cloneNode(true) as HTMLElement
    if (native && element.tagName === 'LI') element.querySelectorAll('ul, ol').forEach(list => list.remove())
    const index = richTextIndex(element)
    const ranges = new Map<HTMLElement, { start: number; end: number }>()
    for (const segment of index.segments) {
      if (segment.from.node === segment.to.node && segment.from.offset === segment.to.offset) continue
      const { node } = segment.from
      const owner = (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>(sourceSelector)
      if (!owner) continue
      const range = ranges.get(owner)
      if (range) range.end = segment.end
      else ranges.set(owner, { start: segment.start, end: segment.end })
    }
    const pieces = []
    const marked = element.matches(sourceSelector) ? [element, ...element.querySelectorAll<HTMLElement>(sourceSelector)]
      : Array.from(element.querySelectorAll<HTMLElement>(sourceSelector))
    for (const item of marked) {
      const source = sources[Number(item.getAttribute(sourceAttribute))]
      const range = ranges.get(item)
      if (source.identity === 'public') pieces.push({ blockId: source.blockId,
        text: range ? index.text.slice(range.start, range.end) : '', start: range?.start ?? 0 })
      item.removeAttribute(sourceAttribute)
    }
    // 原生 Word 的列表项对应一个正文段落，编号与层级由 DOCX 保留。
    const richText = native && element.tagName === 'LI'
      ? element.outerHTML.replace(/^<li(?=[\s>])/i, '<p').replace(/<\/li>$/i, '</p>') : element.outerHTML
    return { text: index.text, richText, pieces }
  })
}

function joinUnits(units: ProjectedUnit[]): ProjectedUnit {
  if (units.length === 1) return units[0]
  let text = ''
  const pieces: ProjectedUnit['pieces'] = []
  units.forEach((unit, index) => {
    if (index) text += '\n'
    for (const piece of unit.pieces) pieces.push({ ...piece, start: text.length + piece.start })
    text += unit.text
  })
  return { text, pieces, richText: units.map(unit => unit.richText).join('') }
}

function textKey(text: string) {
  return text.replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ').trim()
}

function seedProjection(units: ProjectedUnit[], baseline: readonly DocumentBlock[], ids: Map<string, string>, native: boolean,
  paragraphGranular: boolean): ProjectionBaseline {
  const originals: ProjectionBaseline['originals'] = new Map()
  const empty = new Set<string>()
  const count = (texts: string[]) => {
    const counts = new Map<string, number>()
    for (const item of texts) counts.set(item, (counts.get(item) ?? 0) + 1)
    return counts
  }
  const input = baseline.map(block => textKey(block.text))
  const output = units.map(unit => textKey(unit.text))
  const inputCounts = count(input)
  const outputCounts = count(output)
  const firstLine = (text: string) => text.split('\n', 1)[0]
  const positions = new Map<string, number[]>()
  for (const [index, value] of output.entries()) {
    const key = firstLine(value)
    const list = positions.get(key)
    if (list) list.push(index)
    else positions.set(key, [index])
  }
  const cursors = new Map<string, number>()
  let from = 0
  for (let index = 0; index < baseline.length; index++) {
    const block = baseline[index]
    const expected = input[index]
    const key = firstLine(expected)
    const matches = positions.get(key) ?? []
    let cursor = cursors.get(key) ?? 0
    while (cursor < matches.length && matches[cursor] < from) cursor++
    cursors.set(key, cursor)
    for (; cursor < matches.length; cursor++) {
      const start = matches[cursor]
      if (!expected.startsWith(output[start])) continue
      let end = start + 1
      let candidate = output[start]
      while (candidate !== expected && expected.startsWith(`${candidate}\n`) && end < units.length) {
        candidate += `\n${output[end++]}`
      }
      if (candidate !== expected) continue
      // 重复正文只在数量一致时按原件顺序配对，避免把旧核验标到新增的同名段落。
      if (end === start + 1 && inputCounts.get(expected) !== outputCounts.get(expected) &&
        ((inputCounts.get(expected) ?? 0) > 1 || (outputCounts.get(expected) ?? 0) > 1)) continue
      const unit = joinUnits(units.slice(start, end))
      if (!unit.pieces.length) continue
      originals.set(block.id, { block, unit, count: end - start })
      for (const piece of unit.pieces) ids.set(piece.blockId, block.id)
      from = end
      break
    }
  }
  if (native) for (const unit of units) {
    if (!textKey(unit.text)) for (const piece of unit.pieces) if (!ids.has(piece.blockId)) empty.add(piece.blockId)
  }
  return { originals, empty, paragraphGranular }
}

function projectionTargets(unit: ProjectedUnit, text: string): SuperDocTarget[] {
  const from = unit.text.indexOf(text)
  if (from < 0) return []
  const to = from + text.length
  let previous = from
  return unit.pieces.flatMap(piece => {
    const start = Math.max(from, piece.start)
    const end = Math.min(to, piece.start + piece.text.length)
    if (start >= end) return []
    const target = { blockId: piece.blockId, text: unit.text.slice(start, end), offset: start - piece.start,
      separator: unit.text.slice(previous, start) }
    previous = end
    return [target]
  })
}

export async function readSuperDocBlocks(editor: SuperDoc, ids: Map<string, string>, baseline: readonly DocumentBlock[], native = false) {
  const doc = editor.activeEditor?.doc
  if (!doc) throw new Error('文书编辑器尚未准备好。')
  const [projection, structured] = await Promise.all([doc.projectHtml({ in: bodyStory, reviewMode: 'final' }), doc.get({ in: bodyStory })])
  if (projection.status === 'failed') throw new Error('无法读取当前文书正文。')
  const savedProjection = projectionBaselines.get(ids)
  // 旧文书转存为 DOCX 后仍沿用已有表格、列表段落的边界。
  const paragraphGranular = savedProjection?.paragraphGranular ?? (native && !baseline.some(block => /<(?:table|ol|ul)\b/i.test(block.richText ?? '')))
  const units = projectUnits(projection, structured, paragraphGranular)
  const initial = savedProjection ?? seedProjection(units, baseline, ids, native, paragraphGranular)
  projectionBaselines.set(ids, initial)

  const assigned = new Set<string>()
  const groups: Array<{ id: string; units: ProjectedUnit[] }> = []
  const visible = units.filter(unit => textKey(unit.text) || !unit.pieces.length || unit.pieces.some(piece => !initial.empty.has(piece.blockId)))
  for (const unit of visible.length ? visible : units.slice(0, 1)) {
    const candidates = unit.pieces.map(piece => ids.get(piece.blockId))
    const previous = groups.at(-1)
    if (previous && candidates.includes(previous.id) && (initial.originals.get(previous.id)?.count ?? 0) > 1) {
      previous.units.push(unit)
      continue
    }
    const id = candidates.find(candidate => candidate && !assigned.has(candidate)) ?? crypto.randomUUID()
    assigned.add(id)
    groups.push({ id, units: [unit] })
  }

  const targets = new Map<string, SuperDocTarget[]>()
  const blocks = groups.map(({ id, units }) => {
    const unit = joinUnits(units)
    for (const piece of unit.pieces) {
      ids.set(piece.blockId, id)
      initial.empty.delete(piece.blockId)
    }
    const original = initial.originals.get(id)
    const text = original?.unit.text === unit.text ? original.block.text : unit.text
    const richText = original?.unit.richText === unit.richText ? original.block.richText : unit.richText
    targets.set(id, projectionTargets(unit, text))
    return { id, text, richText }
  })
  return { blocks, targets }
}
