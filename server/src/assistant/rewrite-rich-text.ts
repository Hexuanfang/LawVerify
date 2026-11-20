import { parseFromString, type XmlNode } from 'mammoth/lib/xml/xmldom.js'
import { AppError } from '../core/app-error.js'

const block = /^(?:p|div|section|article|h[1-6]|li|[uo]l|blockquote|pre|table|thead|tbody|tfoot|tr)$/iu
const container = /^(?:content|div|section|article|[uo]l|table|thead|tbody|tfoot|tr)$/iu
const cell = /^(?:td|th)$/iu
const excluded = /^(?:script|style|iframe|object|embed)$/iu

function textIndex(root: XmlNode, separators: boolean) {
  let text = ''
  const spans: Array<{ node: XmlNode; start: number; end: number }> = []
  const visit = (node: XmlNode) => {
    if (node.nodeType === 3) {
      const start = text.length
      text += node.textContent
      spans.push({ node, start, end: text.length })
      return
    }
    let previous: XmlNode | undefined
    for (const child of Array.from(node.childNodes)) {
      const name = child.localName ?? ''
      if (excluded.test(name) || (separators && container.test(node.localName) && child.nodeType === 3 && !child.textContent.trim())) continue
      if (separators && previous) {
        const before = previous.localName ?? ''
        if (cell.test(before) && cell.test(name)) text += '\t'
        else if (block.test(before) || block.test(name)) text += '\n'
      }
      if (/^br$/iu.test(name)) {
        if (separators) text += '\n'
      } else visit(child)
      previous = child
    }
  }
  visit(root)
  return { text, spans }
}

export function rewriteRichText(html: string | undefined, original: string, next: string) {
  if (!html) return undefined
  const conflict = () => new AppError('正文与富文本无法对齐，请保存文书后重新选择改写范围。', 409, 'REWRITE_RICH_TEXT_CONFLICT')
  let root: XmlNode
  try {
    const xml = html.replace(/&nbsp;/giu, '&#160;').replace(/<(br|hr|img|input|wbr|col)\b([^<>]*?)(?<!\/)>/giu, '<$1$2/>')
    root = Array.from(parseFromString(`<content>${xml}</content>`).childNodes).find(item => item.localName === 'content')!
  } catch {
    throw conflict()
  }
  if (!root) throw conflict()
  const canonical = textIndex(root, true)
  const index = canonical.text.includes(original) ? canonical : textIndex(root, false)
  const base = index.text.indexOf(original)
  if (base < 0 || index.text.indexOf(original, base + 1) >= 0) throw conflict()
  let prefix = 0
  while (prefix < original.length && original[prefix] === next[prefix]) prefix++
  let suffix = 0
  while (suffix < Math.min(original.length, next.length) - prefix
    && original[original.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix++

  const start = base + prefix, end = base + original.length - suffix
  const replacement = next.slice(prefix, next.length - suffix)
  const affected = index.spans.filter(span => span.start < end && span.end > start)
  if (start === end && !affected.length) {
    const insertion = index.spans.find(span => span.start <= start && span.end >= start)
    if (insertion) affected.push(insertion)
  }
  if (!affected.length || affected[0].start > start || affected.at(-1)!.end < end) throw conflict()
  for (const [i, { node, start: left, end: right }] of affected.entries()) {
    node.textContent = node.textContent.slice(0, Math.max(0, start - left)) + (i ? '' : replacement)
      + node.textContent.slice(Math.min(right - left, end - left))
  }
  const checked = textIndex(root, index === canonical).text
  if (checked !== index.text.slice(0, base) + next + index.text.slice(base + original.length)) throw conflict()
  return Array.from(root.childNodes).map(item => item.toString()).join('')
}
