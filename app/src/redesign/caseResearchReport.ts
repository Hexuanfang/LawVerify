import type { RetrievalCard } from '../../../server/src/assistant/retrieval'
import type { KnowledgeCase } from '../types'
import { STATUS_NAMES, type ReviewElement, type Source } from './model.ts'

type CaseVerification = NonNullable<ReviewElement['caseVerification']>
export const CASE_MATCH_LABELS = { strict: '严格命中', analogous: '近似类比', irrelevant: '不相关' }
const CASE_EFFECT_LABELS = { effective: '生效', pending: '待确认生效', vacated: '已撤销', amended: '已改判', unknown: '未确认' }
export type CaseReportSupplement = Pick<KnowledgeCase, 'id' | 'title'> & Partial<Pick<KnowledgeCase,
  'caseNumber' | 'courtName' | 'judgmentDate' | 'issueSummary' | 'holdingSummary' | 'reasoningSummary' | 'resultSummary' | 'sourceUrl'>>
type CaseReportRow = { entry?: CaseReportSupplement; title: string; verification?: CaseVerification;
  documents: NonNullable<CaseVerification['documents']>; citations: { element: ReviewElement; source: Source }[] }

const numberKey = (number?: string) => number?.normalize('NFKC').replace(/[〔【]/gu, '(').replace(/[〕】]/gu, ')').replace(/\s/gu, '')

export function caseReportSupplement(card: RetrievalCard): CaseReportSupplement | undefined {
  const { caseVerification: verification, entry } = card
  if (!verification || ['authoritative-not-found', 'identity-mismatch', 'conflicting-detail'].includes(verification.detailOutcome)
    || (verification.detailOutcome === 'found' && !verification.allowCitation)
    || verification.match === 'irrelevant' || verification.effect === 'amended' || verification.effect === 'vacated') return
  const sourceUrl = card.url ?? entry?.sourceUrl
  const url = sourceUrl && URL.canParse(sourceUrl) ? new URL(sourceUrl) : undefined
  const caseNumber = verification.caseNumber || entry?.caseNumber
  const id = numberKey(caseNumber)
  if (!id || !url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) return
  return { ...entry, id, title: card.label, caseNumber, sourceUrl,
    courtName: verification.court ?? entry?.courtName, judgmentDate: verification.judgmentDate ?? entry?.judgmentDate }
}

export function caseCitations(elements: ReviewElement[], library: KnowledgeCase[], supplemental: CaseReportSupplement[] = []) {
  const targets = new Map<string, KnowledgeCase>()
  for (const entry of library) {
    targets.set(entry.id, entry)
    for (const excerpt of entry.excerpts ?? []) targets.set(excerpt.id, entry)
  }
  const rows = new Map<string, CaseReportRow>()
  const keyFor = (entry?: CaseReportSupplement, fallback = '') => numberKey(entry?.caseNumber) || entry?.id || fallback
  const associatedCases = new Set<string>()
  const remember = (...keys: (string | undefined)[]) => {
    for (const key of keys) if (key) associatedCases.add(key)
  }
  for (const element of elements) {
    const verification = element.caseVerification
    const documents = verification?.documents ?? []
    const sources = element.sources.filter(source => source.st === 'l3' && source.targetId)
    if (verification && (!verification.allowCitation || sources.length)) {
      remember(verification.groupId, numberKey(verification.groupId), numberKey(verification.caseNumber))
      for (const document of documents) remember(document.id, numberKey(document.caseNumber))
    }
    for (const source of sources) {
      const entry = targets.get(source.targetId)
      remember(source.targetId, entry?.id, numberKey(entry?.caseNumber))
      if (verification && !verification.allowCitation) continue
      const key = verification?.groupId || numberKey(verification?.caseNumber) || keyFor(entry, source.targetId)
      const row = rows.get(key) ?? { entry, verification, title: verification?.name || entry?.title || source.name, citations: [], documents: [] }
      for (const document of documents) {
        if (!row.documents.some(item => item.caseNumber === document.caseNumber && item.url === document.url)) row.documents.push(document)
      }
      row.citations.push({ element, source })
      rows.set(key, row)
    }
  }
  for (const entry of supplemental) {
    const key = keyFor(entry)
    if (key && !rows.has(key) && !associatedCases.has(key) && !associatedCases.has(entry.id)) {
      rows.set(key, { entry, title: entry.title, citations: [], documents: [] })
      remember(key, entry.id)
    }
  }
  return [...rows.values()]
}

export const CASE_REPORT_DISCLAIMER = '案例原文及裁判信息以权威来源为准。请在对外使用前核对原文、裁判结果及与本案的相似性。'

export function caseReportOverview(rows: CaseReportRow[]) {
  const linkedCount = rows.filter(row => row.citations.length).length
  return `共 ${rows.length} 件案例，文书关联 ${linkedCount} 件，补充检索 ${rows.length - linkedCount} 件。`
}

export function describeCaseReportRow({ entry, title, verification, documents, citations }: CaseReportRow) {
  const statusOf = (element: ReviewElement) => `${STATUS_NAMES[element.verdict]}${element.verified ? '' : ' · 待人工审阅'}`
  const associated = citations.length > 0
  const details: { text: string; url?: string }[] = []
  if (verification?.effect) details.push({ text: `裁判效力：${CASE_EFFECT_LABELS[verification.effect]}` })
  for (const item of documents) {
    if (item.url) details.push({ text: `裁判出处 ${item.caseNumber}`, url: item.url })
  }
  if (!verification) {
    for (const [label, value] of [
      ['争议焦点', entry?.issueSummary], ['裁判要旨', entry?.holdingSummary],
      ['裁判理由', entry?.reasoningSummary], ['裁判结果', entry?.resultSummary],
    ]) {
      if (value) details.push({ text: `${associated ? label : `检索摘要（${label}，待核）`}：${value}` })
    }
  }
  if (entry?.sourceUrl && !documents.some(item => item.url === entry.sourceUrl)) {
    details.push({ text: associated ? '出处链接' : '检索来源链接（待核）', url: entry.sourceUrl })
  }
  for (const { element, source } of citations) {
    details.push({ text: `文书声明：${element.quote}` })
    if (source.loc) details.push({ text: `出处定位：${source.loc}` })
    if (source.quote) details.push({ text: `出处摘录：${source.quote}` })
    details.push({ text: `核验状态：${statusOf(element)}` })
    if (element.caseVerification?.match) details.push({ text: `命中层级：${CASE_MATCH_LABELS[element.caseVerification.match]}` })
  }
  return {
    title,
    caseNumber: [...new Set(documents.map(item => item.caseNumber).filter(Boolean))].join('、') || verification?.caseNumber || entry?.caseNumber,
    court: verification?.court || entry?.courtName,
    judgmentDate: verification?.judgmentDate || entry?.judgmentDate,
    source: associated ? '文书关联' : '补充检索',
    status: associated ? [...new Set(citations.map(({ element }) => statusOf(element)))].join('、') : '待核对 · 仅作检索线索',
    details,
  }
}

export async function exportCaseResearchReport(metadata: {
  caseName: string; docTitle?: string; operator?: string; query?: string
}, rows: ReturnType<typeof caseCitations>) {
  if (!rows.length) throw new Error('暂无可回查的案例。')
  const { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, WidthType } = await import('docx')
  const paragraph = (text: string) => new Paragraph({ text })
  const heading = (text: string) => new Paragraph({ text, heading: HeadingLevel.HEADING_1 })
  const tableRow = (columns: string[]) => new TableRow({
    children: columns.map(text => new TableCell({ children: [paragraph(text || '未记录')] })),
  })
  const cases = rows.map(describeCaseReportRow)
  const documentFile = new Document({
    title: '案例检索报告',
    sections: [{ children: [
      new Paragraph({ text: '案例检索报告', heading: HeadingLevel.TITLE }),
      heading('检索任务'),
      paragraph(`案件：${metadata.caseName}`),
      ...(metadata.docTitle ? [paragraph(`文书：${metadata.docTitle}`)] : []),
      ...(metadata.operator ? [paragraph(`经办人：${metadata.operator}`)] : []),
      paragraph(`生成时间：${new Date().toLocaleString('zh-CN')}`),
      paragraph(metadata.query ? `补充检索关键词：${metadata.query}` : rows.some(row => !row.citations.length)
        ? '检索口径：文书关联的 L3 案例及经选入的补充检索线索。' : '检索口径：本文书已关联的 L3 案例。'),
      heading('检索结果概览'),
      paragraph(caseReportOverview(rows)),
      new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [
        tableRow(['案号', '案例', '法院', '裁判日期', '来源与核验状态']),
        ...cases.map(({ caseNumber, title, court, judgmentDate, source, status }) => tableRow([
          caseNumber || '', title, court || '', judgmentDate || '', `${source} · ${status}`,
        ])),
      ] }),
      heading('逐案摘录'),
      ...cases.flatMap(({ title, details }) => [
        new Paragraph({ text: title, heading: HeadingLevel.HEADING_2 }),
        ...details.map(({ text, url }) => paragraph(url ? `${text}　${url}` : text)),
      ]),
      heading('核验声明'),
      paragraph(CASE_REPORT_DISCLAIMER),
    ] }],
  })
  const url = URL.createObjectURL(await Packer.toBlob(documentFile))
  const link = document.createElement('a')
  link.href = url
  link.download = '案例检索报告-' + (metadata.docTitle || metadata.caseName).replace(/[\\/:*?"<>|]/g, '_') + '.docx'
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
