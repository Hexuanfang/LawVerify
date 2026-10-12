import { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } from 'docx'
import type { Certificate } from './types'

// 简单的 HTML 解析器，用于提取富文本格式
function parseHtmlToTextRuns(html: string): TextRun[] {
  const parser = new DOMParser()
  const doc = parser.parseFromString(html, 'text/html')
  
  const textRuns: TextRun[] = []

  function traverse(node: Node, formatting: { bold?: boolean; italic?: boolean; underline?: boolean } = {}) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.textContent) {
        textRuns.push(new TextRun({
          text: node.textContent,
          bold: formatting.bold,
          italics: formatting.italic,
          underline: formatting.underline ? {} : undefined
        }))
      }
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement
      const newFormatting = { ...formatting }
      
      if (el.tagName === 'STRONG' || el.tagName === 'B') newFormatting.bold = true
      if (el.tagName === 'EM' || el.tagName === 'I') newFormatting.italic = true
      if (el.tagName === 'U') newFormatting.underline = true
      
      // 处理 p 标签带来的换行，暂时不需要，因为我们会在外部作为独立的 Paragraph 处理
      // 但 Tiptap 可能会把多段内容放在一个 richText 中（如果是合并的）
      // 在当前设计中，每个 CertificateParagraph 对应一个 p，所以只处理内联格式
      node.childNodes.forEach(child => traverse(child, newFormatting))
    }
  }

  doc.body.childNodes.forEach(child => traverse(child))
  
  return textRuns.length > 0 ? textRuns : [new TextRun({ text: '' })]
}

export async function exportCertificateToWord(certificate: Certificate, caseName: string) {
  const paragraphs: Paragraph[] = []

  // 标题
  paragraphs.push(
    new Paragraph({
      text: certificate.title,
      heading: HeadingLevel.HEADING_1,
      alignment: AlignmentType.CENTER,
      spacing: {
        after: 400,
      }
    })
  )

  // 内容段落
  for (const p of certificate.paragraphs) {
    let children: TextRun[] = []
    
    if (p.richText) {
      children = parseHtmlToTextRuns(p.richText)
    } else {
      children = [new TextRun({ text: p.text })]
    }

    paragraphs.push(
      new Paragraph({
        children,
        spacing: {
          after: 200,
          line: 360, // 1.5 倍行距
        }
      })
    )
  }

  const doc = new Document({
    sections: [
      {
        properties: {},
        children: paragraphs,
      },
    ],
  })

  const blob = await Packer.toBlob(doc)
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  const safeTitle = certificate.title.replace(/[\\/:*?"<>|]/g, '')
  const safeCaseName = caseName.replace(/[\\/:*?"<>|]/g, '')
  link.download = `${safeCaseName ? safeCaseName + '-' : ''}${safeTitle}.docx`
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}
