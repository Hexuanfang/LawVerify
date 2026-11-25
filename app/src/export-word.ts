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
import type { AppState, Certificate } from './types'
import { requireWordExportSnapshot, reviewReadiness } from './redesign/workflow'
import { caseRoleLabels } from '../../server/src/intelligence/case-roles'
import { STATUS_NAMES, type ReviewElement } from './redesign/model'
import { reportSourceLabels, reviewReportSummary } from './redesign/reviewOverview'
import { caseCitations, caseReportOverview, describeCaseReportRow } from './redesign/caseResearchReport'
import { readCaseAssistantAudits, readReviewAudits } from './redesign/review-audit-store'
import { formatVerificationCalculation, VERIFICATION_ACTION_LABELS, verificationImpacts, verificationReportMetadata,
  verifiedCaseMemory, verifiedDocumentDiagnostics } from './redesign/verificationMemory'
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

type WordExportContext = CertificateExportContext & {
  reportSections?: Array<{ title: string; lines: string[] }>
}

// 简单的 HTML 解析器，用于提取富文本格式
type StyledSegment = { text: string; bold?: boolean; italic?: boolean; underline?: boolean }
function parseHtmlSegments(html: string): StyledSegment[] {
  const parser = new DOMParser()
  const doc = parser.parseFromString(html, 'text/html')

  const segments: StyledSegment[] = []

  function traverse(node: Node, formatting: { bold?: boolean; italic?: boolean; underline?: boolean } = {}) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.textContent) {
        segments.push({ text: node.textContent, ...formatting })
      }
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement
      const newFormatting = { ...formatting }

      if (el.tagName === 'STRONG' || el.tagName === 'B') newFormatting.bold = true
      if (el.tagName === 'EM' || el.tagName === 'I') newFormatting.italic = true
      if (el.tagName === 'U') newFormatting.underline = true

      // 处理 p 标签带来的换行，暂时不需要，因为我们会在外部作为独立的 Paragraph 处理
      // 一个存储块可能包含多个富文本段落。
      // 在当前设计中，每个 CertificateParagraph 对应一个 p，所以只处理内联格式
      node.childNodes.forEach(child => traverse(child, newFormatting))
    }
  }

  doc.body.childNodes.forEach(child => traverse(child))

  return segments.length > 0 ? segments : [{ text: '' }]
}

const makeTextRun = (segment: StyledSegment, text = segment.text) => new TextRun({ text, bold: segment.bold, italics: segment.italic, underline: segment.underline ? {} : undefined })

function anchoredParagraph(segments: StyledSegment[], marks: Array<{ id: number; start: number; end: number }>) {
  const positions = [...new Set(marks.flatMap(mark => [mark.start, mark.end]))].sort((left, right) => left - right)
  const children: Array<TextRun | CommentRangeStart | CommentRangeEnd> = []
  let offset = 0
  let nextPosition = 0
  for (const segment of segments) {
    const until = offset + segment.text.length
    let cursor = offset
    while (nextPosition < positions.length && positions[nextPosition] <= until) {
      const position = positions[nextPosition++]
      if (position > cursor) children.push(makeTextRun(segment, segment.text.slice(cursor - offset, position - offset)))
      for (const mark of marks.filter(item => item.end === position)) children.push(new CommentRangeEnd(mark.id), new TextRun({ children: [new CommentReference(mark.id)] }))
      for (const mark of marks.filter(item => item.start === position)) children.push(new CommentRangeStart(mark.id))
      cursor = position
    }
    if (cursor < until) children.push(makeTextRun(segment, segment.text.slice(cursor - offset)))
    offset = until
  }
  return children
}

function formatDateTime(date: Date) {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

async function cleanReportSections(workspace: AppState, certificate: Certificate, elements: ReviewElement[]) {
  const diagnostics = verifiedDocumentDiagnostics(workspace, certificate)
  const report = reviewReportSummary(elements, Boolean(certificate.linkageStale), true, diagnostics.length)
  const review = reviewReadiness(workspace, certificate.caseId, certificate.id)
  const cases = caseCitations(elements, workspace.knowledgeCases ?? [])
  const caseLines = cases.flatMap(row => {
    const item = describeCaseReportRow(row)
    return [
      [item.title, item.caseNumber, item.court, item.judgmentDate, item.source, item.status].filter(Boolean).join(' · '),
      ...item.details.map(detail => [detail.text, detail.url].filter(Boolean).join('　')),
    ]
  })
  const metadata = verificationReportMetadata(certificate)
  const metadataLines = metadata ? [
    `核验规则版本 ${metadata.profileVersion}`,
    metadata.verifiedAt ? `核验时间 ${formatDateTime(new Date(metadata.verifiedAt))}` : '',
    metadata.checkedAt > 0 ? `最近法源核对 ${formatDateTime(new Date(metadata.checkedAt))}` : '',
    metadata.statuteVersions.length ? `法条版本 ${metadata.statuteVersions.join('、')}` : '',
  ].filter(Boolean) : []
  const impacts = verificationImpacts(certificate, elements).flatMap(({ source, target, check, outcome, reason }) => [
    `${check} · ${STATUS_NAMES[outcome]} · ${reason}`,
    source ? `依赖声明 · ${source.quote}` : '依赖声明已无法定位',
    `受影响声明 · ${target.quote}`,
  ])
  const audits = (certificate.verification?.audit ?? []).flatMap(item => [
    `${formatDateTime(new Date(item.at))} · ${item.actor} · ${VERIFICATION_ACTION_LABELS[item.action]}`,
    item.quote ? `原文 · ${item.quote}${item.previousVerdict ? ` · ${STATUS_NAMES[item.previousVerdict]}` : ''}` : '',
    item.note ?? '',
    ...(item.sources ?? []).map(source => `出处 · ${[source.name, source.locator].filter(Boolean).join(' · ')}`),
    item.affected?.length ? `涉及 ${item.affected.length} 项声明` : '',
  ].filter(Boolean))
  const account = sessionStorage.getItem('lawverify-login-account') || workspace.user.email
  const localAudits = await Promise.all([readReviewAudits(account, certificate.id), readCaseAssistantAudits(account, certificate.caseId)])
    .then(results => results.flat().sort((left, right) => left.t.localeCompare(right.t))
      .map(item => `${formatDateTime(new Date(item.t))} · ${item.account} · ${item.msg}`))
    .catch(() => ['本机人工操作记录暂无法读取。'])
  return [
    { title: '核验结论', lines: [report.summary, report.guidance, `人工审阅 ${review.total - review.unreviewed} / ${review.total} 段`] },
    { title: '核验时间与版本', lines: metadataLines },
    { title: '信源分类', lines: report.counts.map(({ source, count }) => `${reportSourceLabels[source]} · ${count} 项声明`) },
    ...report.groups.map(([title, items]) => ({ title: `${title} · ${items.length} 项`, lines: items.length
      ? items.flatMap(element => [
        [STATUS_NAMES[element.verdict], element.quote].join(' · '), element.reason,
        ...(element.ignored ? ['律师已忽略此预警'] : []),
        ...[element.declaration?.review?.note, element.original.note].filter((note): note is string => Boolean(note)),
        ...element.sources.map(source => [reportSourceLabels[source.st], source.name, source.loc].filter(Boolean).join(' · ')),
      ].filter(Boolean)) : ['暂无'] })),
    { title: '联动影响', lines: impacts },
    { title: '案例检索报告预览', lines: cases.length ? [caseReportOverview(cases), ...caseLines] : ['当前文书暂无关联案例。'] },
    { title: '人工操作与核验记录', lines: [...audits, ...localAudits] },
  ].filter(section => section.lines.length > 0)
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

function createDocument(context: WordExportContext, useWordComments: boolean) {
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
    const segments = paragraph.richText && typeof DOMParser !== 'undefined'
      ? parseHtmlSegments(paragraph.richText)
      : [{ text: paragraph.text }]
    const bodyChildren = segments.map(segment => makeTextRun(segment))

    const commentText = context.options.bodyAnnotations === false ? '' : buildParagraphComment(context, index)

    if (useWordComments && commentText) {
      const addComment = (text: string) => {
        const id = comments.length
        comments.push({ id, author: 'LawVerify 核验', initials: 'LV', date: context.exportedAt ?? new Date(),
          children: [new Paragraph({ children: [new TextRun({ text, size: 20 })] })] })
        return id
      }
      const exact = segments.map(item => item.text).join('') === paragraph.text
        ? (context.declarationComments?.get(paragraph.id) ?? []).filter(item => item.end > item.start && item.start >= 0
          && item.end <= paragraph.text.length && paragraph.text.slice(item.start, item.end) === item.quote)
        : []
      if (exact.length) {
        const marks = exact.map(item => ({ id: addComment(item.text), start: item.start, end: item.end }))
        paragraphs.push(new Paragraph({ children: anchoredParagraph(segments, marks), spacing: { after: 200, line: 360 } }))
        return
      }
      const commentId = addComment(commentText)
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
    for (const [index, paragraph] of certificate.paragraphs.entries()) {
      for (const entry of context.declarationComments?.get(paragraph.id) ?? []) {
        paragraphs.push(new Paragraph({ children: [new TextRun(`第 ${index + 1} 段 · ${entry.text}`)] }))
      }
    }
    for (const diagnostic of context.documentDiagnostics ?? []) {
      const sources = diagnostic.sources.map(source => [source.name, source.locator].filter(Boolean).join(' · '))
      paragraphs.push(new Paragraph({ children: [new TextRun(`文书级预警　${diagnostic.reason} ${sources.join('；')}`)] }))
    }
    for (const note of context.calculationNotes ?? []) {
      paragraphs.push(new Paragraph({ children: [new TextRun(note)] }))
    }
    for (const { title, lines } of context.reportSections ?? []) {
      paragraphs.push(new Paragraph({ children: [new TextRun({ text: title, bold: true })], keepNext: true, spacing: { before: 200 } }))
      for (const line of lines) paragraphs.push(new Paragraph({ children: [new TextRun(line)] }))
    }
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

export async function exportCertificateToWord(workspace: AppState, certificateId: string,
  options: Pick<CertificateExportContext, 'appVersion' | 'options'>) {
  const { certificate, elements } = await requireWordExportSnapshot(workspace, certificateId)
  const documentDiagnostics = verifiedDocumentDiagnostics(workspace, certificate)
  const calculationNotes = verifiedCaseMemory(workspace, certificate.caseId, certificate.id).flatMap(item => {
    if (!item.calculation) return []
    const sources = (item.calculation.sources ?? item.sources).map(source => [source.name, source.locator].filter(Boolean).join(' · '))
    return [`第 ${item.location.paragraphIndex + 1} 段金额复算　${formatVerificationCalculation(item.calculation)}。依据 ${sources.join('；')}`]
  })
  const notesByParagraph = new Map<string, string[]>()
  const reviewedByParagraph = new Map<string, boolean>()
  const declarationComments = new Map<string, Array<{ start: number; end: number; quote: string; text: string }>>()
  for (const element of elements) {
    const notes = notesByParagraph.get(element.paragraphId) ?? []
    const summary = `${STATUS_NAMES[element.verdict]}：${element.quote}（${element.reason}）`
    const sources = element.sources.map(source => [source.name, source.loc].filter(Boolean).join(' · '))
    const text = [summary, ...sources, element.ignored && '律师已忽略此预警', element.note].filter(Boolean).join('；')
    notes.push([summary, ...sources, element.ignored && '律师已忽略此预警', element.declaration?.review?.note].filter(Boolean).join('；'))
    notesByParagraph.set(element.paragraphId, notes)
    if (certificate.verification?.revision && element.declaration) {
      reviewedByParagraph.set(element.paragraphId, (reviewedByParagraph.get(element.paragraphId) ?? true) && Boolean(element.verified || element.ignored))
    }
    const comments = declarationComments.get(element.paragraphId) ?? []
    comments.push({ start: element.start, end: element.end, quote: element.quote, text })
    declarationComments.set(element.paragraphId, comments)
  }
  const reportSections = options.options.bodyAnnotations === false && options.options.verificationRecord
    ? await cleanReportSections(workspace, certificate, elements) : undefined
  const context: WordExportContext = {
    ...options,
    declarationComments,
    documentDiagnostics,
    calculationNotes,
    reportSections,
    options: { ...options.options, verificationRecord: options.options.verificationRecord || documentDiagnostics.length > 0
      || calculationNotes.length > 0 || elements.some(item => item.verdict === 'warn') },
    certificate: { ...certificate, paragraphs: certificate.paragraphs.map(paragraph => ({
      ...paragraph, verified: reviewedByParagraph.get(paragraph.id) ?? paragraph.verified,
      note: [paragraph.note, ...(notesByParagraph.get(paragraph.id) ?? [])].filter(Boolean).join('\n'),
    })) },
    caseFolder: workspace.cases.find(item => item.id === certificate.caseId) ?? null,
    evidences: workspace.evidences.filter(item => item.caseId === certificate.caseId),
    roleLabel: caseRoleLabels[certificate.role] ?? '',
    operator: workspace.user.name || workspace.user.email,
    exportedAt: new Date(),
  }
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
