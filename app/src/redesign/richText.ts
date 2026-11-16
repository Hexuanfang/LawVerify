import { richTextIndex } from './richTextIndex'
export function replaceRichText(
  html: string | undefined,
  original: string,
  replacement: string,
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
  // 只改动共同前后缀之间的文字，保留未编辑部分的加粗、下划线和段落格式。
  let prefix = 0
  while (
    prefix < original.length &&
    prefix < replacement.length &&
    original[prefix] === replacement[prefix]
  )
    prefix++
  let suffix = 0
  while (
    suffix < original.length - prefix &&
    suffix < replacement.length - prefix &&
    original[original.length - 1 - suffix] ===
      replacement[replacement.length - 1 - suffix]
  )
    suffix++
  const base = content.indexOf(original)
  if (base < 0)
    throw new Error('文书正文与富文本内容不一致，请刷新后核对再修改。')
  const start = base + prefix,
    end = base + original.length - suffix
  const from = index.pointAt(start)
  const to = index.pointAt(end)
  const range = dom.createRange()
  range.setStart(from.node, from.offset)
  range.setEnd(to.node, to.offset)
  range.deleteContents()
  range.insertNode(
    dom.createTextNode(replacement.slice(prefix, replacement.length - suffix)),
  )
  return dom.body.innerHTML
}
