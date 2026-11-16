import { richTextIndex } from './richTextIndex'
import type { CertificateParagraph } from '../types'

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
    // 旧文书单个存储段落可能包含多个 HTML 块，展开为连续编辑的顶层块。
    let first = true
    for (const child of Array.from(section.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE && !child.textContent?.trim()) continue
      const block = child instanceof HTMLElement ? child : document.createElement('p')
      if (child.nodeType === Node.TEXT_NODE) block.textContent = child.textContent
      block.setAttribute('data-lawverify-id', first ? paragraph.id : crypto.randomUUID())
      container.append(block)
      first = false
    }
  }
  if (!container.children.length) {
    const block = document.createElement('p')
    block.setAttribute('data-lawverify-id', crypto.randomUUID())
    container.append(block)
  }
  return container.innerHTML
}

export function documentBlocks(html: string): DocumentBlock[] {
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  const seen = new Set<string>()
  return Array.from(parsed.body.children).map(element => {
    let id = element.getAttribute('data-lawverify-id')
    if (!id || seen.has(id)) id = crypto.randomUUID()
    seen.add(id)
    const text = richTextIndex(element).text
    element.removeAttribute('data-lawverify-id')
    element.querySelectorAll('[data-lawverify-id]').forEach(child => child.removeAttribute('data-lawverify-id'))
    return { id, text, richText: element.outerHTML }
  })
}
