import type { CertificateExportContext } from './export-context'

/* ------------------------------------------------------------------ */
/* 声明文案                                                             */
/* ------------------------------------------------------------------ */

/** 附录名称 */
export const CATALOG_TITLE = '附录一　证据编号对照表'
export const VERIFICATION_TITLE = '附录二　段落核验记录'
export const DECLARATION_TITLE = '附录三　AI 辅助与人工核验声明'

/**
 * 声明正文。
 * 待法务确认：以下文案为实施者起草，未经法务审阅，投产前需替换为律所正式版本。
 */
export const DECLARATION_BODY: string[] = [
  '本文件由 LawVerify 案件核验工作台辅助生成。系统对证据材料进行内容理解、句级关联与引用定位，'
  + '并据此生成本文件的正文草稿与批注内容。',
  '系统输出的材料关联、引用定位与核验提示，仅为办案线索与检索结果，不构成对事实的认定，'
  + '亦不代表相应材料具有证明力。',
  '本文件正文、批注与所附核验记录，均须由承办律师逐句核对原始材料后使用；'
  + '未经核对的内容不得作为提交法院或对方的最终意见。',
]

/** 免责句。待法务确认。 */
export const DECLARATION_DISCLAIMER = '材料关联仅表示内容相关性，不代表证明力成立；本文件由承办律师逐句核验后使用。'

/** 证据类型中文名 */
const EVIDENCE_TYPE_LABELS: Record<string, string> = {
  pdf: 'PDF',
  ppt: '演示文稿',
  image: '图片',
  word: 'Word',
  text: '文本',
  other: '其他',
}

/* ------------------------------------------------------------------ */
/* 数据结构                                                             */
/* ------------------------------------------------------------------ */

export interface EvidenceCatalogRow {
  /** 序号 */
  index: number
  /** 文书引用编号（证据N） */
  sourceNumber: string
  /** 目录编号（E0x） */
  number: string
  /** 材料名称 */
  name: string
  /** 材料类型 */
  type: string
  /** 页数 */
  pages: number | null
  /** 本文书引用情况 */
  usage: string
}

export interface VerificationRecordRow {
  /** 段号 */
  index: number
  /** 段落首句（截断） */
  firstSentence: string
  /** 句数 */
  sentenceCount: number
  /** 核验状态 */
  status: '已核验' | '未核验'
  /** 已挂证据数 */
  linkedEvidenceCount: number
  /** 法条引用数 */
  statuteCount: number
  /** 案例引用数 */
  caseCount: number
  /** 批注摘要 */
  commentSummary: string
}

export interface DeclarationStats {
  /** 段落总数 */
  totalParagraphs: number
  /** 已核验段落数 */
  verifiedParagraphs: number
  /** 已挂证据的句数 */
  linkedSentenceCount: number
  /** 未核验段落的段号清单 */
  unverifiedParagraphIndexes: number[]
}

export interface DeclarationData {
  title: string
  body: string[]
  fields: Array<{ label: string; value: string }>
  stats: DeclarationStats
  disclaimer: string
}

/* ------------------------------------------------------------------ */
/* 工具                                                                 */
/* ------------------------------------------------------------------ */

/** 与服务端 getLinkageSentences 同一口径的句子切分 */
export function splitSentences(text: string): string[] {
  return Array.from(text.replace(/\r/g, '').matchAll(/[^。！？!?；;\n]+[。！？!?；;]?/gu))
    .map(match => match[0].trim())
    .filter(Boolean)
}

function truncate(text: string, limit: number) {
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized.length > limit ? `${normalized.slice(0, limit)}…` : normalized
}

function formatDateTime(date: Date) {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function evidenceTypeLabel(type: string) {
  return EVIDENCE_TYPE_LABELS[type] ?? type ?? '其他'
}

/* ------------------------------------------------------------------ */
/* 附录一：证据编号对照表                                               */
/* ------------------------------------------------------------------ */

/**
 * 编号对照表：把「目录编号（E0x）」与「文书引用编号（证据N）」并列，
 * 供承办律师核对文书里写的「证据N」到底是哪一份材料。
 */
export function buildEvidenceCatalogRows(context: CertificateExportContext): EvidenceCatalogRow[] {
  const paragraphs = context.certificate?.paragraphs ?? []
  // 统计每份材料被哪些段落引用
  const usageByEvidence = new Map<string, Set<number>>()
  paragraphs.forEach((paragraph, paragraphIndex) => {
    const paragraphNumber = paragraphIndex + 1
    const links = [...(paragraph.links ?? []), ...(paragraph.link ? [paragraph.link] : [])]
    for (const link of links) {
      if (!link?.evidenceId) continue
      const set = usageByEvidence.get(link.evidenceId) ?? new Set<number>()
      set.add(paragraphNumber)
      usageByEvidence.set(link.evidenceId, set)
    }
  })

  return (context.evidences ?? []).map((evidence, index) => {
    const used = [...(usageByEvidence.get(evidence.id) ?? [])].sort((left, right) => left - right)
    return {
      index: index + 1,
      // 引用编号缺失时不臆造：只按材料自身信息标注为未指定。
      sourceNumber: evidence.sourceNumber?.trim() || '未指定（按路径推断）',
      number: evidence.number ?? '',
      name: evidence.name || evidence.fileName || '未命名材料',
      type: evidenceTypeLabel(evidence.type),
      pages: typeof evidence.pages === 'number' && evidence.pages > 0 ? evidence.pages : null,
      usage: used.length ? `第 ${used.join('、')} 段引用` : '未引用',
    }
  })
}

/* ------------------------------------------------------------------ */
/* 附录二：段落核验记录                                                 */
/* ------------------------------------------------------------------ */

export function buildVerificationRecordRows(context: CertificateExportContext): VerificationRecordRow[] {
  const paragraphs = context.certificate?.paragraphs ?? []
  return paragraphs.map((paragraph, index) => {
    const links = [...(paragraph.links ?? []), ...(paragraph.link ? [paragraph.link] : [])]
    const references = paragraph.references ?? []
    const sentences = splitSentences(paragraph.text ?? '')
    return {
      index: index + 1,
      firstSentence: truncate(sentences[0] ?? paragraph.text ?? '', 40),
      sentenceCount: sentences.length,
      status: paragraph.verified ? '已核验' : '未核验',
      linkedEvidenceCount: new Set(links.map(link => link?.evidenceId).filter(Boolean)).size,
      statuteCount: references.filter(reference => reference.type === 'statute').length,
      caseCount: references.filter(reference => reference.type === 'case').length,
      commentSummary: paragraph.note?.trim() ? truncate(paragraph.note, 40) : '—',
    }
  })
}

/* ------------------------------------------------------------------ */
/* 附录三：AI 辅助与人工核验声明                                         */
/* ------------------------------------------------------------------ */

export function buildDeclarationData(context: CertificateExportContext): DeclarationData {
  const paragraphs = context.certificate?.paragraphs ?? []
  const linkedSentences = new Set<string>()
  paragraphs.forEach((paragraph) => {
    const links = [...(paragraph.links ?? []), ...(paragraph.link ? [paragraph.link] : [])]
    for (const link of links) {
      if (typeof link?.sentenceIndex === 'number') {
        linkedSentences.add(`${paragraph.id}:${link.sentenceIndex}`)
      }
    }
  })

  const unverifiedParagraphIndexes = paragraphs
    .map((paragraph, index) => (paragraph.verified ? -1 : index + 1))
    .filter(index => index > 0)

  return {
    title: DECLARATION_TITLE,
    body: DECLARATION_BODY,
    fields: [
      { label: '案件名称', value: context.caseFolder?.name || '未命名案件' },
      { label: '文书名称', value: context.certificate?.title || '未命名文书' },
      { label: '代理角色', value: context.roleLabel || '未标注' },
      { label: '导出时间', value: formatDateTime(context.exportedAt ?? new Date()) },
      { label: '导出人', value: context.operator?.trim() || '未记录' },
      { label: '软件版本', value: context.appVersion || '未记录' },
    ],
    stats: {
      totalParagraphs: paragraphs.length,
      verifiedParagraphs: paragraphs.filter(paragraph => paragraph.verified).length,
      linkedSentenceCount: linkedSentences.size,
      unverifiedParagraphIndexes,
    },
    disclaimer: DECLARATION_DISCLAIMER,
  }
}

/* ------------------------------------------------------------------ */
/* 段落批注                                                             */
/* ------------------------------------------------------------------ */

/**
 * 段落批注文本：把段落已有的核验批注、定位与绑定证据编号合并成一条。
 * 没有批注也照样给出定位与证据编号，让核验痕迹不依赖人工填写批注。
 */
export function buildParagraphComment(
  context: CertificateExportContext,
  paragraphIndex: number,
): string {
  const paragraph = context.certificate?.paragraphs?.[paragraphIndex]
  if (!paragraph) {
    return ''
  }

  const parts: string[] = []
  const note = paragraph.note?.replace(/\r\n|\r|\n/g, ' ').trim()
  if (note) {
    parts.push(note)
  }

  const links = [...(paragraph.links ?? []), ...(paragraph.link ? [paragraph.link] : [])]
  const evidenceLabels = new Set<string>()
  for (const link of links) {
    if (!link?.evidenceId) continue
    const evidence = (context.evidences ?? []).find(item => item.id === link.evidenceId)
    const number = evidence?.number ?? link.evidenceId
    const locator = link.locator?.trim()
    evidenceLabels.add(locator ? `${number}（${locator}）` : number)
  }
  if (evidenceLabels.size) {
    parts.push(`绑定证据：${[...evidenceLabels].join('、')}`)
  }

  const references = paragraph.references ?? []
  const statuteLabels = references.filter(reference => reference.type === 'statute').map(reference => reference.label || reference.sourceTitle)
  const caseLabels = references.filter(reference => reference.type === 'case').map(reference => reference.label || reference.sourceTitle)
  if (statuteLabels.length) {
    parts.push(`法条引用：${statuteLabels.join('、')}`)
  }
  if (caseLabels.length) {
    parts.push(`案例引用：${caseLabels.join('、')}`)
  }

  parts.push(`核验状态：${paragraph.verified ? '已核验' : '未核验'}`)
  return parts.join('；')
}
