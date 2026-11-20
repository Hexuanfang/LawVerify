import { isValidCaseNumber, normalizeCaseNumber } from '../intelligence/legal-verification.js'

export type CaseSearchRequest = { action: 'semantic'; query: string; top_k?: number }
  | { action: 'keyword'; case_number: string }
export type CaseProviderRequest = CaseSearchRequest | ({ action: 'detail' } & ({ id: string } | { case_number: string }))
type Transport = (request: CaseProviderRequest, signal?: AbortSignal) => Promise<unknown>
export type CaseEffect = 'effective' | 'pending' | 'vacated' | 'amended' | 'unknown'
export type CaseLevel = 'guiding' | 'gazette' | 'high-court-reference' | 'ordinary'
export type CasePassage = { kind: 'reasoning' | 'operative'; locator: string; text: string }
export type CaseCandidate = { id: string; case_number: string; url?: string }
export type CaseDetail = CaseCandidate & {
  body: string; operativeText: string; url: string; name?: string; court?: string; judgment_date?: string; effective_date?: string;
  cause?: string; level?: string; effect: CaseEffect; passages: CasePassage[];
  party_roles: string[]; key_facts: string[]; issues: string[]; legal_relationship?: string;
  rules: string[]; procedure?: string; referenced_statutes: string[]; relies_on_repealed_law: boolean;
  related_cases: Array<{ case_number: string; relation: 'prior' | 'appeal' | 'retrial' }>;
}
type Unverified = 'timeout' | 'forbidden' | 'unavailable' | 'empty-response' | 'not-queried'
  | 'authoritative-not-found' | 'unverified-detail' | 'identity-mismatch' | 'conflicting-detail'
export type CaseDetailResult = { outcome: 'found'; item: CaseDetail; provider: string; checkedAt: string }
  | { outcome: Unverified; provider: string; checkedAt: string }

const record = (value: unknown) => value && typeof value === 'object' ? value as Record<string, unknown> : {}
const textField = (row: Record<string, unknown>, key: string) => typeof row[key] === 'string' ? row[key].trim() || undefined : undefined
const rowsOf = (value: unknown): unknown[] => Array.isArray(value) ? value : []
const strings = (value: unknown) => [...new Set(rowsOf(value).filter((entry): entry is string => typeof entry === 'string')
  .map(entry => entry.trim()).filter(Boolean))]
const literal = (value: string) => value.replace(/\s/gu, '')

export function matchesCaseExcerpt(source: string, quote: string) {
  const text = literal(source)
  const excerpt = literal(quote)
  if (!excerpt) return false
  for (let start = text.indexOf(excerpt); start >= 0; start = text.indexOf(excerpt, start + 1)) {
    const end = start + excerpt.length
    if ((start === 0 || /[，。；：、！？（）]/u.test(text[start - 1]))
      && (end === text.length || /[，。；：、！？]/u.test(text[end]) || /[，。；：、！？]$/u.test(excerpt))) return true
  }
  return false
}

function sourceUrl(row: Record<string, unknown>) {
  const value = textField(row, 'url')
  if (!value || !URL.canParse(value)) return undefined
  const url = new URL(value)
  if (url.protocol === 'https:' && !url.username && !url.password && url.pathname !== '/' && !/^\/(?:index(?:\.html?)?)?$/iu.test(url.pathname)) return url.href
}

function candidate(input: unknown): CaseCandidate | undefined {
  const row = record(input)
  const id = textField(row, 'id')
  const case_number = textField(row, 'case_number')
  if (!id || !case_number || !isValidCaseNumber(case_number)) return undefined
  const url = sourceUrl(row)
  return { id, case_number, ...(url && { url }) }
}

export function judgmentSections(body: string): CasePassage[] {
  const signature = [...body.matchAll(/\n[\t \u3000]*审\s*判\s*[长员]/gu)].at(-1)?.index
  const bodyBeforeSignature = body.slice(0, signature)
  const headings = [...bodyBeforeSignature.matchAll(/(?:^|[\n。；，])\s*(?:(本院认为)\s*[:：，,]|(判决如下|裁定如下)\s*[:：])/gu)]
  const operative = headings.filter(heading => heading[2]).at(-1)
  const reasoning = headings.filter(heading => heading[1] && (!operative || heading.index < operative.index)).at(-1)
  return [reasoning, operative].flatMap(heading => {
    if (!heading) return []
    const kind = heading[1] === '本院认为' ? 'reasoning' : 'operative'
    const start = heading.index + heading[0].length
    const end = kind === 'reasoning' && operative ? operative.index + operative[0].indexOf(operative[2]) : undefined
    const section = bodyBeforeSignature.slice(start, end).split(/\n\s*(?=(?:审\s*判\s*[长员]|书\s*记\s*员|人民陪审员))/u, 1)[0].trim()
    return section ? [{ kind, locator: heading[1] ?? heading[2], text: section }] : []
  })
}

function confirmsCaseRelation(body: string, number: string, relation: CaseDetail['related_cases'][number]['relation']) {
  const proceduralHistory = body.split(/本院认为|本院查明|经审理查明/u, 1)[0]
  const clauses = (relation === 'prior' ? proceduralHistory : body).split(/[。；\n]/u)
  const anchor = normalizeCaseNumber(number)
  return clauses.some(clause => {
    const text = normalizeCaseNumber(clause)
    const index = text.indexOf(anchor)
    if (index < 0 || /参照|援引|类似案件|类案|另案|其他案件/u.test(text)) return false
    const before = text.slice(0, index)
    const after = text.slice(index + anchor.length)
    if (!/(?:判决|裁定)/u.test(after)) return false
    if (relation === 'prior') return (/(?:上诉人|再审申请人).*不服/u.test(before) && /提起上诉|提出上诉|向本院上诉|申请再审|提起再审/u.test(after))
      || /(?:本案原审|原审法院|一审法院|原二审法院)/u.test(before)
    return /本案|原案/u.test(before) && (relation === 'retrial' ? /再审/u.test(text) : /二审|上诉/u.test(text))
  })
}

function detail(input: unknown): CaseDetail | undefined {
  const row = record(input)
  const entry = candidate(row)
  const body = textField(row, 'body')
  if (!entry?.url || !body) return undefined
  const header = body.split(/本院认为|原告诉称|原告诉请|上诉人诉称|上诉人上诉请求|判决如下|裁定如下/u, 1)[0].slice(0, 800)
  const headerLines = header.split(/\r?\n/u).map(line => line.trim()).filter(Boolean)
  const judgmentTitle = headerLines.findIndex(line => /^(?:民事|刑事|行政)?(?:判决书|裁定书|裁判文书)$/u.test(line))
  const headerNumber = headerLines[judgmentTitle + 1]
  if (judgmentTitle === -1 || !headerNumber || normalizeCaseNumber(headerNumber) !== normalizeCaseNumber(entry.case_number)) return undefined
  const sections = judgmentSections(body)
  const operativeText = sections.find(section => section.kind === 'operative')?.text
  if (!operativeText) return undefined

  const passages = rowsOf(row.passages).flatMap<CasePassage>(value => {
    const passage = record(value)
    const locator = textField(passage, 'locator')
    const text = textField(passage, 'text')
    const kind = passage.kind
    return locator && text && (kind === 'reasoning' || kind === 'operative')
      && sections.some(section => section.kind === kind && matchesCaseExcerpt(section.text, text))
      ? [{ kind, locator, text }] : []
  })
  const missingSections = sections.filter(section => !passages.some(passage => passage.kind === section.kind))
  const related_cases = rowsOf(row.related_cases).flatMap<CaseDetail['related_cases'][number]>(value => {
    const related = record(value)
    const number = textField(related, 'case_number')
    const relation = related.relation
    return number && isValidCaseNumber(number) && normalizeCaseNumber(number) !== normalizeCaseNumber(entry.case_number)
      && (relation === 'prior' || relation === 'appeal' || relation === 'retrial')
      && confirmsCaseRelation(body, number, relation) ? [{ case_number: number, relation }] : []
  })
  const effect = row.effect === 'effective' || row.effect === 'pending' || row.effect === 'vacated' || row.effect === 'amended' ? row.effect : 'unknown'
  return { ...entry, url: entry.url, body, operativeText, passages: [...passages, ...missingSections], effect, related_cases,
    name: textField(row, 'name'), court: textField(row, 'court'), judgment_date: textField(row, 'judgment_date'),
    effective_date: textField(row, 'effective_date'), cause: textField(row, 'cause'), level: textField(row, 'level'),
    party_roles: strings(row.party_roles), key_facts: strings(row.key_facts), issues: strings(row.issues),
    legal_relationship: textField(row, 'legal_relationship'), rules: strings(row.rules), procedure: textField(row, 'procedure'),
    referenced_statutes: strings(row.referenced_statutes), relies_on_repealed_law: row.relies_on_repealed_law === true,
  }
}

export function createLegalCaseAdapter(provider: string, transport: Transport) {
  async function call(request: CaseProviderRequest, signal?: AbortSignal) {
    signal?.throwIfAborted()
    try {
      const response = record(await transport(request, signal))
      signal?.throwIfAborted()
      const outcome = response.outcome
      if (outcome === 'authoritative-not-found' || outcome === 'timeout' || outcome === 'forbidden' || outcome === 'unavailable'
        || outcome === 'not-queried' || outcome === 'unverified-detail' || outcome === 'identity-mismatch' || outcome === 'conflicting-detail') return { outcome, rows: [] } as const
      return { outcome: Array.isArray(response.items) ? 'received' : 'empty-response', rows: rowsOf(response.items) } as const
    } catch (error) {
      signal?.throwIfAborted()
      const { name, status } = record(error)
      return { outcome: name === 'TimeoutError' ? 'timeout' : status === 401 || status === 403 ? 'forbidden' : 'unavailable', rows: [] } as const
    }
  }
  return {
    async search(request: CaseSearchRequest, signal?: AbortSignal) {
      const { outcome, rows } = await call(request, signal)
      const items = rows.map(candidate).filter(item => item !== undefined)
      return { provider, outcome: outcome === 'received' || outcome === 'authoritative-not-found'
        ? items.length ? 'found' : 'no-candidates' : outcome, items }
    },
    async detail(locator: { id?: string; case_number: string }, signal?: AbortSignal): Promise<CaseDetailResult> {
      const { outcome, rows } = await call({ action: 'detail', ...(locator.id ? { id: locator.id } : { case_number: locator.case_number }) }, signal)
      const trace = { provider, checkedAt: new Date().toISOString() }
      if (outcome !== 'received') return { ...trace, outcome }
      if (!rows.length) return { ...trace, outcome: 'empty-response' }
      const item = rows.length === 1 ? detail(rows[0]) : undefined
      if (!item) return { ...trace, outcome: 'unverified-detail' }
      if ((locator.id && item.id !== locator.id) || normalizeCaseNumber(item.case_number) !== normalizeCaseNumber(locator.case_number)) {
        return { ...trace, outcome: 'identity-mismatch' }
      }
      return { ...trace, outcome: 'found', item }
    },
  }
}
