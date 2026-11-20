import { richTextIndex } from './richTextIndex'
export function replaceRichText(
  html: string | undefined,
  original: string,
  replacement: string,
  edit?: { start: number; end: number; replacement: string },
) {
  if (!html) {
    const node = document.createElement('p')
    node.textContent = replacement
    return node.outerHTML
  }
  const dom = new DOMParser().parseFromString(html, 'text/html')
  const canonical = richTextIndex(dom.body)
  const index = canonical.text.includes(original) ? canonical : richTextIndex(dom.body, false)
  const content = index.text
  const base = content.indexOf(original)
  if (base < 0 || (edit && content.indexOf(original, base + 1) >= 0))
    throw new Error('无法在富文本中唯一定位文书正文，请刷新后核对再修改。')

  // 声明编辑已有精确范围。重复文字的共同前后缀可能对应另一次出现。
  const change = edit ?? changedTextRange(original, replacement)
  const from = index.pointAt(base + change.start)
  const to = index.pointAt(base + change.end)
  const range = dom.createRange()
  range.setStart(from.node, from.offset)
  range.setEnd(to.node, to.offset)
  range.deleteContents()
  if (change.replacement) range.insertNode(dom.createTextNode(change.replacement))
  return dom.body.innerHTML
}

function changedTextRange(original: string, replacement: string) {
  let start = 0
  while (start < original.length && start < replacement.length && original[start] === replacement[start]) start++
  let end = original.length
  let replacementEnd = replacement.length
  while (end > start && replacementEnd > start && original[end - 1] === replacement[replacementEnd - 1]) {
    end--
    replacementEnd--
  }
  return { start, end, replacement: replacement.slice(start, replacementEnd) }
}
