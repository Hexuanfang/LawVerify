import type { KnowledgeCase, KnowledgeStatuteDocument } from '../domain.js'

export type LegalFinding = {
  from: number
  to: number
  text: string
  kind: 'statute' | 'case'
  status: 'repealed' | 'amended' | 'verified' | 'unverified' | 'invalid_format'
  message: string
  sourceUrl?: string
  checkedAt?: string
}

export function normalizeCaseNumber(value: string) {
  return value.replace(/[（〔【]/g, '(').replace(/[）〕】]/g, ')').replace(/\s/g, '')
}

export function isValidCaseNumber(value: string) {
  const normalized = normalizeCaseNumber(value)
  const year = Number(normalized.match(/^\((\d{4})\)/)?.[1])
  return year >= 1949 && year <= new Date().getFullYear() + 1
    && /^\(\d{4}\)[\u4e00-\u9fff]\d{0,4}[\u4e00-\u9fff]{1,8}[1-9]\d{0,9}号$/.test(normalized)
}

export function isOfficialCaseUrl(value?: string) {
  if (!value) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && (url.hostname === 'court.gov.cn' || url.hostname.endsWith('.court.gov.cn'))
      && url.pathname !== '/' && !/^\/(?:index(?:\.html?)?)?$/.test(url.pathname)
  } catch { return false }
}

function articleIndex(value: string): number {
  if (/^\d+$/.test(value)) return Number(value)
  const digits = '零一二三四五六七八九'
  let total = 0, section = 0, digit = 0
  for (const c of value.replace(/〇/g, '零').replace(/两/g, '二')) {
    const n = digits.indexOf(c)
    if (n >= 0) digit = n
    else {
      const unit = ({ 十: 10, 百: 100, 千: 1000, 万: 10000 } as Record<string, number>)[c]
      if (!unit) return NaN
      if (unit === 10000) { total += (section + digit) * unit; section = 0 }
      else section += (digit || 1) * unit
      digit = 0
    }
  }
  return total + section + digit
}

const normalizeTitle = (title: string) => {
  const normalized = title.replace(/[《》\s]/g, '')
    .replace(/^(依据|根据|依照|按照|参照|适用|违反|援引|依|按)+/u, '')
    .replace(/^中华人民共和国/, '')
  return ({ 民诉法: '民事诉讼法', 刑诉法: '刑事诉讼法', 证据规定: '最高人民法院关于民事诉讼证据的若干规定' } as Record<string, string>)[normalized] ?? normalized
}
export function extractStatuteCitations(text: string) {
  const citations: Array<{ title: string; number?: string; suffix?: string; from: number; raw: string }> = []
  // Include a bare law title: a repealed law is risky even without an article number.
  const pattern = /《([^》]{2,80})》(?:\s*第([0-9零〇一二三四五六七八九十百千万两]+)条(?:之([一二三四五六七八九十0-9]+))?)?|((?:中华人民共和国)?[\u4e00-\u9fff]{1,30}?(?:法|法典|条例|规定|解释))\s*第([0-9零〇一二三四五六七八九十百千万两]+)条/gu
  for (const match of text.matchAll(pattern)) {
    const title = match[1] ?? match[4]
    const number = match[2] ?? match[5]
    citations.push({ title, number, suffix: match[3], from: match.index!, raw: match[0] })
    if (!number) continue
    let offset = match.index! + match[0].length
    let following: RegExpMatchArray | null
    while ((following = text.slice(offset).match(/^\s*[、，及和]\s*(?:第)?([0-9零〇一二三四五六七八九十百千万两]+)条(?:之([一二三四五六七八九十0-9]+))?/u))) {
      citations.push({ title, number: following[1], suffix: following[2], from: offset, raw: following[0] })
      offset += following[0].length
    }
  }
  return citations
}
export function inspectLegalText(text: string, statutes: KnowledgeStatuteDocument[], cases: KnowledgeCase[]): LegalFinding[] {
  const findings: LegalFinding[] = []
  for (const citation of extractStatuteCitations(text)) {
    const { title, number } = citation
    const documents = statutes.filter(d => normalizeTitle(d.title) === normalizeTitle(title))
    if (!documents.length && !number && !/(法|法典|条例|规定|解释|办法|规则|决议|决定)$/.test(title)) continue
    // Multiple versions cannot establish which version the author intended.
    const document = documents.length === 1 ? documents[0] : undefined
    const article = number ? document?.articles.find(a => {
      const n = a.articleNumber.match(/第(.+?)条(?:之(.+))?/)
      return n && articleIndex(n[1]) === articleIndex(number) && (n[2] ?? '') === (citation.suffix ?? '')
    }) : undefined
    const readable = article && !/官方原文已定位|未直接返回结构化正文|待补充/.test(article.plainText || article.content)
    let status: LegalFinding['status'] = 'unverified'
    let message = documents.length > 1 ? '存在多个版本，未能核实适用版本。' : '未能核实：未找到可核对的条文及来源。'
    if (document?.effectiveStatus === 'repealed') { status = 'repealed'; message = '该法律版本已废止，请核对案件发生时间及适用依据。' }
    else if (document?.effectiveStatus === 'amended') { status = 'amended'; message = '该法律版本已修订，请核对引用内容及适用时间。' }
    else if (document?.sourceVerifiedAt && document.sourceUrl && (!number || readable)) {
      status = 'verified'; message = number ? '已定位条文及法源，请核对适用条件。' : '已定位法源。'
    }
    findings.push({ from: citation.from, to: citation.from + citation.raw.length, text: citation.raw, kind: 'statute',
      status, message, sourceUrl: document?.sourceUrl, checkedAt: document?.sourceVerifiedAt })
  }
  const casePattern = /[（(〔【]\s*\d{4}\s*[）)〕】]\s*[\u4e00-\u9fff]\s*\d{0,4}\s*[\u4e00-\u9fff]{1,8}\s*\d{1,10}\s*号/gu
  for (const match of text.matchAll(casePattern)) {
    const valid = isValidCaseNumber(match[0])
    const entry = cases.find(c => normalizeCaseNumber(c.caseNumber) === normalizeCaseNumber(match[0]))
    // An imported number or a portal homepage is not proof of an actual judgment.
    findings.push({ from: match.index!, to: match.index! + match[0].length, text: match[0], kind: 'case',
      status: valid ? 'unverified' : 'invalid_format',
      message: valid ? (entry ? '案号格式有效，已找到案例记录；真实性仍需核对原文。' : '案号格式有效，未能核实对应裁判文书。') : '案号格式异常，请核对原件。',
      sourceUrl: entry?.sourceUrl })
  }
  return findings.sort((a, b) => a.from - b.from)
}

export type CaseSearchOptions = { keyword?: string; courtName?: string; judgeName?: string; courtWeight?: number; judgeWeight?: number }
export function rankCases(items: KnowledgeCase[], options: CaseSearchOptions, semanticRanks?: ReadonlyMap<string, number>) {
  const terms = options.keyword?.trim().split(/\s+/).filter(Boolean) ?? []
  const clamp = (n: number | undefined) => Math.max(0, Math.min(5, Number.isFinite(n) ? n! : 2))
  return items.map(entry => {
    const content = [entry.title, entry.caseNumber, entry.courtName, entry.cause, entry.issueSummary,
      entry.holdingSummary, entry.reasoningSummary, ...entry.keywords, ...entry.focusTags].join(' ')
    const keywordRelevance = terms.length ? terms.filter(t => content.includes(t)).length / terms.length : 1
    const semanticRank = semanticRanks?.get(entry.id)
    const relevance = Math.max(keywordRelevance, semanticRank === undefined ? 0 : 1 / (semanticRank + 1))
    const courtMatched = !!options.courtName?.trim() && entry.courtName.includes(options.courtName.trim())
    const judgeMatched = !!options.judgeName?.trim() && (entry.judgeNames ?? []).includes(options.judgeName.trim())
    return { ...entry, searchScore: relevance + (courtMatched ? clamp(options.courtWeight) : 0)
      + (judgeMatched ? clamp(options.judgeWeight) : 0), searchMatches: { courtMatched, judgeMatched }, relevance }
  }).filter(e => e.relevance > 0).sort((a, b) => b.searchScore - a.searchScore || a.id.localeCompare(b.id))
    .map(({ relevance: _relevance, ...entry }) => entry)
}
