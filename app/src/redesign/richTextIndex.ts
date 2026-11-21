type DomPoint = { node: Node; offset: number }
type TextSegment = { text: string; start: number; end: number; from: DomPoint; to: DomPoint; node?: Node }

const blocks = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'UL', 'OL', 'BLOCKQUOTE', 'PRE', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR'])
const containers = new Set(['BODY', 'DIV', 'SECTION', 'ARTICLE', 'UL', 'OL', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR'])
const excluded = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED'])

// 正文、高亮和局部修改共用同一份 DOM 文本坐标，保留软换行、列表及表格边界。
export function richTextIndex(root: Node, separators = true) {
  const segments: TextSegment[] = []
  let text = ''
  const push = (value: string, from: DomPoint, to: DomPoint, node?: Node) => {
    if (!value) return
    const start = text.length
    text += value
    segments.push({ text: value, start, end: text.length, from, to, node })
  }
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      push(node.textContent || '', { node, offset: 0 }, { node, offset: node.textContent?.length || 0 }, node)
      return
    }
    if (node instanceof HTMLElement && excluded.has(node.tagName)) return
    let previous: Node | null = null
    Array.from(node.childNodes).forEach((child, index) => {
      if (separators && node instanceof HTMLElement && containers.has(node.tagName)
        && child.nodeType === Node.TEXT_NODE && !child.textContent?.trim()) return
      if (child instanceof HTMLElement && excluded.has(child.tagName)) return
      if (child instanceof HTMLElement && child.classList.contains('ProseMirror-trailingBreak')) return
      if (separators && previous) {
        const currentTag = child instanceof HTMLElement ? child.tagName : ''
        const previousTag = previous instanceof HTMLElement ? previous.tagName : ''
        const point = { node, offset: index }
        if (['TD', 'TH'].includes(currentTag) && ['TD', 'TH'].includes(previousTag)) push('\t', point, point)
        else if (blocks.has(currentTag) || blocks.has(previousTag)) push('\n', point, point)
      }
      if (child instanceof HTMLElement && child.tagName === 'BR') {
        if (separators) push('\n', { node, offset: index }, { node, offset: index + 1 })
      } else walk(child)
      previous = child
    })
  }
  walk(root)
  const pointAt = (offset: number): DomPoint => {
    const segment = segments.find(item => item.end >= offset)
    if (!segment) return { node: root, offset: root.childNodes.length }
    if (segment.node) return { node: segment.node, offset: Math.max(0, offset - segment.start) }
    return offset <= segment.start ? segment.from : segment.to
  }
  return { text, segments, pointAt }
}
