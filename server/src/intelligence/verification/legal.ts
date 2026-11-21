import type { CertificateParagraph, KnowledgeStatuteDocument, WorkspaceState } from '../../domain.js'
import { createLegalStatuteAdapter, type StatuteDetailResult } from '../../integrations/legal-statute.js'
import { createWorkspaceCaseAdapter } from '../../integrations/workspace-case.js'
import { articleIndex, extractStatuteCitations } from '../legal-verification.js'
import { verifyCaseDeclarations } from './case.js'
import type { CheckCode, CheckOutcome, Declaration, DeclarationSource } from './protocol.js'
import { quotedStatuteText } from './review-status.js'
import { assessStatuteContext, hasVerifiedContractBreach, matchesProvisionGrounds, requestBasisChecks, supportsContractBreach } from './statute-context.js'
import { statuteConflictChecks } from './statute-hierarchy.js'
import { assessStatuteEffect, calendarDay, isOfficialStatuteSource, normalizeStatuteValidity, statuteTrack } from './statute-effect.js'

export { classifyCaseSimilarity } from './case-context.js'

const canonical = (value: string) => value.normalize('NFKC').replace(/[\s，,。]/gu, '')
const titleKey = (value: string) => canonical(value).replace(/^中华人民共和国/u, '')
const matchesLawTitle = (actual: string, requested: string) => titleKey(actual) === titleKey(requested)
  || titleKey(actual).replace(/\((?:19|20)\d{2}年?(?:修正|修订|修改)\)$/u, '') === titleKey(requested)

export function statuteQuoteMatches(quote: string, original: string) {
  const normalize = (value: string) => value.replace(/[\s，,]/gu, '')
  return normalize(quote) === normalize(original)
}

const articleParts = /^(?:第)?([0-9零〇一二三四五六七八九十百千万两]+)条(?:之([0-9零〇一二三四五六七八九十百千万两]+))?(?:第([0-9零〇一二三四五六七八九十百千万两]+)款)?(?:第([0-9零〇一二三四五六七八九十百千万两]+)项)?$/u

function articleKey(value: string) {
  const parts = articleParts.exec(value.normalize('NFKC').replace(/\s/gu, ''))
  if (!parts) return undefined
  const parsed = parts.slice(1).map(part => part ? articleIndex(part) : 0)
  if (parsed[0] > 0 && parsed.every((part, index) => Number.isSafeInteger(part) && (!parts[index + 1] || part > 0))) return parsed.join(':')
}

function factDates(text: string) {
  return text.split(/[，,。；;！？\n]/u).flatMap(clause => {
    if (!/交付|转账|借条|借款|签订|续签|收货|付款|交货|还款|违约|届满|到期|履行|解除|立案|送达/u.test(clause)
      || /(?:发布|公布|施行|废止|修订)(?:于|日|之日|日期)?\s*(?:\d|$)/u.test(clause)) return []
    return [...clause.matchAll(/\d{4}[年./-]\d{1,2}[月./-]\d{1,2}日?(?!\d)/gu)]
      .map(item => calendarDay(item[0])).filter(value => value !== undefined)
  })
}

function statuteLocator(declaration: Declaration, paragraph: Pick<CertificateParagraph, 'text'>, declarations: Declaration[]) {
  const citations = extractStatuteCitations(declaration.quote.normalize('NFKC'))
  const citation = citations[0]
  if (citations.length !== 1 || !citation?.number || !citation.raw.includes('第')) return undefined
  const quote = declaration.quote.normalize('NFKC')
  const numberStart = quote.indexOf('第', quote.indexOf('》') + 1)
  const article_number = quote.slice(numberStart).replace(/\s/gu, '')
  if (!articleKey(article_number)) return undefined
  const localDates = factDates(paragraph.text.slice(0, declaration.location.start))
  const dates = new Set(localDates.length ? localDates : declarations.filter(item => item.type === 'E-FACT'
    && (item.verdict === 'pass' || item.verdict === 'note') && item.sources.some(source => source.tier === 'l1')).flatMap(item => factDates(item.quote)))
  const refer_date = dates.size === 1 ? new Date([...dates][0]).toISOString().slice(0, 10) : undefined
  return { law_name: citation.title, article_number, ...(refer_date && { refer_date }) }
}

const providers = {
  npc_flk: 'flk.npc.gov.cn', moj_xzfg: 'xzfg.moj.gov.cn', gov_gjgzk: 'www.gov.cn', moj_regulations: 'www.moj.gov.cn',
}

function sourceUrl(document: KnowledgeStatuteDocument): string | undefined {
  if (!document.sourceProvider || !document.sourceDocumentId || !document.sourceVerifiedAt || !document.sourceUrl) return undefined
  try {
    const url = new URL(document.sourceUrl)
    return url.protocol === 'https:' && !url.username && !url.password && url.hostname === providers[document.sourceProvider] && url.pathname !== '/'
      ? url.href : undefined
  } catch { return undefined }
}

function storedRepealDate(document: KnowledgeStatuteDocument) {
  if (document.effectiveStatus !== 'repealed') return undefined
  const end = calendarDay(document.revisionDate)
  const start = calendarDay(document.effectiveDate)
  const checked = calendarDay(document.sourceVerifiedAt)
  // 官方目录曾把发布日期写入修订字段。只有可区分的停用日期才进入时点判定。
  if (end !== undefined && start !== undefined && checked !== undefined && end > start && end <= checked
    && end !== calendarDay(document.publishDate)) return document.revisionDate
}

function workspaceVersionAt(document: KnowledgeStatuteDocument, date: number) {
  if (!sourceUrl(document)) return 'uncertain'
  const effective = calendarDay(document.effectiveDate)
  const checked = calendarDay(document.sourceVerifiedAt)
  if (effective !== undefined && date < effective) return 'outside'
  const repealed = calendarDay(storedRepealDate(document))
  if (repealed !== undefined && date >= repealed) return 'outside'
  if (effective === undefined || checked === undefined || date > checked) return 'uncertain'
  return document.effectiveStatus === 'effective' || (document.effectiveStatus === 'repealed' && repealed !== undefined)
    ? 'applicable' : 'uncertain'
}

function workspaceStatuteAdapter(statutes: KnowledgeStatuteDocument[]) {
  return createLegalStatuteAdapter(async request => {
    const rows = statutes.flatMap(document => document.articles.flatMap(article => {
      const article_number = [article.articleNumber, article.clauseNumber, article.itemNumber].filter(Boolean).join('')
      const identity = { id: article.id, law_name: document.title, article_number, document }
      if (request.action === 'semantic') {
        const query = request.query.trim()
        return query && (document.title.includes(query) || article.topicTags?.includes(query) || article.plainText?.includes(query)) ? [identity] : []
      }
      const match = 'id' in request ? request.id === article.id
        : titleKey(request.law_name) === titleKey(document.title) && articleKey(request.article_number) === articleKey(article_number)
      if (!match) return []
      return [{ ...identity, text: article.plainText, url: sourceUrl(document), validity: document.effectiveStatus,
        version: document.version, effective_date: document.effectiveDate, repeal_date: storedRepealDate(document),
        publish_date: document.publishDate, checked_at: document.sourceVerifiedAt,
        issuer: document.issuer, doc_type: document.docType }]
    }))
    if (request.action === 'article_detail' && !rows.length) return { outcome: 'unverified-detail' }
    if (request.action === 'article_detail' && rows.length > 1) {
      const date = calendarDay(request.refer_date)
      if (date === undefined) return { outcome: 'unverified-detail' }
      const versions = rows.map(row => ({ row, state: workspaceVersionAt(row.document, date) }))
      const usable = versions.filter(version => version.state !== 'outside')
      return usable.length === 1 && usable[0].state === 'applicable' ? { items: [usable[0].row] } : { outcome: 'unverified-detail' }
    }
    return { items: request.action === 'semantic' ? rows.slice(0, request.top_k ?? 30) : rows }
  })
}

const verdictPriority = ['fail', 'miss', 'pending', 'warn', 'pass'] as const

function settle(declaration: Declaration): Declaration {
  const applicable = Object.values(declaration.checks).filter(check => check.outcome !== 'not-applicable')
  const verdict = verdictPriority.find(level => applicable.some(check => check.outcome === level)) ?? 'pending'
  return { ...declaration, verdict, reason: applicable.find(check => check.outcome === verdict)?.reason ?? declaration.reason }
}

function decision(declaration: Declaration) {
  const checks = { ...declaration.checks }
  const sources: DeclarationSource[] = []
  const set = (code: CheckCode, outcome: CheckOutcome, reason: string) => { checks[code] = { outcome, reason } }
  const finish = () => settle({ ...declaration, checks, sources })
  return { set, sources, finish }
}

type StatuteLookup = { result: StatuteDetailResult; provider?: StatuteDetailResult; official?: StatuteDetailResult; conflicted?: boolean; resolution?: string }

function statuteSource(item: Extract<StatuteDetailResult, { outcome: 'found' }>['item']): DeclarationSource {
  return { tier: 'l2', id: item.id, name: item.law_name, locator: item.article_number, quote: item.text, url: item.url, version: item.version }
}

function checkStatute(input: Declaration, paragraph: Pick<CertificateParagraph, 'text'>, declarations: Declaration[],
  docKey?: string, locator?: StatuteLocator, tracks?: StatuteLookup): Declaration {
  const { statuteVerification: _time, verifiedText: _suggestion, verifiedSources: _suggestedSources, differences: _diff, ...declaration } = input
  const { set, sources, finish } = decision(declaration)
  set('B4', 'pending', '尚需结合已核事实复核构成要件和适用范围。')
  set('B5', 'pending', '尚需核对法源的规范层级与适用地域。')
  set('B6', 'pending', '尚需检查整项请求的请求权基础是否齐备。')
  if (!tracks) {
    set('B1', 'miss', '未能唯一定位到具体条款。')
    set('B2', 'pending', '尚无可核对的版本。')
    set('B3', 'miss', '尚无可逐字核对的条文。')
    return finish()
  }
  const lookup = tracks.result
  const { outcome: effect, reason, ...assessment } = assessStatuteEffect(lookup, locator?.refer_date, !!tracks.conflicted)
  const statuteVerification = { ...assessment, provider: statuteTrack(tracks.provider), official: statuteTrack(tracks.official) }
  set('B2', effect, `${statuteVerification.validity}：${reason}${tracks.resolution ? ` ${tracks.resolution}` : ''}`)
  if (lookup.outcome !== 'found') {
    const outcome = lookup.outcome === 'authoritative-not-found' ? 'fail' : lookup.outcome === 'unverified-detail' ? 'miss' : 'pending'
    set('B1', outcome, outcome === 'fail' ? '权威详情确认查无该条款。'
      : outcome === 'miss' ? '缺少可回查的对应条文原文。' : `法源详情待重试（${lookup.outcome}）。`)
    set('B3', outcome === 'pending' ? 'pending' : 'miss', '尚无可逐字核对的条文。')
    return { ...finish(), statuteVerification }
  }
  const item = lookup.item
  sources.push(statuteSource(item))
  set('B1', 'pass', '详情已核对法名、条款和原文。')
  const context = assessStatuteContext(declaration, paragraph.text, item, declarations, docKey)
  set('B4', context.B4.outcome, context.B4.reason)
  set('B5', context.B5.outcome, context.B5.reason)
  const dependencies = [...new Map([...(declaration.dependencies ?? []), ...context.dependencies].map(edge => [`${edge.id}:${edge.check}`, edge])).values()]
  if (tracks.conflicted) {
    set('B3', 'pending', '法源版本冲突尚未解决，引文待重核。')
    return { ...finish(), statuteVerification, ...(dependencies.length && { dependencies }) }
  }
  const tail = paragraph.text.slice(declaration.location.end)
  const literal = quotedStatuteText(tail)?.[1]
  if (literal === undefined) {
    const summary = /^\s*(?:[（(]\s*)?要旨归纳\s*(?:[）)]\s*)?[：:]\s*[^。；！？\s]/u.test(tail)
    set('B3', summary ? 'warn' : 'miss', summary ? '已取得原文，标注为要旨归纳的内容需复核其含义。' : '文书只列条号，未发现可逐字核对的引文。')
    return { ...finish(), statuteVerification, ...(dependencies.length && { dependencies }) }
  }
  const exact = statuteQuoteMatches(literal, item.text)
  set('B3', exact ? 'pass' : 'fail', exact ? '引文与所定位条文一致。' : '引号内文字与所定位条文不符。')
  return { ...finish(), statuteVerification, ...(dependencies.length && { dependencies }),
    ...(!exact && { differences: [{ field: '引文', document: literal, source: item.text }] }) }
}

type LegalCertificate = { docKey?: string; paragraphs: Array<Pick<CertificateParagraph, 'id' | 'text'>> }
type LegalWorkspace = Pick<WorkspaceState, 'knowledgeStatutes' | 'knowledgeCases'>

type StatuteAdapter = ReturnType<typeof createLegalStatuteAdapter>
type StatuteLocator = NonNullable<ReturnType<typeof statuteLocator>>

async function findStatuteDetail(adapter: StatuteAdapter, locator: NonNullable<ReturnType<typeof statuteLocator>>, signal?: AbortSignal): Promise<StatuteDetailResult> {
  const response = locator.refer_date && adapter.datedDetailByName ? await adapter.detail(locator, signal)
    : await searchStatuteDetail(adapter, locator, signal)
  return response.outcome === 'found' && (!matchesLawTitle(response.item.law_name, locator.law_name)
    || articleKey(response.item.article_number) !== articleKey(locator.article_number))
    ? { outcome: 'unverified-detail', checkedAt: response.checkedAt } : response
}

async function searchStatuteDetail(adapter: StatuteAdapter, locator: StatuteLocator, signal?: AbortSignal): Promise<StatuteDetailResult> {
  const search = await adapter.search({ action: 'search_article', ...locator }, signal)
  if (search.outcome === 'timeout' || search.outcome === 'forbidden' || search.outcome === 'unavailable') {
    return { outcome: search.outcome, checkedAt: new Date().toISOString() }
  }
  const matches = search.items.filter(item => matchesLawTitle(item.law_name, locator.law_name)
    && articleKey(item.article_number) === articleKey(locator.article_number))
  const id = matches.length === 1 ? matches[0].id : undefined
  const byId = await adapter.detail({ ...locator, id }, signal)
  return id && byId.outcome === 'authoritative-not-found' ? adapter.detail(locator, signal) : byId
}

async function lookupStatute(primary: StatuteAdapter, officialAdapter: StatuteAdapter | undefined,
  locator: StatuteLocator, signal?: AbortSignal, localOfficial?: StatuteAdapter): Promise<StatuteLookup> {
  if (!officialAdapter) {
    const provider = await findStatuteDetail(primary, locator, signal)
    return provider.outcome === 'found' && !isOfficialStatuteSource(provider.item.url)
      ? { result: provider, provider } : { result: provider, official: provider }
  }
  const officialLookup = async () => {
    const result = await findStatuteDetail(officialAdapter, locator, signal)
    if (!localOfficial || result.outcome === 'found' || result.outcome === 'authoritative-not-found') return result
    const local = await findStatuteDetail(localOfficial, locator, signal)
    return local.outcome === 'found' ? local : result
  }
  const [provider, official] = await Promise.all([findStatuteDetail(primary, locator, signal), officialLookup()])
  if (official.outcome === 'found' && isOfficialStatuteSource(official.item.url)) {
    const assessment = assessStatuteEffect(official, locator.refer_date, false)
    const differentKnown = (left: string | number | undefined, right: string | number | undefined) => left !== undefined && right !== undefined && left !== right
    const disagrees = provider.outcome === 'found' && (normalizeStatuteValidity(provider.item.validity) !== normalizeStatuteValidity(official.item.validity)
      || !statuteQuoteMatches(provider.item.text, official.item.text)
      || differentKnown(calendarDay(provider.item.effective_date), calendarDay(official.item.effective_date))
      || differentKnown(calendarDay(provider.item.repeal_date), calendarDay(official.item.repeal_date))
      || differentKnown(provider.item.issuer, official.item.issuer) || differentKnown(provider.item.region, official.item.region)
      || differentKnown(provider.item.transition_note, official.item.transition_note))
    const conflicted = disagrees && assessment.applicability === 'uncertain'
    return { result: official, provider, official, conflicted, resolution: conflicted
      ? '供应商与官方详情不一致，官方信息尚不足以确认所涉时点。'
      : disagrees ? '两轨详情不一致，按可证实的日期采用官方详情。' : '采用官方详情核对版本。' }
  }
  const result = official.outcome === 'authoritative-not-found' ? official
    : localOfficial && provider.outcome === 'authoritative-not-found' ? { outcome: 'empty-response' as const, checkedAt: official.checkedAt } : provider
  return { result, provider, official,
    resolution: official.outcome === 'authoritative-not-found' ? '官方详情确认查无，未采用供应商候选。' : '官方详情未确认，保留供应商轨状态。' }
}

async function suggestReplacement(law: Declaration, locator: StatuteLocator, declarations: Declaration[],
  certificate: LegalCertificate, paragraph: string, primary: StatuteAdapter, workspaceAdapter: StatuteAdapter,
  lookup: (locator: StatuteLocator) => Promise<StatuteLookup>, signal?: AbortSignal) {
  const B2 = law.checks.B2
  if (B2?.outcome !== 'fail' || !['REPEALED', 'EXPIRED', 'AMENDED'].includes(law.statuteVerification?.validity ?? '')) return law
  const original = law.sources[0]?.quote ?? ''
  const suggestion = (item: Extract<StatuteDetailResult, { outcome: 'found' }>['item']) =>
    ({ ...law, verifiedText: `《${item.law_name}》${item.article_number}：“${item.text}”`, verifiedSources: [statuteSource(item)] })
  if (titleKey(locator.law_name) === '合同法' && articleKey(locator.article_number) === '107:0:0:0'
    && supportsContractBreach(original) && hasVerifiedContractBreach(law, declarations)) {
    const candidate = await lookup({ law_name: '民法典', article_number: '第五百七十七条', refer_date: locator.refer_date })
    if (candidate.result.outcome === 'found' && supportsContractBreach(candidate.result.item.text)
      && assessStatuteEffect(candidate.result, locator.refer_date, !!candidate.conflicted).outcome === 'pass') {
      return suggestion(candidate.result.item)
    }
  }
  if (locator.refer_date && original) {
    // 发给法源的检索词只包含公开条文，案件请求和已核事实在本地检查。
    const query = { action: 'semantic' as const, query: original.trim().slice(0, 300), refer_date: locator.refer_date, top_k: 6 }
    const found = await primary.search(query, signal)
    const stored = primary === workspaceAdapter ? [] : (await workspaceAdapter.search(query, signal)).items
    const originalKey = `${titleKey(locator.law_name)}:${articleKey(locator.article_number)}`
    const candidates = new Map([...found.items.slice(0, 6), ...stored].map(item => [`${titleKey(item.law_name)}:${articleKey(item.article_number)}`, item]))
    candidates.delete(originalKey)
    const verified = (await Promise.all([...candidates.values()].map(async ({ law_name, article_number }) => {
      const candidate = await lookup({ law_name, article_number, refer_date: locator.refer_date })
      if (candidate.result.outcome !== 'found' || !matchesProvisionGrounds(original, candidate.result.item.text)
        || assessStatuteEffect(candidate.result, locator.refer_date, !!candidate.conflicted).outcome !== 'pass') return undefined
      const item = candidate.result.item
      const context = assessStatuteContext(law, paragraph, item, declarations, certificate.docKey)
      return context.B4.outcome === 'pass' && context.B5.outcome === 'pass' ? item : undefined
    }))).filter(item => item !== undefined)
    if (verified.length === 1) return suggestion(verified[0])
  }
  return settle({ ...law, checks: { ...law.checks, B2: { ...B2, reason: `${B2.reason} 替代条文待核，需律师复核。` } } })
}

export async function verifyLegalDeclarations(certificate: LegalCertificate, declarations: Declaration[], workspace: LegalWorkspace,
  adapter?: StatuteAdapter, signal?: AbortSignal, officialAdapter?: StatuteAdapter,
  caseAdapter = createWorkspaceCaseAdapter(workspace.knowledgeCases), frozen?: ReadonlySet<string>): Promise<Declaration[]> {
  const workspaceAdapter = workspaceStatuteAdapter(workspace.knowledgeStatutes)
  const primary = adapter ?? workspaceAdapter
  const official = officialAdapter ?? (adapter && workspace.knowledgeStatutes.length ? workspaceAdapter : undefined)
  const paragraphs = new Map(certificate.paragraphs.map(item => [item.id, item]))
  const cache = new Map<string, Promise<StatuteLookup>>()
  const lookup = (locator: StatuteLocator) => {
    const key = JSON.stringify([titleKey(locator.law_name), articleKey(locator.article_number), locator.refer_date])
    const existing = cache.get(key)
    if (existing) return existing
    const result = lookupStatute(primary, official, locator, signal, officialAdapter ? workspaceAdapter : undefined)
    cache.set(key, result)
    return result
  }
  const checked: Declaration[] = []
  const details = new Map<string, Extract<StatuteDetailResult, { outcome: 'found' }>['item']>()
  for (const declaration of declarations) {
    signal?.throwIfAborted()
    const paragraph = paragraphs.get(declaration.location.paragraphId)
    if (declaration.type === 'E-LAW' && paragraph && !frozen?.has(declaration.id)) {
      const locator = statuteLocator(declaration, paragraph, declarations)
      const tracks = locator && await lookup(locator)
      if (tracks?.result.outcome === 'found' && !tracks.conflicted) details.set(declaration.id, tracks.result.item)
      const law = checkStatute(declaration, paragraph, declarations, certificate.docKey, locator, tracks)
      checked.push(locator ? await suggestReplacement(law, locator, declarations, certificate, paragraph.text, primary, workspaceAdapter, lookup, signal) : law)
    } else {
      checked.push(declaration)
    }
  }
  // 未冻结法条的位阶判定仍可能需要同句的已确认法条作为对照。
  if (frozen?.size && details.size) {
    const fresh = checked.filter(item => details.has(item.id))
    const peers = checked.filter(item => item.type === 'E-LAW' && frozen.has(item.id) && item.checks.B5?.outcome === 'pass'
      && fresh.some(other => other.location.paragraphId === item.location.paragraphId && other.location.sentenceIndex === item.location.sentenceIndex))
    for (const peer of peers) {
      const paragraph = paragraphs.get(peer.location.paragraphId)
      const locator = paragraph && statuteLocator(peer, paragraph, declarations)
      const tracks = locator && await lookup(locator)
      if (tracks?.result.outcome === 'found' && !tracks.conflicted) details.set(peer.id, tracks.result.item)
    }
  }
  const conflicts = statuteConflictChecks(certificate.paragraphs, checked, details)
  const withHierarchy = checked.map(declaration => {
    const B5 = conflicts.get(declaration.id)
    return B5 && !frozen?.has(declaration.id) ? settle({ ...declaration, checks: { ...declaration.checks, B5 } }) : declaration
  })
  const basisChecks = requestBasisChecks(withHierarchy)
  const withBasis = withHierarchy.map((declaration): Declaration => {
    const B6 = basisChecks.checks.get(declaration.id)
    if (!B6 || frozen?.has(declaration.id)) return declaration
    const dependencies = [...(declaration.dependencies ?? []).filter(edge => edge.check !== 'B6'), ...(basisChecks.dependencies.get(declaration.id) ?? [])]
    const next = { ...declaration, checks: { ...declaration.checks, B6 }, dependencies: dependencies.length ? dependencies : undefined }
    if (declaration.type === 'E-LAW') return settle(next)
    if (B6.outcome === 'miss' && declaration.verdict !== 'fail') return { ...next, verdict: 'miss', reason: B6.reason }
    if (B6.outcome === 'warn' && ['pass', 'note'].includes(declaration.verdict)) return { ...next, verdict: 'warn', reason: B6.reason }
    return next
  })
  return verifyCaseDeclarations(certificate, withBasis, caseAdapter, signal, frozen)
}
