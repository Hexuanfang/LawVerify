import { openArrayBuffer } from 'mammoth/lib/zipfile.js'
import { parseFromString, type XmlNode } from 'mammoth/lib/xml/xmldom.js'
import type { CertificateParagraph } from '../domain.js'
import { AppError } from '../core/app-error.js'
import type { EvidenceCell } from '../intelligence/verification/protocol.js'

type Block = Pick<CertificateParagraph, 'id' | 'text'>
const wordNamespace = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'

function fail() {
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

function paragraphText(node: XmlNode) {
  return textNodes(node).map(nodeText).join('').replace(/\r\n/g, '\n').trim()
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

function replaceParagraphText(paragraph: XmlNode, replacement: string) {
  const nodes = textNodes(paragraph)
  const original = nodes.map(nodeText).join('')
  // 保留未修改的前后文字及其原有 run、字体和链接，只替换发生变化的区间。
  let prefix = 0
  while (prefix < original.length && prefix < replacement.length && original[prefix] === replacement[prefix]) prefix++
  let suffix = 0
  while (suffix < original.length - prefix && suffix < replacement.length - prefix
    && original[original.length - 1 - suffix] === replacement[replacement.length - 1 - suffix]) suffix++
  const end = original.length - suffix
  let position = 0
  let inserted = false
  for (const node of nodes) {
    const text = nodeText(node)
    const start = position
    position += text.length
    if (position < prefix || start > end) continue
    const left = text.slice(0, Math.max(0, prefix - start))
    const right = text.slice(Math.max(0, end - start))
    const middle = inserted ? '' : replacement.slice(prefix, replacement.length - suffix)
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

export async function patchOfficeDocx(bytes: Buffer, base: Block[], target: Block[]) {
  // 复用已随 mammoth 打包的 ZIP/XML 适配器，不增加运行依赖。升级 mammoth 时需执行保排版回归测试。
  const zip = await openArrayBuffer(bytes)
  const document = parseFromString(await zip.read('word/document.xml', 'utf8'))
  const body = Array.from(document.getElementsByTagNameNS(wordNamespace, 'body'))[0]
  if (!body) fail()
  const paragraphs = Array.from(body.getElementsByTagNameNS(wordNamespace, 'p'))
  const byText = new Map<string, XmlNode[]>()
  for (const paragraph of paragraphs) {
    const text = paragraphText(paragraph)
    const matches = byText.get(text) ?? []
    matches.push(paragraph)
    byText.set(text, matches)
  }
  const nextById = new Map(target.map(block => [block.id, block]))
  const originals = new Map(base.map(block => [block.id, block]))
  const mutations: Array<{ paragraph: XmlNode; text: string }> = []
  for (const block of base) {
    const next = nextById.get(block.id)
    if (next?.text === block.text) continue
    const matches = byText.get(block.text.replace(/\r\n/g, '\n').trim()) ?? []
    if (matches.length !== 1) fail()
    mutations.push({ paragraph: matches[0], text: next?.text ?? '' })
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
      const original = originals.get(following.id)!
      const matches = byText.get(original.text.replace(/\r\n/g, '\n').trim()) ?? []
      if (matches.length !== 1 || matches[0].parentNode !== body) fail()
      reference = matches[0]
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
