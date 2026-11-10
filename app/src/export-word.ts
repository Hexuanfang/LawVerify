import {
  AlignmentType,
  CommentRangeEnd,
  CommentRangeStart,
  CommentReference,
  Document,
  Footer,
  Header,
  PageNumber,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx'
import type { CertificateExportContext } from './export-context'
import {
  buildDeclarationData,
  buildEvidenceCatalogRows,
  buildParagraphComment,
  buildVerificationRecordRows,
  CATALOG_TITLE,
  VERIFICATION_TITLE,
} from './export-declaration'

// 中文正文仿宋、标题黑体、正文小四（24 半磅 = 12pt）。
const BODY_FONT = { ascii: 'Times New Roman', eastAsia: '仿宋', hAnsi: 'Times New Roman' }
const TITLE_FONT = { ascii: 'Times New Roman', eastAsia: '黑体', hAnsi: 'Times New Roman' }
const BODY_SIZE = 24
const TITLE_SIZE = 32
const APPENDIX_TITLE_SIZE = 28
// 表格里的内容比正文小一号，避免表格被撑破页面。
const TABLE_SIZE = 20

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

function formatDateTime(date: Date) {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function buildStyles() {
  return {
    default: {
      document: {
        run: { font: BODY_FONT, size: BODY_SIZE },
        paragraph: { spacing: { line: 360 } },
      },
    },
    paragraphStyles: [
      {
        id: 'ExportTitle',
        name: 'Export Title',
        basedOn: 'Normal',
        next: 'Normal',
        quickFormat: true,
        run: { font: TITLE_FONT, size: TITLE_SIZE, bold: true },
        paragraph: { alignment: AlignmentType.CENTER, spacing: { before: 240, after: 400 } },
      },
      {
        id: 'ExportAppendixTitle',
        name: 'Export Appendix Title',
        basedOn: 'Normal',
        next: 'Normal',
        quickFormat: true,
        run: { font: TITLE_FONT, size: APPENDIX_TITLE_SIZE, bold: true },
        paragraph: { spacing: { before: 360, after: 200 } },
      },
    ],
  }
}

function textCell(text: string, options: { bold?: boolean; size?: number } = {}) {
  return new TableCell({
    children: [new Paragraph({
      children: [new TextRun({ text, bold: options.bold, size: options.size ?? TABLE_SIZE })],
      spacing: { line: 240 },
    })],
  })
}

function buildTable(headers: string[], rows: string[][]) {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        tableHeader: true,
        children: headers.map(header => textCell(header, { bold: true })),
      }),
      ...rows.map(row => new TableRow({
        children: row.map(cell => textCell(cell)),
      })),
    ],
  })
}

function createDocument(context: CertificateExportContext, useWordComments: boolean) {
  const certificate = context.certificate
  const paragraphs: Array<Paragraph | Table> = []
  const comments: Array<{
    id: number
    author: string
    initials: string
    date: Date
    children: Paragraph[]
  }> = []

  paragraphs.push(new Paragraph({
    style: 'ExportTitle',
    children: [new TextRun({ text: certificate.title })],
  }))

  certificate.paragraphs.forEach((paragraph, index) => {
    const bodyChildren: TextRun[] = paragraph.richText
      ? parseHtmlToTextRuns(paragraph.richText)
      : [new TextRun({ text: paragraph.text })]

    const commentText = buildParagraphComment(context, index)

    if (useWordComments && commentText) {
      // Word 真批注：批注范围覆盖整段，右侧批注栏可见。
      const commentId = comments.length
      comments.push({
        id: commentId,
        author: 'LawVerify 核验',
        initials: 'LV',
        date: context.exportedAt ?? new Date(),
        children: [new Paragraph({
          children: [new TextRun({ text: commentText, size: 20 })],
        })],
      })
      paragraphs.push(new Paragraph({
        children: [
          new CommentRangeStart(commentId),
          ...bodyChildren,
          new CommentRangeEnd(commentId),
          new TextRun({ children: [new CommentReference(commentId)] }),
        ],
        spacing: { after: 200, line: 360 },
      }))
      return
    }

    paragraphs.push(new Paragraph({
      children: bodyChildren,
      spacing: { after: 200, line: 360 },
    }))

    // 回退方案：真批注不可用时，用灰色小字批注行保留核验痕迹。
    if (commentText) {
      paragraphs.push(new Paragraph({
        children: [new TextRun({ text: `批注：${commentText}`, size: 18, color: '808080' })],
        spacing: { after: 200, line: 360 },
      }))
    }
  })

  if (context.options.evidenceCatalog) {
    paragraphs.push(new Paragraph({
      style: 'ExportAppendixTitle',
      children: [new TextRun({ text: CATALOG_TITLE })],
    }))
    const rows = buildEvidenceCatalogRows(context).map(row => [
      String(row.index),
      row.sourceNumber,
      row.number,
      row.name,
      row.type,
      row.pages === null ? '—' : String(row.pages),
      row.usage,
    ])
    paragraphs.push(buildTable(
      ['序号', '文书引用编号', '目录编号', '材料名称', '类型', '页数', '本文书引用情况'],
      rows,
    ))
  }

  if (context.options.verificationRecord) {
    paragraphs.push(new Paragraph({
      style: 'ExportAppendixTitle',
      children: [new TextRun({ text: VERIFICATION_TITLE })],
    }))
    const rows = buildVerificationRecordRows(context).map(row => [
      String(row.index),
      row.firstSentence,
      String(row.sentenceCount),
      row.status,
      String(row.linkedEvidenceCount),
      String(row.statuteCount),
      String(row.caseCount),
      row.commentSummary,
    ])
    paragraphs.push(buildTable(
      ['段号', '段落首句', '句数', '核验状态', '已挂证据数', '法条引用数', '案例引用数', '批注摘要'],
      rows,
    ))
  }

  if (context.options.declaration) {
    const declaration = buildDeclarationData(context)
    paragraphs.push(new Paragraph({
      style: 'ExportAppendixTitle',
      children: [new TextRun({ text: declaration.title })],
    }))
    for (const line of declaration.body) {
      paragraphs.push(new Paragraph({
        children: [new TextRun({ text: line })],
        spacing: { after: 160, line: 360 },
      }))
    }
    for (const field of declaration.fields) {
      paragraphs.push(new Paragraph({
        children: [
          new TextRun({ text: `${field.label}：`, bold: true }),
          new TextRun({ text: field.value }),
        ],
        spacing: { after: 80, line: 360 },
      }))
    }
    paragraphs.push(new Paragraph({
      children: [
        new TextRun({ text: '核验统计：', bold: true }),
        new TextRun({
          text: `段落总数 ${declaration.stats.totalParagraphs}，已核验 ${declaration.stats.verifiedParagraphs}，`
            + `已挂证据句数 ${declaration.stats.linkedSentenceCount}，`
            + `未核验段落 ${declaration.stats.unverifiedParagraphIndexes.length
              ? declaration.stats.unverifiedParagraphIndexes.join('、')
              : '无'}`,
        }),
      ],
      spacing: { after: 160, line: 360 },
    }))
    paragraphs.push(new Paragraph({
      children: [new TextRun({ text: declaration.disclaimer, bold: true })],
      spacing: { after: 160, line: 360 },
    }))
  }

  const headerText = [context.caseFolder?.name, certificate.title].filter(Boolean).join('　·　')

  return new Document({
    creator: 'LawVerify',
    title: certificate.title,
    description: 'AI 辅助与人工核验声明已随附于文末附录。',
    styles: buildStyles(),
    comments: useWordComments && comments.length
      ? { children: comments }
      : undefined,
    sections: [
      {
        properties: {},
        headers: {
          default: new Header({
            children: [new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [new TextRun({ text: headerText, size: 18, color: '666666' })],
            })],
          }),
        },
        footers: {
          default: new Footer({
            children: [new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [
                new TextRun({ text: '第 ', size: 18, color: '666666' }),
                new TextRun({ children: [PageNumber.CURRENT], size: 18, color: '666666' }),
                new TextRun({ text: ' 页 / 共 ', size: 18, color: '666666' }),
                new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 18, color: '666666' }),
                new TextRun({ text: ` 页　导出时间：${formatDateTime(context.exportedAt ?? new Date())}`, size: 18, color: '666666' }),
              ],
            })],
          }),
        },
        children: paragraphs,
      },
    ],
  })
}

async function packDocument(context: CertificateExportContext, useWordComments: boolean) {
  const doc = createDocument(context, useWordComments)
  return Packer.toBlob(doc)
}

/**
 * 生成 Word 文档二进制内容。
 * 单独暴露出来是为了让产物体积与结构可以被自动化测试直接检查。
 */
export async function buildCertificateWordBytes(
  context: CertificateExportContext,
  options: { useWordComments?: boolean } = {},
): Promise<{ bytes: Uint8Array<ArrayBuffer>; usedComments: boolean }> {
  const wantComments = options.useWordComments ?? context.options.useWordComments
  let usedComments = wantComments
  let blob: Blob

  if (wantComments) {
    try {
      blob = await packDocument(context, true)
    } catch (error) {
      // 真批注不可用时回退为灰色小字批注行，附录表格不受影响。
      console.warn('Word 真批注生成失败，已回退为灰色小字批注行：', error)
      usedComments = false
      blob = await packDocument(context, false)
    }
  } else {
    blob = await packDocument(context, false)
  }

  return { bytes: new Uint8Array(await blob.arrayBuffer()), usedComments }
}

export async function exportCertificateToWord(context: CertificateExportContext) {
  const { bytes, usedComments } = await buildCertificateWordBytes(context)
  const blob = new Blob([bytes], {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  })

  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  const safeTitle = context.certificate.title.replace(/[\\/:*?"<>|]/g, '')
  const safeCaseName = (context.caseFolder?.name ?? '').replace(/[\\/:*?"<>|]/g, '')
  link.download = `${safeCaseName ? safeCaseName + '-' : ''}${safeTitle}${usedComments ? '' : '-无批注'}.docx`
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}
