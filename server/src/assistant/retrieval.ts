import type { EvidenceLink, KnowledgeCase, ParagraphReference, WorkspaceState } from '../domain.js'
import { matchesCaseExcerpt, type CaseCandidate } from '../integrations/legal-case.js'
import type { createLegalStatuteAdapter } from '../integrations/legal-statute.js'
import { createWorkspaceCaseAdapter } from '../integrations/workspace-case.js'
import { splitEvidenceTextIntoPages } from '../intelligence/evidence-retrieval.js'
import { articleIndex, extractStatuteCitations, hasCaseNumberFormat, normalizeCaseNumber } from '../intelligence/legal-verification.js'
import { buildStatuteReference } from '../intelligence/statute-version.js'
import { verifyCaseDeclarations } from '../intelligence/verification/case.js'
import { applyDeclarationDependencies } from '../intelligence/verification/dependencies.js'
import { verifyLegalDeclarations } from '../intelligence/verification/legal.js'
import type { CaseVerification, Declaration, DeclarationSource, StatuteValidity, StatuteVerification } from '../intelligence/verification/protocol.js'
import { calendarDay } from '../intelligence/verification/statute-effect.js'
import { validateSkillOutput } from './skill-contract.js'

export type RetrievalSkillId = 'inbox-search' | 'statute-mcp' | 'case-mcp'

export function isRetrievalSkill(id: string): id is RetrievalSkillId {
  return id === 'inbox-search' || id === 'statute-mcp' || id === 'case-mcp'
}

export interface RetrievalInput {
  query: string
  caseId: string
  workspace: Pick<WorkspaceState, 'evidences' | 'evidenceFragments' | 'knowledgeStatutes' | 'knowledgeCases'>
  factDate?: string
  declarations?: Declaration[]
  docKey?: string
  statuteAdapter?: ReturnType<typeof createLegalStatuteAdapter>
  officialStatuteAdapter?: ReturnType<typeof createLegalStatuteAdapter>
  caseAdapter?: ReturnType<typeof createWorkspaceCaseAdapter>
  signal?: AbortSignal
}

type CitationFields = { material_name: string; loc: string; excerpt: string }
  | { law_name: string; article_number: string; validity: StatuteValidity; text: string; url: string }
  | { case_number: string; court: string; judgment_date: string; gist: string; hit_level: '严格命中' | '近似类比'; url: string }

type CardDetails = {
  label: string
  reason?: string
  locator?: string
  url?: string
  excerpt?: string
  entry?: KnowledgeCase
  statuteVerification?: StatuteVerification
  caseVerification?: CaseVerification
}

export type RetrievalCard = CardDetails & ({
  status: 'verified'
  output: { type: 'citation-card' } & CitationFields
  source: DeclarationSource
  citationText: string
  evidenceLink?: EvidenceLink
  reference?: ParagraphReference
} | {
  status: 'pending'
  output?: never
  source?: never
  citationText?: never
  evidenceLink?: never
  reference?: never
})

export interface RetrievalResult {
  status: 'verified' | 'pending' | 'empty'
  message: string
  cards: RetrievalCard[]
}

type VerifiedCard = Extract<RetrievalCard, { status: 'verified' }>
type StatuteIdentity = { law_name: string; article_number: string }
type StatuteAdapter = NonNullable<RetrievalInput['statuteAdapter']>

const limit = 6
const literal = (value: string) => value.replace(/\s/gu, '')
const compact = (value: string) => literal(value.normalize('NFKC')).toLowerCase()
const titleKey = (title: string) => compact(title).replace(/^中华人民共和国/u, '').replace(/[《》]/gu, '')

function verified(id: RetrievalSkillId, card: Omit<VerifiedCard, 'status'>): VerifiedCard {
  validateSkillOutput(id, card.output)
  return { ...card, status: 'verified' }
}

function result(cards: RetrievalCard[], emptyMessage: string): RetrievalResult {
  if (cards.some(card => card.status === 'verified')) return { cards, status: 'verified', message: '已找到可回查的来源。' }
  if (cards.length) return { cards, status: 'pending', message: '检索结果待核，暂无可采纳引用。' }
  return { cards, status: 'empty', message: emptyMessage }
}

function matchesQuery(text: string, query: string) {
  const value = compact(text)
  for (let start = value.indexOf(query); start >= 0; start = value.indexOf(query, start + 1)) {
    const end = start + query.length
    const partialStart = /^\d/u.test(query) && /(?:\d[.,]?|[+−-])$/u.test(value.slice(Math.max(0, start - 2), start))
    const partialEnd = /\d$/u.test(query) && /^[.,]?\d/u.test(value.slice(end, end + 2))
    if (!partialStart && !partialEnd) return true
  }
  return false
}

function findExcerpt(text: string, query: string) {
  const trimmed = text.trim()
  if (!trimmed || !matchesQuery(trimmed, query)) return undefined
  return trimmed.split(/\r?\n/u).map(line => line.trim()).find(line => matchesQuery(line, query)) ?? trimmed
}

function searchInbox(input: RetrievalInput, query: string): RetrievalResult {
  const needle = compact(query.replace(/^(?:请)?(?:卷内检索|卷内查找|在卷内查找|在卷内检索)\s*[:：]?\s*/u, ''))
  const cards: RetrievalCard[] = []
  const fragments = new Map<string, WorkspaceState['evidenceFragments']>()
  for (const fragment of input.workspace.evidenceFragments) {
    if (fragment.caseId !== input.caseId) continue
    const rows = fragments.get(fragment.evidenceId) ?? []
    rows.push(fragment)
    fragments.set(fragment.evidenceId, rows)
  }
  if (needle) for (const material of input.workspace.evidences) {
    if (material.caseId !== input.caseId || (material.parsing && material.parsing.status !== 'ready')) continue
    const material_name = material.name?.trim() || material.fileName?.trim()
    if (!material_name) continue
    const indexed = fragments.get(material.id)
    const locations = indexed?.length ? indexed : splitEvidenceTextIntoPages(material.ocrText ?? '').map(page => ({
      text: page.content,
      locator: page.page === undefined ? material.anchorHint?.trim() || '材料全文' : `第 ${page.page} 页`,
    }))
    for (const location of locations) {
      const loc = location.locator?.trim()
      const excerpt = findExcerpt(location.text, needle)
      if (!loc || !excerpt || cards.some(card => card.source?.id === material.id && card.locator === loc && card.excerpt === excerpt)) continue
      cards.push(verified('inbox-search', {
        label: material_name, locator: loc, excerpt,
        output: { type: 'citation-card', material_name, loc, excerpt },
        source: { tier: 'l1', id: material.id, name: material_name, locator: loc, quote: excerpt, version: material.contentHash ?? material.sourceFingerprint },
        citationText: `《${material_name}》（${loc}）记载：“${excerpt}”`,
        evidenceLink: { evidenceId: material.id, locator: loc, quote: excerpt },
      }))
      if (cards.length === limit) break
    }
    if (cards.length === limit) break
  }
  return result(cards, '未在本案材料原文中找到匹配内容。可切换至法条或案例检索。')
}

function declaration(id: string, type: 'E-LAW' | 'E-CASE', quote: string, paragraphIndex: number, start = 0): Declaration {
  return { id, type, quote, location: { paragraphId: id, paragraphIndex, start, end: start + quote.length },
    verdict: 'pending', checks: {}, sources: [], reason: '', conf: null }
}

function extractedStatutes(query: string): StatuteIdentity[] {
  const text = query.normalize('NFKC').replace(/^(?:请)?(?:查询|检索|查找|查阅|请问)\s*[:：]?\s*/u, '')
  return extractStatuteCitations(text).flatMap(({ title, number, suffix, from, raw }) => {
    if (!number) return []
    const narrower = text.slice(from + raw.length).match(/^(之[0-9零〇一二三四五六七八九十百千万两]+)?\s*(第[0-9零〇一二三四五六七八九十百千万两]+款)?\s*(第[0-9零〇一二三四五六七八九十百千万两]+项)?/u)
    const article_number = `第${number}条${suffix ? `之${suffix}` : narrower?.[1] ?? ''}${narrower?.[2] ?? ''}${narrower?.[3] ?? ''}`
    return [{ law_name: title, article_number }]
  })
}

function articleKey(value: string) {
  return compact(value).replace(/[0-9零〇一二三四五六七八九十百千万两]+/gu, number => String(articleIndex(number)))
}

function statuteLabel(item: StatuteIdentity) {
  return `《${item.law_name}》${item.article_number}`
}

function statuteReference(source: DeclarationSource, input: RetrievalInput): ParagraphReference | undefined {
  for (const document of input.workspace.knowledgeStatutes) {
    if (titleKey(document.title) !== titleKey(source.name) || document.version !== source.version || document.sourceUrl !== source.url) continue
    const article = document.articles.find(item => item.id === source.id && source.locator && source.quote
      && articleKey([item.articleNumber, item.clauseNumber, item.itemNumber].filter(Boolean).join('')) === articleKey(source.locator)
      && literal(item.plainText) === literal(source.quote))
    if (article) return { ...buildStatuteReference(document, article), locator: source.locator!, quote: source.quote! }
  }
}

function statuteCard(source: DeclarationSource, validity: StatuteValidity, input: RetrievalInput, details: CardDetails): RetrievalCard {
  const { locator, quote, url } = source
  if (!locator || !quote || !url) return { ...details, status: 'pending', reason: '尚无可回查的条文详情。' }
  return verified('statute-mcp', {
    ...details, url, locator, excerpt: quote, source,
    output: { type: 'citation-card', law_name: source.name, article_number: locator, validity, text: quote, url },
    citationText: `${statuteLabel({ law_name: source.name, article_number: locator })}：“${quote}”`,
    reference: statuteReference(source, input),
  })
}

async function searchStatutes(input: RetrievalInput, query: string): Promise<RetrievalResult> {
  const { workspace, statuteAdapter, officialStatuteAdapter, signal } = input
  const emptyMessage = '未找到匹配的法条。可输入法名和条号重试。'
  let candidates = extractedStatutes(query)
  let adapter = statuteAdapter
  if (input.factDate && calendarDay(input.factDate) === undefined) {
    return { cards: [], status: 'pending', message: '请先确认有效的事实发生日期。' }
  }
  const factDate = input.factDate && new Date(calendarDay(input.factDate)!).toISOString().slice(0, 10)
  let searchUnavailable = false
  if (!candidates.length && statuteAdapter) {
    const found = await statuteAdapter.search({ action: 'semantic', query, ...(factDate && { refer_date: factDate }), top_k: limit }, signal)
    searchUnavailable = found.outcome !== 'found' && found.outcome !== 'no-candidates'
    candidates = found.items
    const semanticItems = new Map<string, typeof found.items>()
    for (const item of found.items) {
      const key = `${titleKey(item.law_name)}:${articleKey(item.article_number)}`
      const matches = semanticItems.get(key) ?? []
      if (!matches.some(match => match.id === item.id)) matches.push(item)
      semanticItems.set(key, matches)
    }
    adapter = { ...statuteAdapter, async search(request, requestSignal): ReturnType<StatuteAdapter['search']> {
      const indexed = await statuteAdapter.search(request, requestSignal)
      if (request.action !== 'search_article' || indexed.outcome !== 'no-candidates') return indexed
      const items = semanticItems.get(`${titleKey(request.law_name)}:${articleKey(request.article_number)}`)
      return items?.length ? { outcome: 'found', items } : indexed
    } }
  }
  if (!candidates.length) {
    const needle = compact(query.replace(/[《》]/gu, ''))
    if (!needle) return result([], emptyMessage)
    candidates = workspace.knowledgeStatutes.flatMap(document => document.articles.flatMap(article =>
      compact(document.title).includes(needle) || [article.plainText, ...(article.topicTags ?? [])].some(value => compact(value || '').includes(needle))
        ? [{ law_name: document.title, article_number: [article.articleNumber, article.clauseNumber, article.itemNumber].filter(Boolean).join('') }] : []))
  }
  const unique = [...new Map(candidates.map(item => [`${titleKey(item.law_name)}:${articleKey(item.article_number)}`, item])).values()].slice(0, limit)
  if (!unique.length && searchUnavailable) return { cards: [], status: 'pending', message: '法条检索暂不可用，请重试。' }
  if (!unique.length) return result([], emptyMessage)
  const context = (input.declarations ?? []).filter(item => item.type === 'E-FACT' || item.type === 'E-CLAIM')
  // T4 从法条前的事实语句提取 refer_date，查询本身不作为已核事实。
  const prefix = factDate ? `${factDate}为查询指定的履行时点。` : ''
  const declarations = unique.map((item, index) => declaration(`assistant-statute-${index}`, 'E-LAW', statuteLabel(item), index, prefix.length))
  const paragraphs = declarations.map(item => ({ id: item.id, text: `${prefix}${item.quote}` }))
  const checked = await verifyLegalDeclarations({ paragraphs, docKey: input.docKey }, [...context, ...declarations], workspace,
    adapter, signal, officialStatuteAdapter, undefined, { parallel: true })
  const byId = new Map(checked.map(item => [item.id, item]))
  const cards = declarations.map((item): RetrievalCard => {
    const found = byId.get(item.id)!
    const time = found.statuteVerification
    const details: CardDetails = { label: item.quote, statuteVerification: time }
    const source = found.sources.find(entry => entry.tier === 'l2')
    if (source && time?.applicability === 'applicable' && time.confidence === 'HIGH' && found.checks.B1?.outcome === 'pass') {
      return statuteCard(source, time.validity, input, { ...details, reason: found.checks.B2?.outcome === 'warn' ? found.checks.B2.reason : undefined })
    }
    const replacement = found.verifiedSources?.find(entry => entry.tier === 'l2')
    if (replacement) return statuteCard(replacement, 'VALID', input, { label: `替代条文 · ${replacement.name}${replacement.locator ?? ''}` })
    return { ...details, status: 'pending', url: source?.url, reason: found.checks.B1?.outcome === 'pass' ? found.checks.B2?.reason : found.checks.B1?.reason }
  })
  return result(cards, emptyMessage)
}

function caseReference(entry: KnowledgeCase | undefined, source: DeclarationSource, court: string, number: string): ParagraphReference | undefined {
  if (!entry || entry.sourceUrl !== source.url || !source.locator || !source.quote) return undefined
  const excerpt = entry.excerpts.find(item => item.locator === source.locator && matchesCaseExcerpt(item.content, source.quote!))
  if (!excerpt) return undefined
  return { type: 'case', targetId: excerpt.id, label: `${court} · ${number}`, sourceTitle: source.name,
    locator: source.locator, quote: source.quote }
}

async function searchCases(input: RetrievalInput, query: string): Promise<RetrievalResult> {
  const { workspace, signal } = input
  const adapter = input.caseAdapter ?? createWorkspaceCaseAdapter(workspace.knowledgeCases)
  const emptyMessage = '未找到匹配的案例。可输入完整案号或调整检索词。'
  const exact = [...query.matchAll(/[（(〔【]\s*\d{4}\s*[）)〕】][^。；，,\n]{1,40}?号/gu)]
    .map(match => match[0]).filter(hasCaseNumberFormat)
  const semantic = exact.length ? undefined : await adapter.search({ action: 'semantic', query, top_k: limit }, signal)
  if (semantic && semantic.outcome !== 'found' && semantic.outcome !== 'no-candidates') {
    return { cards: [], status: 'pending', message: '案例检索暂不可用，请重试。' }
  }
  const hints = new Map<string, CaseCandidate[]>()
  for (const entry of semantic?.items ?? []) {
    const key = normalizeCaseNumber(entry.case_number)
    const rows = hints.get(key) ?? []
    rows.push(entry)
    hints.set(key, rows)
  }
  const numbers = [...new Map([...exact, ...(semantic?.items.map(item => item.case_number) ?? [])]
    .map(number => [normalizeCaseNumber(number), number])).values()].slice(0, limit)
  if (!numbers.length) return result([], emptyMessage)
  const contextCases = new Set(input.declarations?.filter(item => item.type === 'E-CASE').map(item => item.location.paragraphId))
  const context = (input.declarations ?? []).filter(item => !contextCases.has(item.location.paragraphId) && item.type !== 'E-CASE')
  const offset = context.reduce((last, item) => Math.max(last, item.location.paragraphIndex), -1) + 1
  const declarations = numbers.map((number, index) => declaration(`assistant-case-${index}`, 'E-CASE', number, offset + index))
  const paragraphs = declarations.map(item => ({ id: item.id, text: item.quote }))
  // 语义检索保留原始 ID，交给 T5 做详情身份、冲突和效力核验。
  const verifiedAdapter: typeof adapter = { ...adapter, async search(request, requestSignal) {
    const indexed = await adapter.search(request, requestSignal)
    if (request.action !== 'keyword' || !semantic || (indexed.outcome !== 'no-candidates' && indexed.outcome !== 'found')) return indexed
    const items = [...indexed.items, ...(hints.get(normalizeCaseNumber(request.case_number)) ?? [])]
    return items.length ? { ...indexed, outcome: 'found', items } : indexed
  } }
  const checked = applyDeclarationDependencies(await verifyCaseDeclarations({ paragraphs, docKey: input.docKey },
    [...context, ...declarations], verifiedAdapter, signal, { parallel: true }))
  const byId = new Map(checked.map(item => [item.id, item]))
  const cards = declarations.flatMap<RetrievalCard>(item => {
    const found = byId.get(item.id)!
    const state = found.caseVerification
    const source = found.sources.find(entry => entry.tier === 'l3')
    const local = workspace.knowledgeCases.find(entry => normalizeCaseNumber(entry.caseNumber) === normalizeCaseNumber(item.quote)
      && (entry.id === source?.id || entry.sourceUrl === source?.url))
      ?? workspace.knowledgeCases.find(entry => normalizeCaseNumber(entry.caseNumber) === normalizeCaseNumber(item.quote))
    const candidateUrl = hints.get(normalizeCaseNumber(item.quote))?.find(candidate => candidate.url)?.url
    const details: CardDetails = { label: state?.name ?? local?.title ?? item.quote, caseVerification: state, entry: local,
      url: source?.url ?? candidateUrl }
    if (!state?.allowCitation || state.effect !== 'effective' || !state.court || !state.judgmentDate || !state.match || state.match === 'irrelevant'
      || found.checks.C6?.outcome !== 'pass' || !source?.locator || !source.quote || !source.url) {
      const reason = found.checks.C6?.outcome === 'warn' ? found.checks.C6.reason : found.reason
      return [{ ...details, status: 'pending', reason, caseVerification: state && { ...state, allowCitation: false, counted: false } }]
    }
    if (state.counted === false) return []
    const hit_level = state.match === 'strict' ? '严格命中' : '近似类比'
    return [verified('case-mcp', {
      ...details, locator: source.locator, url: source.url, excerpt: source.quote, source,
      output: { type: 'citation-card', case_number: item.quote, court: state.court, judgment_date: state.judgmentDate,
        gist: source.quote, hit_level, url: source.url },
      citationText: `${state.court}${item.quote}${source.locator}：“${source.quote}”`,
      reference: caseReference(local, source, state.court, item.quote),
    })]
  })
  return result(cards, emptyMessage)
}

export async function runRetrievalSkill(id: RetrievalSkillId, input: RetrievalInput): Promise<RetrievalResult> {
  input.signal?.throwIfAborted()
  const query = input.query.trim()
  if (!query) return result([], '请输入检索内容。')
  if (id === 'inbox-search') return searchInbox(input, query)
  if (id === 'statute-mcp') return searchStatutes(input, query)
  return searchCases(input, query)
}
