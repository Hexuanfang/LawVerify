import { createLegalStatuteAdapter } from './legal-statute.js'

const tools = {
  semantic: 'yuandian_semantic_search_legal_articles',
  search_article: 'yuandian_search_legal_articles',
  article_detail: 'yuandian_get_legal_article_detail',
} as const
type CallTool = (name: typeof tools[keyof typeof tools], args: Record<string, string | number | boolean>, signal?: AbortSignal) => Promise<unknown>

const record = (value: unknown) => value && typeof value === 'object' ? value as Record<string, unknown> : {}
const field = (item: Record<string, unknown>, key: string) => typeof item[key] === 'string' ? item[key].trim() : ''

export function yuandianToolPayload(result: Record<string, unknown>) {
  if (result.structuredContent) return record(result.structuredContent)
  for (const block of Array.isArray(result.content) ? result.content : []) {
    const text = field(record(block), 'text')
    if (text) {
      try { return record(JSON.parse(text)) } catch { /* 自然语言摘要不参与详情判定。 */ }
    }
  }
  return {}
}

function identity(value: unknown) {
  const item = record(value)
  const number = field(item, 'article_number') || field(item, 'number')
  const digits = /^(\d+)(?:\.(\d+))?$/u.exec(number)
  const article_number = digits ? `第${digits[1]}条${digits[2] ? `之${digits[2]}` : ''}` : number
  return { id: field(item, 'article_id'), law_name: field(item, 'regulation_name'), article_number }
}

export function usableYuandianUrl(item: Record<string, unknown>) {
  const url = field(item, 'url')
  const access = field(item, 'share_access')
  if (!URL.canParse(url) || field(item, 'share_expires_at') || /private|restricted|temporary/iu.test(access)) return undefined
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || [...parsed.searchParams.keys()]
    .some(key => /token|secret|key|auth|sign|credential|expire|session/iu.test(key))) return undefined
  return url
}

function detail(value: unknown) {
  const item = record(value)
  return { ...identity(item), text: typeof item.content === 'string' ? item.content : undefined, url: usableYuandianUrl(item),
    validity: field(item, 'validity_status'), effective_date: field(item, 'effective_date'), publish_date: field(item, 'publication_date'),
    repeal_date: field(item, 'repeal_date') || field(item, 'expiration_date'), issuer: field(item, 'issuing_authority'),
    region: field(item, 'region'), transition_note: field(item, 'transition_note'), version: field(item, 'regulation_id'),
    doc_type: field(item, 'secondary_effect_level') || field(item, 'primary_effect_level') }
}

export function createYuandianStatuteAdapter(callTool: CallTool) {
  return createLegalStatuteAdapter(async (request, signal) => {
    const args: Record<string, string | number | boolean> = request.action === 'semantic' ? { query: request.query, limit: request.top_k ?? 5, rewrite_enabled: false }
      : request.action === 'search_article' ? { regulation_name: request.law_name, keyword: request.article_number, top_k: 5 }
      : 'id' in request ? { article_id: request.id }
      : { regulation_name: request.law_name, article_number: request.article_number, ...(request.refer_date && { reference_date: request.refer_date }) }
    const result = record(await callTool(tools[request.action], args, signal))
    const body = yuandianToolPayload(result)
    if (result.isError === true || body.success === false) {
      const blocked = /(?:暂停[^。；]{0,24}权限|无权限|未授权|权限不足|forbidden|unauthorized|^403$)/iu.test(`${field(body, 'status')} ${field(body, 'message')}`.trim())
      return { outcome: blocked ? 'forbidden' : 'unavailable' }
    }
    if (body.success !== true) return { outcome: 'empty-response' }
    if (request.action === 'article_detail') {
      if (body.data) return { items: [detail(body.data)] }
      return { outcome: !('id' in request) && field(body, 'message') === '未查询到相关内容'
        ? 'authoritative-not-found' : 'empty-response' }
    }
    const rows = request.action === 'semantic' ? record(body.results).law_article_list : body.results
    return { items: Array.isArray(rows) ? rows.map(identity) : [] }
  }, { datedDetailByName: true })
}
