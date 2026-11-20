import { normalizeCaseNumber } from '../intelligence/legal-verification.js'
import { judgmentPlainText, readCaseJudgmentText } from '../intelligence/official-case-verification.js'
import { calendarDay } from '../intelligence/verification/statute-effect.js'
import { createLegalCaseAdapter } from './legal-case.js'
import { usableYuandianUrl, yuandianToolPayload } from './yuandian-statute.js'

type CallTool = (name: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>
const record = (value: unknown) => value && typeof value === 'object' ? value as Record<string, unknown> : {}
const text = (value: Record<string, unknown>, ...keys: string[]) => keys.map(key => value[key]).find(item => typeof item === 'string' && item.trim()) as string | undefined

function identity(value: unknown) {
  const item = record(value)
  return { id: text(item, 'case_id', 'scid', 'id', 'doc_id', 'wenshu_id'), case_number: text(item, 'case_number', 'caseNumber', 'ah'),
    url: usableYuandianUrl(item) }
}

export function createYuandianCaseAdapter(callTool: CallTool) {
  return createLegalCaseAdapter('yuandian-mcp', async (query, signal) => {
    const name = query.action === 'detail' ? 'yuandian_get_case_detail'
      : query.action === 'keyword' ? 'yuandian_search_judicial_cases' : 'yuandian_semantic_search_cases'
    const args = query.action === 'detail' ? ('id' in query ? { case_id: query.id } : { case_number: query.case_number })
      : query.action === 'keyword' ? { case_number: query.case_number, top_k: 6 }
        : { query: query.query, limit: query.top_k ?? 6, rewrite_enabled: false }
    const result = record(await callTool(name, args, signal))
    const body = yuandianToolPayload(result)
    if (result.isError === true || body.success === false) {
      const blocked = /暂停[^。；]{0,24}权限|无权限|未授权|权限不足|forbidden|unauthorized/iu.test(text(body, 'message', 'status') ?? '')
      return { outcome: blocked ? 'forbidden' : 'unavailable' }
    }
    if (body.success !== true) return { outcome: 'empty-response' }
    if (query.action !== 'detail') {
      const data = body.result ?? body.results ?? body.data
      const index = record(data)
      const rows = Array.isArray(data) ? data : index.lst ?? index.document ?? index.case_document_list ?? index.cases ?? index.items
      return { items: Array.isArray(rows) ? rows.map(identity) : [] }
    }
    const rows = (Array.isArray(body.data) ? body.data : body.data ? [body.data] : []).map(record)
      .filter(row => { const { id, case_number } = identity(row); return id && case_number })
    const matches = rows.filter(row => {
      const candidate = identity(row)
      return 'id' in query ? candidate.id === query.id : candidate.case_number
        && normalizeCaseNumber(candidate.case_number) === normalizeCaseNumber(query.case_number)
    })
    if (!rows.length) return { outcome: 'unverified-detail' }
    if (!matches.length) return { outcome: 'identity-mismatch' }
    if (matches.length !== 1) return { outcome: 'conflicting-detail' }
    const [item] = matches
    const ids = identity(item)
    const fullText = text(item, 'full_text', 'full_content', 'document_content', 'body', 'content')
    if (!ids.case_number || !fullText || !ids.url) return { outcome: 'unverified-detail' }
    const parsed = readCaseJudgmentText(judgmentPlainText(fullText), 'case_number' in query ? query.case_number : ids.case_number)
    if (parsed.outcome !== 'found') return { outcome: parsed.outcome }
    const kind = text(item, 'case_kind', 'type')
    const level = text(item, 'authoritative_case_source', 'case_source', 'level') ?? (kind === 'ptal' || kind === '普通案例' ? 'ordinary' : parsed.item.level)
    const status = text(item, 'effect', 'effect_status', 'validity_status')
    const effect = status === '已撤销' || status === 'vacated' ? 'vacated' : status === '已改判' || status === 'amended' ? 'amended'
      : status === '未生效' || status === 'pending' ? 'pending' : status === '已生效' || status === 'effective' ? 'effective' : parsed.item.effect
    const date = calendarDay(text(item, 'decision_date', 'judgment_date'))
    const [singleCause] = Array.isArray(item.cause_of_action) && item.cause_of_action.length === 1 ? item.cause_of_action : []
    return { items: [{ ...ids, ...parsed.item, name: parsed.item.name ?? text(item, 'case_title', 'title', 'name'),
      judgment_date: parsed.item.judgment_date ?? (date === undefined ? undefined : new Date(date).toISOString().slice(0, 10)),
      cause: parsed.item.cause ?? text(item, 'cause_of_action', 'cause') ?? (typeof singleCause === 'string' ? singleCause : undefined), level, effect }] }
  })
}
