import { isPlaceholderStatuteContent } from '../intelligence/statute-version.js'

type SearchRequest = { action: 'semantic'; query: string; refer_date?: string; top_k?: number }
  | { action: 'search_article'; law_name: string; article_number: string; refer_date?: string }
type DetailRequest = { action: 'article_detail'; refer_date?: string }
  & ({ id: string } | { law_name: string; article_number: string })
type Transport = (request: SearchRequest | DetailRequest, signal?: AbortSignal) => Promise<unknown>

type Candidate = { id: string; law_name: string; article_number: string }
type Detail = Candidate & { text: string; url: string; validity: string } & Partial<Record<
  'effective_date' | 'repeal_date' | 'version' | 'issuer' | 'doc_type' | 'region' | 'publish_date' | 'checked_at' | 'transition_note', string
>>
type Failure = 'timeout' | 'forbidden' | 'unavailable' | 'empty-response'
export type StatuteDetailResult = { outcome: 'found'; item: Detail; checkedAt: string }
  | { outcome: Failure | 'authoritative-not-found' | 'unverified-detail'; checkedAt: string }

const record = (value: unknown) => value && typeof value === 'object' ? value as Record<string, unknown> : {}
const field = (item: Record<string, unknown>, key: string) => typeof item[key] === 'string' ? item[key].trim() : ''

function candidate(value: unknown): Candidate | undefined {
  const row = record(value)
  const id = field(row, 'id')
  const law_name = field(row, 'law_name')
  const article_number = field(row, 'article_number')
  if (id && law_name && article_number) return { id, law_name, article_number }
}

function detail(value: unknown): Detail | undefined {
  const identity = candidate(value)
  const row = record(value)
  const text = typeof row.text === 'string' ? row.text : ''
  const url = field(row, 'url')
  const validity = field(row, 'validity')
  const source = URL.canParse(url) ? new URL(url) : undefined
  if (!identity || !validity || isPlaceholderStatuteContent(text) || !source || source.protocol !== 'https:'
    || source.username || source.password || (source.pathname === '/' && !source.search)) return

  const metadata = Object.fromEntries([
    'effective_date', 'repeal_date', 'version', 'issuer', 'doc_type', 'region', 'publish_date', 'checked_at', 'transition_note',
  ].map(key => [key, field(row, key)]).filter(([, value]) => value))
  return { ...identity, text, url, validity, ...metadata }
}

export function createLegalStatuteAdapter(transport: Transport, options: { datedDetailByName?: boolean } = {}) {
  async function call(request: SearchRequest | DetailRequest, signal?: AbortSignal) {
    signal?.throwIfAborted()
    try {
      const response = record(await transport(request, signal))
      signal?.throwIfAborted()
      const outcome = response.outcome
      if (outcome === 'timeout' || outcome === 'forbidden' || outcome === 'unavailable' || outcome === 'authoritative-not-found' || outcome === 'unverified-detail') {
        return { outcome, rows: [] } as const
      }
      return { outcome: Array.isArray(response.items) ? 'received' : 'empty-response', rows: Array.isArray(response.items) ? response.items : [] } as const
    } catch (error) {
      signal?.throwIfAborted()
      const { name, status } = record(error)
      return { outcome: name === 'TimeoutError' ? 'timeout' : status === 401 || status === 403 ? 'forbidden' : 'unavailable', rows: [] } as const
    }
  }

  return {
    datedDetailByName: options.datedDetailByName === true,
    async search(request: SearchRequest, signal?: AbortSignal) {
      const { outcome, rows } = await call(request, signal)
      const items = rows.map(candidate).filter(item => item !== undefined)
      return { outcome: outcome === 'received' || outcome === 'authoritative-not-found' ? items.length ? 'found' : 'no-candidates' : outcome, items }
    },
    async detail(locator: { law_name: string; article_number: string; id?: string; refer_date?: string }, signal?: AbortSignal): Promise<StatuteDetailResult> {
      const { id, law_name, article_number, refer_date } = locator
      const lookupId = refer_date && options.datedDetailByName ? undefined : id
      const request = { action: 'article_detail' as const, ...(refer_date && { refer_date }), ...(lookupId ? { id: lookupId } : { law_name, article_number }) }
      const { outcome, rows } = await call(request, signal)
      const checkedAt = new Date().toISOString()
      if (outcome !== 'received') return { outcome, checkedAt }
      if (!rows.length) return { outcome: 'empty-response', checkedAt }
      const item = rows.length === 1 ? detail(rows[0]) : undefined
      return item && (!lookupId || item.id === lookupId) ? { outcome: 'found', item, checkedAt } : { outcome: 'unverified-detail', checkedAt }
    },
  }
}
