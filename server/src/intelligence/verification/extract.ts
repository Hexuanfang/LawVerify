import { getLinkageSentences, getSentenceLinkageGuard } from '../linkage-policy.js'
import { elementTypes, normalizeDocKey, profile, verificationChecks } from './profile.js'
import type { Declaration, DeclarationLocation, DocKey, ElementType, EvidenceCell, FactKind } from './protocol.js'

type ParagraphInput = { id: string; text: string; richText?: string; aiOrigin?: Declaration['aiOrigin']; evidenceCell?: EvidenceCell }
type ExtractionInput = { id: string; docKey?: string; title?: string; paragraphs: ParagraphInput[] }
type ModelCandidate = { paragraphId: string; type: ElementType; quote: string; start?: number; factKinds?: FactKind[] }

const lawCitation = /《[^》\n]+》\s*(?:第\s*[0-9０-９零〇一二两三四五六七八九十百千万]+\s*(?:条(?:\s*之\s*[0-9０-９零〇一二两三四五六七八九十百千万]+)?|[款项编章])\s*)+/gu
const caseCitation = /[（(]\d{4}[）)][^\s，。；：]{2,36}?\d+号/gu
const factSignals: Array<[FactKind, RegExp]> = [
  ['subject', /原告|被告|申请人|上诉人|公司|当事人/u],
  ['act', /签署|签字|签订|交付|收取|转账|通知|发送|支付|借款|还款|催告/u],
  ['time', /\d{4}[年./-]|当日|当天|次日|同日/u],
  ['place', /省|市|区|住所|住址|所在地/u],
  ['object', /合同|资金|款项|利息|材料|原件|货物|证据/u],
  ['result', /到账|收货|逾期|欠付|结清|损失|未付/u],
  ['cause', /因[^，。]{1,30}(?:致|导致)|系因|由于/u],
  ['intent', /明确表示|曾表示|知悉|承诺|故意/u],
  ['procedure', /申请|立案|送达|裁定|移送|受理/u],
]
const discardHeading = /^(?:[一二三四五六七八九十\d]+[、.．]\s*)?(?:诉讼请求|事实与理由|当事人信息|法律依据|证据清单|代理意见|争议焦点|证明目的|证据名称)[：:。]?$/u
const bareLegalOpinion = /^(?:(?:我方|原告|被告|对方|上诉人|被上诉人)(?:的(?:该|上述)?行为)?\s*|(?:该|上述)行为)?(?:(?:已|明显|显然)*(?:构成|属于)(?:欺诈|诈骗|违约|侵权|犯罪)|(?:我认为|我觉得)[^，,。；;]+)[。！？!?]?$/u
const factActions = factSignals.filter(([kind]) => kind === 'act' || kind === 'result')
const explicitFactSubject = /^(?:原告|被告|对方|甲方|乙方|申请人|上诉人|被上诉人|答辩人)/u
const splitJoiner = /^[\s，、,。.;；！？!?：:及并且和与]*$/u
const directRequest = /^(?:现|故|据此|因此)?\s*(?:请求|诉请|恳请|判令|应判决|改判|发回重审)/u
const letterDemand = /^(?:请在收到本函|请(?:贵方|贵司|阁下)|现敦促|特此催告)/u
const startsWithRequest = (text: string, docKey?: DocKey) => directRequest.test(text) || (docKey === 'lsh' && letterDemand.test(text))

export function parseModelDeclarationCandidates(paragraph: ParagraphInput, input: unknown): ModelCandidate[] | undefined {
  if (!Array.isArray(input)) return undefined
  const sentences = getLinkageSentences(paragraph.text)
  let cursor = 0
  const starts = sentences.map(({ sentenceText }) => {
    const start = paragraph.text.indexOf(sentenceText, cursor)
    if (start >= 0) cursor = start + sentenceText.length
    return start
  })
  const result = input.flatMap(entry => {
    if (!entry || typeof entry !== 'object') return []
    const { sentenceIndex, type: rawType, quote: rawQuote, nature, factKinds: rawKinds } = entry as Record<string, unknown>
    const type = elementTypes.find(candidate => candidate === rawType)
    if (typeof sentenceIndex !== 'number' || !Number.isInteger(sentenceIndex) || !type
      || typeof rawQuote !== 'string' || (type === 'E-FACT' && nature !== 'fact')) return []
    const sentence = sentences[sentenceIndex]
    if (!sentence || starts[sentenceIndex] < 0 || getSentenceLinkageGuard(sentence.sentenceText).kind === 'heading') return []
    const quote = rawQuote.trim()
    const offset = sentence.sentenceText.indexOf(quote)
    if (!quote || offset < 0 || sentence.sentenceText.indexOf(quote, offset + 1) >= 0) return []
    if ((type === 'E-LAW' && ![...quote.matchAll(lawCitation)].some(match => match[0].trim() === quote))
      || (type === 'E-CASE' && ![...quote.matchAll(caseCitation)].some(match => match[0] === quote))) return []
    const factKinds = type === 'E-FACT' && Array.isArray(rawKinds)
      ? factSignals.map(([kind]) => kind).filter(kind => rawKinds.includes(kind)) : undefined
    return [{ paragraphId: paragraph.id, type, quote, start: starts[sentenceIndex] + offset, factKinds }]
  })
  return input.length && !result.length ? undefined : result
}

const plainCell = (cell: string) => cell.replace(/<[^>]+>/gu, '').replace(/&(nbsp|amp|lt|gt|quot);/gu, (_, key: string) =>
  ({ nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"' })[key] ?? '').trim()

function evidenceRows(paragraph: ParagraphInput) {
  const rows: { quote: string; start: number; type: ElementType; row: number; column?: number }[] = []
  const cell = paragraph.evidenceCell
  if (cell) {
    const quote = paragraph.text.trim()
    if (quote && (cell.role === 'evidence' || cell.role === 'purpose')) rows.push({
      quote, start: paragraph.text.indexOf(quote), type: cell.role === 'evidence' ? 'E-EVID' : 'E-PURP', row: cell.row, column: cell.column,
    })
    return rows
  }
  const tables = [...(paragraph.richText ?? '').matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/giu)]
  if (tables.length === 1) {
    let cursor = 0
    let titleColumn = -1
    let purposeColumn = -1
    const rowsHtml = [...tables[0][1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/giu)]
    const hasSpans = /\b(?:rowspan|colspan)\s*=/iu.test(tables[0][1])
    for (const [rowIndex, row] of rowsHtml.entries()) {
      const cells = [...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/giu)].map(item => plainCell(item[1]))
      const allCells = cells.map((quote, index) => {
        const start = paragraph.text.indexOf(quote, cursor)
        if (start >= 0) cursor = start + quote.length
        return { quote, start, column: index + 1 }
      })
      const namedTitle = cells.findIndex(cell => /^(?:证据(?:名称|材料)?|材料名称)$/u.test(cell))
      const namedPurpose = cells.findIndex(cell => /^(?:证明目的|拟证明事实|证明内容)$/u.test(cell))
      if (namedTitle >= 0 || namedPurpose >= 0) {
        titleColumn = namedTitle
        purposeColumn = namedPurpose
        continue
      }
      for (const [index, type] of [[titleColumn, 'E-EVID'], [purposeColumn, 'E-PURP']] as const) {
        const cell = allCells[index]
        if (cell?.quote && cell.start >= 0) rows.push({ ...cell, column: hasSpans ? undefined : cell.column, type, row: rowIndex + 1 })
      }
    }
    if (rows.length) return rows
  }
  for (const [lineIndex, match] of [...paragraph.text.matchAll(/[^\r\n]+/gu)].entries()) {
    const line = match[0]
    if (!line.trim() || /^(?:证据名称|材料名称)\s/u.test(line)) continue
    const purposeStart = line.search(/\t|[；;]\s*(?:证明|拟证)|证明目的[：:]|(?<=(?:截图|录音|视频|流水|借条|凭证))证明(?=对方|原告|被告|借贷|款项)/u)
    const name = (purposeStart < 0 ? line : line.slice(0, purposeStart)).trim()
    if (name && !discardHeading.test(name)) rows.push({ type: 'E-EVID', quote: name, start: match.index + line.indexOf(name), row: lineIndex + 1 })
    if (purposeStart >= 0) {
      const purpose = line.slice(purposeStart).replace(/^[\t；;\s]+|^证明目的[：:]\s*/gu, '').trim()
      if (purpose) rows.push({ type: 'E-PURP', quote: purpose, start: match.index + line.indexOf(purpose, purposeStart), row: lineIndex + 1 })
    }
  }
  return rows
}

function sentenceTypes(text: string, docKey?: DocKey): ElementType[] {
  if (discardHeading.test(text) || /^[\d\s—_\-“”‘’「」『』"']+$/u.test(text)) return []
  const types: ElementType[] = []
  if (/^(?:原告|被告|第三人|上诉人|被上诉人|申请人|被申请人|委托人|法定代表人|姓名|住址|住所)[：:（(]/u.test(text)) return ['E-SUBJ']
  if (/(?:请求|诉请|恳请|判令|应判决|改判|发回重审)/u.test(text) || startsWithRequest(text, docKey)) types.push('E-CLAIM')
  if (/(?:[×÷*=]|算式|基数|按[^。；]{0,20}(?:利率|%|％)|每吨|每月|每日|计至).*(?:元|%|％|天|计算)|(?:\d[\d,.]*\s*(?:万元|元)).*(?:利息|年利率|计算|违约金)|(?:尚欠|剩余货款)\s*\d[\d,.，]*\s*(?:万)?元/u.test(text)) types.push('E-CALC')
  if (/(?:原审|一审|二审|前审|原判).*(?:认定|判项|错误|不当|未查明|驳回)/u.test(text)) types.push('E-ERR')
  if (/(?:管辖|期间|保全|移送|期限|送达|再审要件)/u.test(text)) types.push('E-PROC')
  if (/(?:争议焦点|争点|争议集中|关键问题)/u.test(text)) types.push('E-FOCUS')
  if (/(?:质证|不予认可|(?:对方|原告|被告|上诉人|被上诉人)主张|真实性|关联性|合法性|不予采信)/u.test(text)
    || (docKey === 'zz' && /^对(?:方)?证据\s*[\d一二三四五六七八九十]/u.test(text))) types.push('E-CROSS')
  if (docKey === 'zz' && /证据|流水|截图|借条|凭证/u.test(text)) types.push('E-EVID')
  if (!types.includes('E-ERR') && !startsWithRequest(text, docKey) && !bareLegalOpinion.test(text) && (factSignals.some(([key, pattern]) => ['act', 'result', 'intent', 'cause'].includes(key) && pattern.test(text)) || (!types.length && !getSentenceLinkageGuard(text).skip))) types.push('E-FACT')
  return types
}

export function extractDeclarations(document: ExtractionInput, model: ModelCandidate[] = []) {
  const docKey = normalizeDocKey(document.docKey)
  const declarations: Declaration[] = []
  const offCandidates: Declaration[] = []
  const occupied = new Set<string>()
  const superseded = new Set<string>()
  const modelByParagraph = new Map<string, ModelCandidate[]>()
  for (const item of model) {
    const list = modelByParagraph.get(item.paragraphId)
    if (list) list.push(item)
    else modelByParagraph.set(item.paragraphId, [item])
  }
  for (const [paragraphIndex, paragraph] of document.paragraphs.entries()) {
    const paragraphDeclarations: Declaration[] = []
    const add = (type: ElementType, quote: string, start: number, extra: Partial<DeclarationLocation> = {}, modelFactKinds: FactKind[] = []) => {
      if (!elementTypes.includes(type) || start < 0 || !quote.trim() || paragraph.text.slice(start, start + quote.length) !== quote) return
      const id = `${document.id}:${paragraph.id}:${start}:${start + quote.length}:${type}`
      if (occupied.has(id)) return
      occupied.add(id)
      const target = docKey && profile.profiles[docKey].elements[type].level === 'off' ? offCandidates : declarations
      const reason = '已定位原文，待判定。'
      const declaration: Declaration = { id, type, quote, location: { paragraphId: paragraph.id, paragraphIndex, start, end: start + quote.length, ...extra },
        ...(type === 'E-FACT' ? { factKinds: factSignals.filter(([kind, pattern]) => pattern.test(quote) || modelFactKinds.includes(kind)).map(([kind]) => kind) } : {}),
        aiOrigin: paragraph.aiOrigin, verdict: 'pending', reason, conf: null, sources: [],
        checks: Object.fromEntries(verificationChecks(docKey, type).map(code => [code, { outcome: 'pending', reason }])),
      }
      target.push(declaration)
      paragraphDeclarations.push(declaration)
    }
    let cursor = 0
    const sentenceRanges: Array<{ start: number; end: number; sentenceIndex: number }> = []
    const emit = (text: string, start: number, sentenceIndex: number, suffix = false) => {
      const types = sentenceTypes(text, docKey)
      const split = types.includes('E-FACT') && types.includes('E-CALC') && [...text.matchAll(/[，,]\s*(?=(?:利息|违约金|损失|金额|计算|以|按|每月|每日))/gu)]
        .find(separator => factActions.some(([, pattern]) => pattern.test(text.slice(0, separator.index)))
          && sentenceTypes(text.slice(separator.index + separator[0].length), docKey).includes('E-CALC'))
      const opinion = [...text.matchAll(/[，,]\s*/gu)].find(separator => bareLegalOpinion.test(text.slice(separator.index + separator[0].length)))
      for (const type of types) {
        if (suffix && type !== 'E-CLAIM' && type !== 'E-CALC'
          && (type !== 'E-FACT' || !explicitFactSubject.test(text) || !factActions.some(([, pattern]) => pattern.test(text)))) continue
        if (split && type === 'E-FACT') add(type, text.slice(0, split.index).trimEnd(), start, { sentenceIndex })
        else if (split && type === 'E-CALC') {
          const offset = split.index + split[0].length
          add(type, text.slice(offset), start + offset, { sentenceIndex })
        } else if (opinion && type === 'E-FACT') {
          const fact = text.slice(0, opinion.index).trimEnd()
          if (factActions.some(([, pattern]) => pattern.test(fact))) add(type, fact, start, { sentenceIndex })
        } else add(type, text, start, { sentenceIndex })
      }
    }
    for (const { sentenceText, sentenceIndex } of getLinkageSentences(paragraph.text)) {
      const start = paragraph.text.indexOf(sentenceText, cursor)
      if (start < 0) continue
      cursor = start + sentenceText.length
      sentenceRanges.push({ start, end: cursor, sentenceIndex })
      const spans = [...sentenceText.matchAll(lawCitation)]
      const cases = [...sentenceText.matchAll(caseCitation)]
      for (const match of spans) add('E-LAW', match[0].trimEnd(), start + match.index, { sentenceIndex })
      for (const match of cases) add('E-CASE', match[0], start + match.index, { sentenceIndex })
      if (docKey === 'zj') continue
      if (!spans.length && !cases.length) emit(sentenceText, start, sentenceIndex)
      else {
        const first = Math.min(spans[0]?.index ?? Infinity, cases[0]?.index ?? Infinity)
        const before = sentenceText.slice(0, first).replace(/(?:依据|根据|参照|援引|适用)\s*$/u, '').replace(/[\s，、；：:,]+$/gu, '')
        if (before) emit(before, start, sentenceIndex)
        const end = Math.max(...[...spans, ...cases].map(match => match.index + match[0].length))
        const leading = /^[\s，、；：:,]*/u.exec(sentenceText.slice(end))?.[0].length ?? 0
        const tail = sentenceText.slice(end + leading)
        if (startsWithRequest(tail, docKey) || /^(?:利息|违约金)/u.test(tail) || (leading > 0 && explicitFactSubject.test(tail)))
          emit(tail, start + end + leading, sentenceIndex, true)
      }
    }
    if (docKey === 'zj') for (const { type, quote, start, row, column } of evidenceRows(paragraph)) add(type, quote, start, { row, column })
    const candidates = (modelByParagraph.get(paragraph.id) ?? []).flatMap(item => {
      if (!item.quote?.trim() || (item.type === 'E-FACT' && (bareLegalOpinion.test(item.quote.trim()) || startsWithRequest(item.quote.trim(), docKey)))) return []
      if (docKey === 'zj' && (item.type === 'E-EVID' || item.type === 'E-PURP')) return []
      const start = item.start ?? paragraph.text.indexOf(item.quote)
      if (start < 0 || (item.start === undefined && paragraph.text.indexOf(item.quote, start + 1) >= 0)) return []
      const end = start + item.quote.length
      const range = sentenceRanges.find(sentence => start >= sentence.start && end <= sentence.end)
      return range && paragraph.text.slice(start, end) === item.quote ? [{ ...item, start, end, sentenceIndex: range.sentenceIndex }] : []
    })
    for (const existing of paragraphDeclarations) {
      const { start, end } = existing.location
      const inside = candidates.filter(item => item.type === existing.type && item.start >= start && item.end <= end
        && (item.start !== start || item.end !== end))
      const pieces = [...new Map(inside.map(item => [`${item.start}:${item.end}`, item])).values()].sort((left, right) => left.start - right.start)
      if (pieces.length < 2) continue
      let edge = start
      const covers = pieces.every(piece => {
        if (piece.start < edge || !splitJoiner.test(paragraph.text.slice(edge, piece.start))) return false
        edge = piece.end
        return true
      })
      if (covers && splitJoiner.test(paragraph.text.slice(edge, end))) superseded.add(existing.id)
    }
    for (const item of candidates) {
      const { start, end, sentenceIndex } = item
      const overlapping = paragraphDeclarations.find(existing => !superseded.has(existing.id) && existing.type === item.type
        && ((existing.location.start <= start && end <= existing.location.end) || (start <= existing.location.start && existing.location.end <= end)))
      if (overlapping) {
        if (item.factKinds && overlapping.location.start === start && overlapping.location.end === end) {
          overlapping.factKinds = [...new Set([...(overlapping.factKinds ?? []), ...item.factKinds])]
        }
        continue
      }
      add(item.type, item.quote, start, { sentenceIndex }, item.factKinds)
    }
  }
  const identity = docKey ? profile.profiles[docKey].identityElements : []
  declarations.sort((left, right) => Number(!identity.includes(left.type)) - Number(!identity.includes(right.type))
    || left.location.paragraphIndex - right.location.paragraphIndex || left.location.start - right.location.start)
  return { docKey, classificationRequired: !docKey, declarations: declarations.filter(item => !superseded.has(item.id)),
    offCandidates: offCandidates.filter(item => !superseded.has(item.id)) }
}
