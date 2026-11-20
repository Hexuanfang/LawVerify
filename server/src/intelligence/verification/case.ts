import type { CertificateParagraph } from '../../domain.js'
import { matchesCaseExcerpt, type CaseDetail, type CaseDetailResult, type CaseLevel, type createLegalCaseAdapter } from '../../integrations/legal-case.js'
import { articleIndex, extractStatuteCitations, hasCaseNumberFormat, normalizeCaseNumber } from '../legal-verification.js'
import type { CaseVerification, CheckCode, CheckOutcome, Declaration, DeclarationSource } from './protocol.js'
import { assessCaseContext, caseText } from './case-context.js'
import { calendarDay } from './statute-effect.js'

type CaseAdapter = ReturnType<typeof createLegalCaseAdapter>
type CaseLookup = { queryOutcome: string; result: CaseDetailResult; alternatives?: CaseVerification['documents'] }
type CaseCertificate = { docKey?: string; paragraphs: Array<Pick<CertificateParagraph, 'id' | 'text'>> }
type Found = Extract<CaseDetailResult, { outcome: 'found' }>

const failureOutcomes = new Set(['timeout', 'forbidden', 'unavailable', 'empty-response', 'conflicting-detail'])
const levels: CaseLevel[] = ['ordinary', 'high-court-reference', 'gazette', 'guiding']
const levelNames: Record<string, CaseLevel> = { 普通案例: 'ordinary', 高院参考: 'high-court-reference', 高院参考案例: 'high-court-reference',
  公报案例: 'gazette', 指导性案例: 'guiding', 指导案例: 'guiding' }
const levelPattern = /指导性案例|指导案例|公报案例|高院参考案例|高院参考|普通案例/u

function documentLink(result: Found) {
  return { id: result.item.id, caseNumber: result.item.case_number, provider: result.provider, url: result.item.url }
}

async function findCase(adapter: CaseAdapter, number: string, signal?: AbortSignal): Promise<CaseLookup> {
  const search = await adapter.search({ action: 'keyword', case_number: number }, signal)
  const queryOutcome = search.outcome
  if (search.outcome === 'timeout' || search.outcome === 'forbidden' || search.outcome === 'unavailable') {
    return { queryOutcome, result: { outcome: search.outcome, provider: search.provider, checkedAt: new Date().toISOString() } }
  }
  const ids = [...new Set(search.items.filter(item => normalizeCaseNumber(item.case_number) === normalizeCaseNumber(number)).map(item => item.id))]
  const results = await Promise.all(ids.map(id => adapter.detail({ case_number: number, id }, signal)))
  const found = results.filter((result): result is Found => result.outcome === 'found')
  if (found.length) {
    const first = found.find(result => result.item.effect !== 'unknown' && result.item.name && result.item.court && calendarDay(result.item.judgment_date) !== undefined) ?? found[0]
    if (found.some(({ item }) => (item.court && first.item.court && caseText(item.court) !== caseText(first.item.court))
      || (item.judgment_date && first.item.judgment_date && calendarDay(item.judgment_date) !== calendarDay(first.item.judgment_date)))
      || new Set(found.map(result => result.item.effect).filter(effect => effect !== 'unknown')).size > 1) {
      return { queryOutcome, result: { provider: first.provider, checkedAt: first.checkedAt, outcome: 'conflicting-detail' } }
    }
    return { queryOutcome, result: first, alternatives: found.map(documentLink) }
  }
  const indexed = results[0]
  // 索引 ID 过期时，以原案号查详情后才确认权威查无。
  const result = !indexed || indexed.outcome === 'authoritative-not-found'
    ? await adapter.detail({ case_number: number }, signal) : indexed
  return { queryOutcome, result }
}

function adjacentText(paragraph: string, start: number, end: number) {
  const prefix = paragraph.slice(0, start).split(/[。；！？\n]/u).at(-1) ?? ''
  const rest = paragraph.slice(end)
  const closing: Record<string, string> = { '“': '”', '‘': '’', '「': '」', '"': '"' }
  let quoteEnd: string | undefined
  let index = 0
  for (; index < rest.length; index++) {
    const character = rest[index]
    if (quoteEnd) {
      if (character === quoteEnd) quoteEnd = undefined
      continue
    }
    if (/[。；！？\n]/u.test(character) || (/[（(]/u.test(character) && /^[（(]\s*\d{4}[）)]/u.test(rest.slice(index)))) break
    quoteEnd = closing[character]
  }
  const tail = rest.slice(0, index)
  const phrase = tail.replace(/[“‘「"][^”’」"]+[”’」"]/gu, '')
  return { prefix, tail, phrase }
}

function claimedDetails(prefix: string, phrase: string) {
  return {
    name: prefix.match(/《([^》]+)》\s*$/u)?.[1] ?? phrase.match(/(?:案件名称|案名)\s*[:：]\s*([^，,；。]+)/u)?.[1],
    court: prefix.match(/([\p{Script=Han}]{2,30}人民法院)\s*$/u)?.[1]?.replace(/^(?:据|参照|参考|援引|见)+/u, '')
      ?? phrase.match(/(?:裁判法院|法院)\s*[:：]\s*([^，,；。]+)/u)?.[1],
    date: phrase.match(/(?:裁判日期|判决日期|裁定日期)\s*[:：]\s*(\d{4}[年./-]\d{1,2}[月./-]\d{1,2}日?)/u)?.[1],
    level: levelPattern.exec(`${prefix}${phrase}`)?.[0],
  }
}

function operativeDirection(text: string) {
  const rejecting = /驳回(?:上诉|诉讼请求|原告[^，。；]{0,15}请求)|不予支持/u.test(text)
  const supporting = /(?<!不予)(?<!不)支持(?:上诉|诉讼请求|原告[^，。；]{0,15}请求)|判令[^，。；]{0,30}(?:支付|返还|赔偿)|撤销原判/u.test(text)
  const liability = [...new Set([...text.matchAll(/(不|无需)?承担(连带|补充)(?:赔偿)?责任/gu)].map(item => `${item[1] ? '不' : ''}${item[2]}`))]
  return { direction: rejecting === supporting ? undefined : rejecting ? 'reject' : 'support',
    liability: liability.length === 1 ? liability[0] : undefined }
}

function caseCitation(tail: string, phrase: string, detail: CaseDetail) {
  const quotes = [...tail.matchAll(/[“‘「"]([^”’」"]+)[”’」"]/gu)]
  const first = quotes[0]
  const marker = first ? tail.slice(0, first.index) : phrase
  const operativeMarker = /判项|判决原文|裁定原文|判决如下|裁定如下|^[\s，：:]*(?:判决|裁定)(?!认定|认为)|判令/u
  const operative = operativeMarker.test(marker)
  const secondary = /转引自|转引|二手/u.test(phrase)
  const summary = /要旨|归纳/u.test(marker)
  const kind: CaseVerification['citationKind'] = secondary ? 'secondary' : operative ? 'operative' : summary ? 'summary' : 'reasoning'
  const passages = detail.passages.filter(item => operative ? item.kind === 'operative' : item.kind === 'reasoning')
  if (secondary) return { kind, outcome: 'pending' as const, reason: '二手转引仅作线索，需核对所引原文。' }
  let passage = passages[0]
  let priorEnd = 0
  for (const [index, quote] of quotes.entries()) {
    const localMarker = tail.slice(priorEnd, quote.index)
    const expected = operativeMarker.test(localMarker) ? 'operative'
      : /本院认为|裁判理由/u.test(localMarker) ? 'reasoning' : operative ? 'operative' : 'reasoning'
    const candidates = detail.passages.filter(item => item.kind === expected)
    const matched = candidates.find(item => matchesCaseExcerpt(item.text, quote[1]))
    if (!matched) return { kind, outcome: 'fail' as const, reason: '引号内内容未在对应裁判原文找到，不能用理由或摘要冒充判项。',
      quote: quote[1], source: candidates[0]?.text }
    if (!index) passage = matched
    priorEnd = quote.index + quote[0].length
  }
  if (operative || summary) {
    const current = operativeDirection(phrase)
    const original = operativeDirection(detail.operativeText)
    if ((current.direction && original.direction && current.direction !== original.direction)
      || (current.liability && original.liability && current.liability !== original.liability)) {
      return { kind, outcome: 'fail' as const, reason: '正文所述判项方向或责任性质与裁判原文相反。', quote: phrase, source: detail.operativeText }
    }
  }
  if (operative && !passage) return { kind, outcome: 'miss' as const, reason: '裁判详情中未定位到判项原文。' }
  if (operative && !first) {
    return { kind, outcome: 'pending' as const, reason: '判项转述需与对应原文逐项核对。', passage }
  }
  if (summary && !first) {
    const note = phrase.replace(/^[\s，,：:]*(?:裁判)?要旨(?:归纳)?[\s：:，,]*/u, '')
    const exact = detail.passages.find(item => matchesCaseExcerpt(item.text, note))
    return exact ? { kind, outcome: 'warn' as const, reason: '要旨归纳可回查原文，仍需复核表述。', passage: exact }
      : { kind, outcome: 'pending' as const, reason: '要旨归纳尚未核对到对应原文。', passage }
  }
  if (first && tail.slice(priorEnd).replace(/^[\s，,、：:]+/u, '').trim()) {
    return { kind, outcome: 'pending' as const, reason: '引文后仍有未核对的裁判转述。', passage }
  }
  const statement = phrase.trim().replace(/^[，,、：:\s]+/u, '')
    .replace(/^(?:(?:民事|刑事|行政)?(?:判决|裁定)|本院)(?:认定|认为)[，,：:\s]+/u, '')
  if (!first && statement && !/^(?:案名|案件名称|法院|裁判法院|裁判日期|判决日期|裁定日期)\s*[:：]/u.test(statement)) {
    const exact = passages.find(item => matchesCaseExcerpt(item.text, statement))
    if (!exact) return { kind, outcome: 'pending' as const, reason: '正文转述的裁判观点仍需与详情原文核对。', passage }
    return { kind, outcome: 'pass' as const, reason: '已核对详情所载的裁判原文。', passage: exact }
  }
  return { kind, outcome: 'pass' as const, reason: '已核对详情所载的裁判原文。', passage: passage ?? detail.passages[0], quote: first?.[1] }
}

function statuteKeys(text: string) {
  return extractStatuteCitations(text).filter(item => item.number).map(item =>
    `${item.title.replace(/^中华人民共和国/u, '')}:${articleIndex(item.number!)}:${item.suffix ? articleIndex(item.suffix) : ''}`)
}

function reviewedRelations(item: CaseDetail): CaseVerification['relatedCases'] {
  const prior = item.related_cases.filter(related => related.relation === 'prior')
  const removal = /(?:^|[。；\n、])\s*撤销(?:原审判决|原判(?:决)?)(?=[，。；\s]|$)/u.test(item.operativeText)
  const revision = /(?:^|[。；\n、])\s*(?:变更原判(?:决)?|改判|撤销原判(?:决)?第)/u.test(item.operativeText)
  const correction = item.effect === 'effective' && prior.length === 1 ? removal ? 'vacated' : revision ? 'amended' : undefined : undefined
  return item.related_cases.map(related => ({ caseNumber: related.case_number, relation: related.relation,
    ...(related.relation === 'prior' && correction && { correction }) }))
}

function checkCase(declaration: Declaration, paragraph: string, declarations: Declaration[], docKey: string | undefined, lookup: CaseLookup | undefined) {
  const checks = { ...declaration.checks }
  const set = (code: CheckCode, outcome: CheckOutcome, reason: string) => { checks[code] = { outcome, reason } }
  const sources: DeclarationSource[] = []
  const number = declaration.quote
  const result = lookup?.result
  const verification: CaseVerification = { caseNumber: number, queryOutcome: lookup?.queryOutcome ?? 'not-queried',
    detailOutcome: result?.outcome ?? 'not-queried', provider: result?.provider ?? '', checkedAt: result?.checkedAt ?? new Date().toISOString(), allowCitation: false }
  const { prefix, tail, phrase } = adjacentText(paragraph, declaration.location.start, declaration.location.end)
  const requested = claimedDetails(prefix, phrase)
  const finish = (extra: Partial<Declaration> = {}) => {
    const priority = ['fail', 'miss', 'pending', 'warn', 'pass'] as const
    const verdict = priority.find(level => Object.values(checks).some(check => check.outcome === level)) ?? 'pending'
    verification.allowCitation = ['pass', 'warn'].includes(verdict) && sources.some(source => !!source.quote && !!source.locator)
    return { ...declaration, ...extra, checks, sources, verdict, caseVerification: verification,
      reason: Object.values(checks).find(check => check.outcome === verdict)?.reason ?? declaration.reason }
  }

  set('C3', 'pending', '尚未取得足够的案例详情与现案要素。')
  set('C4', 'pending', '尚无足够的五维比对依据。')
  set('C5', 'pending', '尚未核实案例权威类型。')
  set('C6', 'pending', '尚未核实裁判效力及其所依法律。')
  set('C7', 'not-applicable', '缺少已经核实的裁判关系。')
  if (result?.outcome !== 'found') {
    const invalid = !hasCaseNumberFormat(number)
    const fail = invalid || result?.outcome === 'authoritative-not-found' || result?.outcome === 'identity-mismatch'
    const pending = result && (failureOutcomes.has(result.outcome)
      || (result.outcome === 'not-queried' && lookup?.queryOutcome === 'no-candidates'))
    set('C1', fail ? 'fail' : pending ? 'pending' : 'miss', invalid ? '案号格式无效。'
      : result?.outcome === 'authoritative-not-found' ? '案号未命中，权威详情明确查无。'
      : result?.outcome === 'identity-mismatch' ? '返回的详情身份与所引案号不一致。'
      : result?.outcome === 'conflicting-detail' ? '同案详情的身份或裁判效力存在冲突，需复核。'
      : result?.outcome === 'not-queried' && pending ? '案例检索无候选，尚未经权威详情核对。'
      : pending ? `详情请求待重试（${result.outcome}）。` : '未取得可核验的裁判全文。')
    set('C2', pending ? 'pending' : 'miss', '尚无可回查的裁判原文与位置。')
    return finish()
  }

  const item = result.item
  const date = calendarDay(item.judgment_date)
  const supplied = [[requested.name, item.name, '案件名称'], [requested.court, item.court, '法院']] as const
  const differences: NonNullable<Declaration['differences']> = supplied.flatMap(([claim, source, field]) => claim && source && caseText(claim) !== caseText(source)
    ? [{ field, document: claim.trim(), source }] : [])
  if (requested.date && date !== undefined && calendarDay(requested.date) !== date) {
    differences.push({ field: '裁判日期', document: requested.date, source: item.judgment_date! })
  }
  const citation = caseCitation(tail, phrase, item)
  const context = assessCaseContext(declaration, item, declarations, docKey)
  const referenced = new Set(item.referenced_statutes.flatMap(statuteKeys))
  const unmatchedStatutes = new Set(referenced)
  const lawDependencies = declarations.flatMap(other => {
    if (other.type !== 'E-LAW') return []
    const matching = statuteKeys(other.quote).filter(key => referenced.has(key))
    for (const key of matching) unmatchedStatutes.delete(key)
    return matching.length ? [{ id: other.id, check: 'C6' as const }] : []
  })
  const dependencies = [...context.dependencies, ...lawDependencies]
  const level = levels.find(value => value === item.level) ?? (item.level && Object.hasOwn(levelNames, item.level) ? levelNames[item.level] : undefined)
  const expectedLevel = requested.level && levelNames[requested.level]
  const missingIdentity = !item.name || !item.court || date === undefined
  if (differences.length) set('C1', 'fail', `裁判详情与引文所述${differences.map(diff => diff.field).join('、')}不一致。`)
  else if (citation.outcome === 'fail') set('C1', 'fail', citation.reason)
  else if (missingIdentity) set('C1', 'pending', '取得裁判全文，案件名称、法院或裁判日期仍待核对。')
  else set('C1', citation.outcome, citation.reason)
  if (citation.outcome === 'fail' && citation.quote) differences.push({ field: citation.kind === 'operative' ? '判项' : '引文', document: citation.quote, source: citation.source ?? '' })

  const passage = citation.passage
  const located = !!passage?.locator && !!passage.text
  set('C2', !item.court || date === undefined ? 'miss' : located ? 'pass' : 'warn', located && item.court && date !== undefined
    ? '法院、裁判日期及原文位置可回查。' : '法院、裁判日期或精确原文位置未齐。')
  const assertedStrict = /严格命中/u.test(`${prefix}${phrase}`)
  const matched = context.matched
  set('C3', matched >= 3 ? 'pass' : matched === 2 ? 'warn' : assertedStrict && context.comparable >= 3 ? 'fail' : 'pending',
    `匹配 ${matched} 项，可比对 ${context.comparable} 项。${context.accuracyReason}`)
  const estimated = context.similarity
  const match = estimated?.match === 'strict' && (matched < 3 || item.relies_on_repealed_law) ? 'analogous' : estimated?.match
  if (match) set('C4', match === 'irrelevant' || (assertedStrict && match !== 'strict') ? 'fail' : match === 'strict' ? 'pass' : 'warn',
    match === 'irrelevant' ? '相关性低于 0.50，当前案例不适合作正文依据。' : match === 'strict' ? '五维相关性及准确性满足严格命中条件。'
      : assertedStrict ? '详情仅支持近似类比，正文将其称为严格命中。' : '现有要素只支持近似类比。')

  if (level) {
    const distance = expectedLevel ? Math.abs(levels.indexOf(level) - levels.indexOf(expectedLevel)) : 0
    set('C5', distance > 1 ? 'fail' : distance ? 'warn' : 'pass', distance ? '正文的案例层级与详情不一致。' : '案例层级已与详情核对。')
  }
  if (item.effect === 'vacated' || item.effect === 'amended' || item.effect === 'pending') set('C6', 'fail', '裁判未生效、已撤销或已被改判，所引原裁判观点不得使用。')
  else if (item.effect === 'effective') {
    const untracked = unmatchedStatutes.size > 0 || (item.referenced_statutes.length > 0 && !referenced.size)
    set('C6', item.relies_on_repealed_law ? 'warn' : untracked ? 'pending' : 'pass', item.relies_on_repealed_law
      ? '裁判使用了已废止法律，仅供近似类比。' : untracked ? '裁判已生效，所依条文仍待核对。' : '详情确认裁判生效。')
  }
  set('C7', 'pass', '当前按已核案号及裁判关系归并计数。')
  Object.assign(verification, { name: item.name, court: item.court, judgmentDate: item.judgment_date, effect: item.effect,
    level, sourceLevel: item.level, score: estimated?.score, match, dimensions: context.dimensions, citationKind: citation.kind,
    referencedStatutes: item.referenced_statutes, relatedCases: reviewedRelations(item),
    documents: lookup?.alternatives ?? [documentLink(result)],
  })
  if (!differences.length && located && citation.kind !== 'secondary' && citation.outcome !== 'fail'
    && checks.C1?.outcome !== 'fail' && checks.C6?.outcome !== 'fail' && match !== 'irrelevant') {
    sources.push({ tier: 'l3', id: item.id, name: item.name ?? number, locator: passage.locator, quote: citation.quote ?? passage.text, url: item.url })
  }
  return finish({ ...(differences.length && { differences }), ...(dependencies.length && { dependencies }) })
}

function groupCases(cases: Declaration[], certificate: CaseCertificate) {
  const byNumber = new Map(cases.flatMap(item => item.caseVerification?.detailOutcome === 'found'
    ? [[normalizeCaseNumber(item.caseVerification.caseNumber), item.caseVerification] as const] : []))
  const links = new Map([...byNumber.keys()].map(number => [number, new Set<string>()]))
  const corrections = new Map<string, 'vacated' | 'amended'>()
  for (const [number, state] of byNumber) {
    for (const related of state.relatedCases ?? []) {
      const other = normalizeCaseNumber(related.caseNumber)
      if (!byNumber.has(other)) continue
      links.get(number)?.add(other)
      links.get(other)?.add(number)
      if (related.correction && corrections.get(other) !== 'vacated') corrections.set(other, related.correction)
    }
  }
  const groups = new Map<string, string[]>()
  for (const number of links.keys()) {
    if (groups.has(number)) continue
    const visited = new Set([number])
    for (const node of visited) for (const other of links.get(node) ?? []) visited.add(other)
    const group = [...visited].sort()
    for (const node of group) groups.set(node, group)
  }
  const counted = new Set<string>()
  const mentions = new Map<string, number>()
  for (const item of cases) {
    const state = item.caseVerification
    const id = state && groups.get(normalizeCaseNumber(state.caseNumber))?.[0]
    if (id) mentions.set(id, (mentions.get(id) ?? 0) + 1)
  }
  return cases.map(item => {
    const state = item.caseVerification
    const number = state && normalizeCaseNumber(state.caseNumber)
    const group = number ? groups.get(number) : undefined
    if (!state || !group) return item
    const groupId = group[0]
    const paragraph = certificate.paragraphs.find(entry => entry.id === item.location.paragraphId)?.text ?? ''
    const inflated = (mentions.get(groupId) ?? 0) > 1 && /(?:[二两三四五六七八九十\d]+(?:个|件|起))\s*(?:独立|不同)案例/u.test(paragraph)
    const correction = number ? corrections.get(number) : undefined
    const isCounted = state.allowCitation && !inflated && !correction && !counted.has(groupId)
    if (isCounted) counted.add(groupId)
    const documents = group.flatMap(number => byNumber.get(number)?.documents ?? [])
    const caseVerification = { ...state, allowCitation: state.allowCitation && !inflated && !correction, groupId, counted: isCounted,
      documents: [...new Map(documents.map(document => [`${document.provider}:${document.id}:${document.url}`, document])).values()] }
    if (correction) {
      const reason = correction === 'vacated' ? '已核实的生效后审裁判撤销了原判。' : '已核实的生效后审裁判变更了原判，原观点须重新核对。'
      return { ...item, caseVerification: { ...caseVerification, effect: correction }, sources: [], verdict: 'fail' as const,
        reason, checks: { ...item.checks, C6: { outcome: 'fail' as const, reason } } }
    }
    if (inflated) {
      const reason = '已确认同案的裁判被写成多个独立案例。'
      return { ...item, caseVerification, verdict: 'fail' as const, reason, checks: { ...item.checks, C7: { outcome: 'fail' as const, reason } } }
    }
    return { ...item, caseVerification }
  })
}

async function reviewLaterCases(declaration: Declaration, lookupCase: (number: string) => Promise<CaseLookup>) {
  const state = declaration.caseVerification
  const later = state?.relatedCases?.filter(item => item.relation === 'appeal' || item.relation === 'retrial') ?? []
  if (!state || !later.length || declaration.checks.C6?.outcome === 'fail') return declaration
  const original = normalizeCaseNumber(state.caseNumber)
  const results = await Promise.all(later.map(async relation => {
    const { result } = await lookupCase(relation.caseNumber)
    if (result.outcome !== 'found' || result.item.effect !== 'effective') return undefined
    const prior = reviewedRelations(result.item)?.find(item => item.relation === 'prior' && normalizeCaseNumber(item.caseNumber) === original)
    return prior && { document: documentLink(result), correction: prior.correction }
  }))
  const confirmed = results.filter(result => result !== undefined)
  const correction = confirmed.find(result => result.correction === 'vacated')?.correction
    ?? confirmed.find(result => result.correction === 'amended')?.correction
  const documents = [...new Map([...(state.documents ?? []), ...confirmed.map(item => item.document)]
    .map(document => [`${document.provider}:${document.id}:${document.url}`, document])).values()]
  if (!correction && confirmed.length === later.length) return { ...declaration, caseVerification: { ...state, documents } }
  const outcome = correction ? 'fail' as const : 'pending' as const
  const reason = correction === 'vacated' ? '已核实的生效后审裁判撤销了原判。'
    : correction === 'amended' ? '已核实的生效后审裁判变更了原判，原观点须重新核对。'
      : '存在已定位的后审裁判，其全文、效力或与原判的关系尚待核对。'
  const retainVerdict = !correction && (declaration.verdict === 'fail' || declaration.verdict === 'miss')
  return { ...declaration, checks: { ...declaration.checks, C6: { outcome, reason } }, sources: [],
    verdict: retainVerdict ? declaration.verdict : outcome, reason: retainVerdict ? declaration.reason : reason,
    caseVerification: { ...state, documents, effect: correction ?? state.effect, allowCitation: false } }
}

export async function verifyCaseDeclarations(certificate: CaseCertificate, declarations: Declaration[], adapter: CaseAdapter, signal?: AbortSignal) {
  const cache = new Map<string, Promise<CaseLookup>>()
  const lookupCase = (caseNumber: string) => {
    const key = normalizeCaseNumber(caseNumber)
    let lookup = cache.get(key)
    if (!lookup) {
      lookup = findCase(adapter, caseNumber, signal)
      cache.set(key, lookup)
    }
    return lookup
  }
  const paragraphs = new Map(certificate.paragraphs.map(item => [item.id, item.text]))
  const cases: Declaration[] = []
  for (const declaration of declarations) {
    if (declaration.type !== 'E-CASE') continue
    signal?.throwIfAborted()
    const lookup = hasCaseNumberFormat(normalizeCaseNumber(declaration.quote)) ? await lookupCase(declaration.quote) : undefined
    const checked = checkCase(declaration, paragraphs.get(declaration.location.paragraphId) ?? '', declarations, certificate.docKey, lookup)
    cases.push(await reviewLaterCases(checked, lookupCase))
  }
  const verified = new Map(groupCases(cases, certificate).map(item => [item.id, item]))
  return declarations.map(item => verified.get(item.id) ?? item)
}
