import { openArrayBuffer } from 'mammoth/lib/zipfile.js'
import { parseFromString, type XmlNode } from 'mammoth/lib/xml/xmldom.js'
import type { CertificateParagraph } from '../domain.js'
import { AppError } from '../core/app-error.js'
import type { EvidenceCell } from '../intelligence/verification/protocol.js'

type Block = Pick<CertificateParagraph, 'id' | 'text' | 'richText'>
type OfficeParagraph = { paragraph: XmlNode; text: string; index: number }
type ParagraphSpan = OfficeParagraph & { start: number }
const wordNamespace = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'

function fail(): never {
  throw new AppError('外部改写与 Word 原件结构不一致，已保留原文件。请在编辑器中核对修改后保存。', 409, 'OFFICE_PATCH_CONFLICT')
}

function textNodes(node: XmlNode): XmlNode[] {
  const result: XmlNode[] = []
  const visit = (current: XmlNode) => {
    if (current !== node && current.namespaceURI === wordNamespace && current.localName === 'p') return
    if (current.namespaceURI === wordNamespace && current.localName === 'br'
      && current.getAttribute('w:type') && current.getAttribute('w:type') !== 'textWrapping') return
    if (current.namespaceURI === wordNamespace && ['t', 'tab', 'br'].includes(current.localName)) result.push(current)
    else for (const child of Array.from(current.childNodes)) visit(child)
  }
  visit(node)
  return result
}

function nodeText(node: XmlNode) {
  if (node.localName === 'tab') return '\t'
  if (node.localName === 'br') return '\n'
  return node.textContent
}

function normalizedParagraphText(text: string) {
  return text.replace(/\r\n/g, '\n').trim()
}

function paragraphText(node: XmlNode) {
  return normalizedParagraphText(textNodes(node).map(nodeText).join(''))
}

export async function readOfficeDocxBlocks(bytes: Buffer, preserveTableCells = false) {
  const zip = await openArrayBuffer(bytes)
  const xml = await zip.read('word/document.xml', 'utf8')
  if (xml.length > 32 * 1024 * 1024) throw new AppError('Word 正文展开后过大。', 413, 'OFFICE_XML_TOO_LARGE')
  const document = parseFromString(xml)
  const body = Array.from(document.getElementsByTagNameNS(wordNamespace, 'body'))[0]
  if (!body) throw new Error('DOCX 缺少正文')
  const cellByParagraph = new Map<XmlNode, EvidenceCell>()
  if (preserveTableCells) for (const table of Array.from(body.getElementsByTagNameNS(wordNamespace, 'tbl'))) {
    const children = (node: XmlNode, name: string) => Array.from(node.childNodes).filter(child => child.namespaceURI === wordNamespace && child.localName === name)
    const rows = children(table, 'tr').map(row => children(row, 'tc'))
    if (!rows.length || rows.some(row => row.length !== rows[0].length) || ['gridSpan', 'vMerge', 'tbl'].some(name => table.getElementsByTagNameNS(wordNamespace, name).length)) continue
    const cells = rows.map(row => row.map(cell => children(cell, 'p')))
    const header = cells[0].map(parts => parts.map(paragraphText).join(''))
    const evidence = header.findIndex(label => /^(?:证据(?:名称|材料)?|材料名称)$/u.test(label))
    const purpose = header.findIndex(label => /^(?:证明目的|拟证明事实|证明内容)$/u.test(label))
    if (evidence < 0 || purpose < 0) continue
    for (const [row, values] of cells.entries()) for (const [column, parts] of values.entries()) {
      for (const part of parts) cellByParagraph.set(part, { row: row + 1, column: column + 1,
        role: row === 0 ? 'header' : column === evidence ? 'evidence' : column === purpose ? 'purpose' : 'other' })
    }
  }
  return Array.from(body.getElementsByTagNameNS(wordNamespace, 'p')).map(paragraph => ({
    text: textNodes(paragraph).map(nodeText).join(''), evidenceCell: cellByParagraph.get(paragraph),
  }))
}

export async function readOfficeDocxText(bytes: Buffer) {
  return (await readOfficeDocxBlocks(bytes)).map(item => item.text).join('\n\n')
}

function appendText(run: XmlNode, text: string, reference: XmlNode | null) {
  const document = run.ownerDocument
  for (const part of text.split(/(\n|\t)/)) {
    const node = document.createElementNS(wordNamespace, part === '\n' ? 'w:br' : part === '\t' ? 'w:tab' : 'w:t')
    if (part === '\n') node.setAttribute('w:type', 'textWrapping')
    if (part !== '\n' && part !== '\t') {
      node.setAttribute('xml:space', 'preserve')
      node.appendChild(document.createTextNode(part))
    }
    run.insertBefore(node, reference)
  }
}

function textChangeRange(original: string, replacement: string) {
  let prefix = 0
  while (prefix < original.length && prefix < replacement.length && original[prefix] === replacement[prefix]) prefix++
  let suffix = 0
  while (suffix < original.length - prefix && suffix < replacement.length - prefix
    && original[original.length - 1 - suffix] === replacement[replacement.length - 1 - suffix]) suffix++
  return { prefix, end: original.length - suffix, replacementEnd: replacement.length - suffix }
}

function replaceParagraphText(paragraph: XmlNode, replacement: string) {
  const nodes = textNodes(paragraph)
  const original = nodes.map(nodeText).join('')
  // 保留未修改的前后文字及其原有 run、字体和链接，只替换发生变化的区间。
  const { prefix, end, replacementEnd } = textChangeRange(original, replacement)
  let position = 0
  let inserted = false
  for (const node of nodes) {
    const text = nodeText(node)
    const start = position
    position += text.length
    if (position < prefix || start > end) continue
    const left = text.slice(0, Math.max(0, prefix - start))
    const right = text.slice(Math.max(0, end - start))
    const middle = inserted ? '' : replacement.slice(prefix, replacementEnd)
    appendText(node.parentNode, left + middle + right, node)
    node.parentNode.removeChild(node)
    inserted = true
  }
  if (!inserted) {
    let run = Array.from(paragraph.childNodes).find(node => node.localName === 'r' && node.namespaceURI === wordNamespace)
    if (!run) {
      run = paragraph.ownerDocument.createElementNS(wordNamespace, 'w:r')
      paragraph.appendChild(run)
    }
    appendText(run, replacement, null)
  }
}

function isGroupedBlock(block: Block) {
  return /<(?:table|ol|ul)\b/i.test(block.richText ?? '') && /[\n\t]/u.test(block.text)
}

function paragraphSeparator(left: XmlNode, right: XmlNode) {
  const first = left.parentNode
  const second = right.parentNode
  return first !== second && first.namespaceURI === wordNamespace && second.namespaceURI === wordNamespace
    && first.localName === 'tc' && second.localName === 'tc' && first.parentNode === second.parentNode ? '\t' : '\n'
}

function alignParagraphs(source: OfficeParagraph[], base: Block[]) {
  const result = new Map<string, ParagraphSpan[]>()
  let cursor = 0
  for (const block of base) {
    const first = source[cursor]
    if (!first || result.has(block.id)) return
    const grouped = isGroupedBlock(block)
    const sameText = grouped ? first.text === block.text : normalizedParagraphText(first.text) === normalizedParagraphText(block.text)
    if (sameText) {
      result.set(block.id, [{ ...first, start: 0 }])
      cursor++
      continue
    }
    if (!grouped) return
    // 快照中的表格和列表必须精确覆盖连续的原文段落与结构分隔符。
    const spans: ParagraphSpan[] = []
    let start = 0
    while (cursor < source.length) {
      const current = source[cursor++]
      if (!block.text.startsWith(current.text, start)) return
      spans.push({ ...current, start })
      start += current.text.length
      if (start === block.text.length) break
      const following = source[cursor]
      if (!following || following.index !== current.index + 1
        || block.text[start] !== paragraphSeparator(current.paragraph, following.paragraph)) return
      start++
    }
    result.set(block.id, spans)
  }
  if (cursor === source.length) return result
}

function groupedMutation(block: Block, replacement: string, spans: ParagraphSpan[]) {
  const { prefix, end, replacementEnd } = textChangeRange(block.text, replacement)
  const span = spans.find(item => item.start <= prefix && end <= item.start + item.text.length)
  const inserted = replacement.slice(prefix, replacementEnd)
  if (!span || /[\t\r\n]/u.test(inserted)) fail()
  return { paragraph: span.paragraph, text: span.text.slice(0, prefix - span.start) + inserted + span.text.slice(end - span.start) }
}

function bodyInsertionAnchor(body: XmlNode, paragraph: XmlNode) {
  let anchor = paragraph
  while (anchor.parentNode !== body) anchor = anchor.parentNode
  if (anchor !== paragraph && (anchor.namespaceURI !== wordNamespace || anchor.localName !== 'tbl'
    || anchor.getElementsByTagNameNS(wordNamespace, 'p')[0] !== paragraph)) fail()
  return anchor
}

export async function patchOfficeDocx(bytes: Buffer, base: Block[], target: Block[]) {
  // 复用已随 mammoth 打包的 ZIP/XML 适配器，不增加运行依赖。升级 mammoth 时需执行保排版回归测试。
  const zip = await openArrayBuffer(bytes)
  const document = parseFromString(await zip.read('word/document.xml', 'utf8'))
  const body = Array.from(document.getElementsByTagNameNS(wordNamespace, 'body'))[0]
  if (!body) fail()
  const paragraphs = Array.from(body.getElementsByTagNameNS(wordNamespace, 'p'), (paragraph, index) => ({
    paragraph, text: textNodes(paragraph).map(nodeText).join(''), index,
  }))
  const originals = new Map(base.map(block => [block.id, block]))
  // 完整有序的基线可以按位置定位同文段落。旧版导入可能省略空段。
  const aligned = alignParagraphs(paragraphs, base) ?? alignParagraphs(paragraphs.filter(item => item.text.trim()), base)
  const byText = new Map<string, XmlNode[]>()
  if (!aligned) for (const { paragraph, text } of paragraphs) {
    const key = normalizedParagraphText(text)
    const matches = byText.get(key) ?? []
    matches.push(paragraph)
    byText.set(key, matches)
  }
  const locate = (block: Block) => {
    const alignedParagraph = aligned?.get(block.id)?.[0].paragraph
    if (alignedParagraph) return alignedParagraph
    if (isGroupedBlock(block)) fail()
    const matches = byText.get(normalizedParagraphText(block.text))
    if (matches?.length !== 1) fail()
    return matches[0]
  }
  const nextById = new Map(target.map(block => [block.id, block]))
  const mutations: Array<{ paragraph: XmlNode; text: string }> = []
  for (const block of base) {
    const next = nextById.get(block.id)
    if (next?.text === block.text) continue
    const spans = aligned?.get(block.id)
    if (spans && spans.length > 1) {
      if (!next) fail()
      mutations.push(groupedMutation(block, next.text, spans))
    } else mutations.push({ paragraph: locate(block), text: next?.text ?? '' })
  }
  const existingOrder = target.filter(block => originals.has(block.id)).map(block => block.id)
  const expectedOrder = base.filter(block => nextById.has(block.id)).map(block => block.id)
  if (JSON.stringify(existingOrder) !== JSON.stringify(expectedOrder)) fail()
  // 新段落插在相邻正文段落之间，表格内部等复杂插入交由编辑器处理。
  const additions: Array<{ reference: XmlNode | null; text: string }> = []
  for (let index = 0; index < target.length; index++) {
    const block = target[index]
    if (originals.has(block.id)) continue
    const following = target.slice(index + 1).find(item => originals.has(item.id))
    let reference = Array.from(body.childNodes).find(node => node.localName === 'sectPr') ?? null
    if (following) {
      reference = bodyInsertionAnchor(body, locate(originals.get(following.id)!))
    }
    additions.push({ reference, text: block.text })
  }
  for (const mutation of mutations) replaceParagraphText(mutation.paragraph, mutation.text)
  for (const addition of additions) {
    const paragraph = document.createElementNS(wordNamespace, 'w:p')
    const run = document.createElementNS(wordNamespace, 'w:r')
    paragraph.appendChild(run)
    appendText(run, addition.text, null)
    body.insertBefore(paragraph, addition.reference)
  }
  zip.write('word/document.xml', document.toString())
  return Buffer.from(await zip.toArrayBuffer())
}
