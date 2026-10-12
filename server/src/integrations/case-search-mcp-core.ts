import type { KnowledgeCase, KnowledgeCaseExcerpt } from '../domain.js'

type JsonRpcRequest = {
  jsonrpc: '2.0'
  id?: string
  method: string
  params?: Record<string, unknown>
}

type McpToolDescriptor = {
  name: string
  inputSchema?: {
    type?: string
    properties?: Record<string, { type?: string }>
  }
}

type JsonRpcEnvelope<T> = {
  jsonrpc?: '2.0'
  id?: string | number | null
  result?: T
  error?: {
    code?: number
    message?: string
  }
}

type ToolCallResult = {
  structuredContent?: unknown
  content?: unknown[]
}

type CaseFieldAliasKey =
  | 'externalId'
  | 'title'
  | 'caseNumber'
  | 'courtName'
  | 'courtLevel'
  | 'region'
  | 'trialLevel'
  | 'caseType'
  | 'cause'
  | 'judgmentDate'
  | 'effectiveDate'
  | 'issueSummary'
  | 'holdingSummary'
  | 'reasoningSummary'
  | 'resultSummary'
  | 'sourceUrl'
  | 'focusTags'
  | 'referencedStatutes'
  | 'keywords'
  | 'factSummary'
  | 'excerptSummary'

export interface CaseSearchMcpProviderConfig {
  providerId: string
  providerName: string
  sourceType: string
  apiKey?: string
  mcpUrl?: string
  defaultMcpUrl?: string
  configuredTool?: string
  searchToolCandidates: readonly string[]
  preferredQueryKey?: string
  staticArguments?: Record<string, unknown>
  aliases?: Partial<Record<CaseFieldAliasKey, string[]>>
}

const MCP_PROTOCOL_VERSION = '2024-11-05'
const sessionCache = new Map<string, string>()
const initializedProviders = new Set<string>()
const toolCache = new Map<string, McpToolDescriptor[]>()

const DEFAULT_FIELD_ALIASES: Record<CaseFieldAliasKey, string[]> = {
  externalId: ['id', 'case_id', 'doc_id', 'gid', 'uuid', 'wenshu_id', 'scid', 'documentId'],
  title: ['title', 'name', 'case_title', 'ajmc', 'bt', '案件名称'],
  caseNumber: ['caseNumber', 'case_number', 'documentNumber', 'ah', '案号'],
  courtName: ['courtName', 'court_name', 'courthouse_name', 'courtText', 'fymc', '法院名称'],
  courtLevel: ['courtLevel', 'court_level', 'fyjb'],
  region: ['region', 'province', 'fyss', 'courtRegion'],
  trialLevel: ['trialLevel', 'trial_level', 'spcx', 'trial_procedure'],
  caseType: ['caseType', 'case_type', 'doc_type', 'document_type', 'ajlx', 'case_category'],
  cause: ['cause', 'ay', '案由', 'cause_of_action', 'causeOfActionText', 'anyou'],
  judgmentDate: ['judgmentDate', 'judgment_date', 'cprq', '裁判日期', 'decision_date', 'decisionDate'],
  effectiveDate: ['effectiveDate', 'effective_date', 'scrq'],
  issueSummary: ['issueSummary', '争议焦点', '争议问题', 'core_issue', 'semanticHighlight'],
  holdingSummary: ['holdingSummary', '裁判要旨', '裁判观点', 'judgment_summary', 'content'],
  reasoningSummary: ['reasoningSummary', '裁判理由', 'reasoning', 'courtOpinion', '本院认为'],
  resultSummary: ['resultSummary', '判决结果', 'result', 'judgedResultDatabase', '判决主文'],
  sourceUrl: ['sourceUrl', 'url', 'link', 'detail_url', '详情链接', 'source'],
  focusTags: ['focusTags', 'focus_tags', '争议标签', 'tags'],
  referencedStatutes: ['referencedStatutes', 'laws', 'legal_basis', '关联法条'],
  keywords: ['keywords', '关键字'],
  factSummary: ['caseFactSummary', '案情摘要', 'ascertain', '本院查明', '事实摘要'],
  excerptSummary: ['snippet', 'summary', '摘要'],
}

function createRequestId(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`
}

function sanitizeStableId(seed: string) {
  const normalized = seed.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '')
  return normalized || Math.random().toString(36).slice(2, 10)
}

function uniqueStrings(items: string[], limit = items.length) {
  return Array.from(new Set(items.map((item) => item.trim()).filter(Boolean))).slice(0, limit)
}

function resolveAliases(config: CaseSearchMcpProviderConfig, key: CaseFieldAliasKey) {
  return config.aliases?.[key]?.length ? config.aliases[key] as string[] : DEFAULT_FIELD_ALIASES[key]
}

function firstString(input: unknown, aliases: string[]) {
  if (!input || typeof input !== 'object') {
    return ''
  }

  const record = input as Record<string, unknown>
  for (const alias of aliases) {
    const value = record[alias]
    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value)
    }
  }

  return ''
}

function firstStringArray(input: unknown, aliases: string[]) {
  if (!input || typeof input !== 'object') {
    return []
  }

  const record = input as Record<string, unknown>
  for (const alias of aliases) {
    const value = record[alias]
    if (Array.isArray(value)) {
      return value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean)
    }
    if (typeof value === 'string' && value.trim()) {
      return value
        .split(/[、,，;；\n]/)
        .map((item) => item.trim())
        .filter(Boolean)
    }
  }

  return []
}

function parseJsonPayload(value: string) {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function parseRpcResponse<T>(payload: string): T {
  const text = payload.trim()
  if (!text) {
    return {} as T
  }

  const direct = parseJsonPayload(text) as JsonRpcEnvelope<T> | null
  if (direct) {
    if (direct.error?.message) {
      throw new Error(direct.error.message)
    }
    return (direct.result ?? direct) as T
  }

  const dataLines = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter(Boolean)

  for (let index = dataLines.length - 1; index >= 0; index -= 1) {
    const parsed = parseJsonPayload(dataLines[index]) as JsonRpcEnvelope<T> | null
    if (!parsed) {
      continue
    }
    if (parsed.error?.message) {
      throw new Error(parsed.error.message)
    }
    return (parsed.result ?? parsed) as T
  }

  throw new Error('MCP 返回结果无法解析。')
}

function flattenCandidateObjects(input: unknown): Record<string, unknown>[] {
  if (!input) {
    return []
  }

  if (Array.isArray(input)) {
    return input.flatMap((item) => flattenCandidateObjects(item))
  }

  if (typeof input !== 'object') {
    return []
  }

  const record = input as Record<string, unknown>
  const arrayKeys = ['items', 'results', 'list', 'records', 'data', 'cases', 'hits', 'document', 'documents']

  for (const key of arrayKeys) {
    if (Array.isArray(record[key])) {
      return flattenCandidateObjects(record[key])
    }
  }

  for (const key of ['results', 'result', 'payload']) {
    if (record[key] && typeof record[key] === 'object') {
      return flattenCandidateObjects(record[key])
    }
  }

  return [record]
}

function extractToolPayload(result: ToolCallResult) {
  const buckets: Record<string, unknown>[] = []

  if (result.structuredContent) {
    buckets.push(...flattenCandidateObjects(result.structuredContent))
  }

  for (const item of result.content ?? []) {
    if (typeof item === 'string') {
      const parsed = parseJsonPayload(item)
      buckets.push(...flattenCandidateObjects(parsed ?? item))
      continue
    }

    if (item && typeof item === 'object') {
      const record = item as Record<string, unknown>
      if (record.type === 'text' && typeof record.text === 'string') {
        const parsed = parseJsonPayload(record.text)
        buckets.push(...flattenCandidateObjects(parsed ?? record.text))
        continue
      }

      buckets.push(...flattenCandidateObjects(record))
    }
  }

  return buckets
}

function normalizeDate(value: string) {
  const trimmed = value.trim()
  if (!trimmed) {
    return ''
  }

  if (/^\d{8}$/.test(trimmed)) {
    return `${trimmed.slice(0, 4)}-${trimmed.slice(4, 6)}-${trimmed.slice(6, 8)}T00:00:00.000Z`
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return `${trimmed}T00:00:00.000Z`
  }

  return trimmed
}

function buildExcerpt(caseId: string, seed: string, locator: string, excerptType: KnowledgeCaseExcerpt['excerptType']) {
  return {
    id: `excerpt-${sanitizeStableId(`${caseId}-${excerptType}-${seed}`)}`,
    caseId,
    excerptType,
    locator,
    content: seed,
    summary: seed.slice(0, 120),
    keywords: uniqueStrings(seed.split(/[，。；、,\s]/).filter((item) => item.length >= 2), 6),
  } satisfies KnowledgeCaseExcerpt
}

function normalizeCaseItem(config: CaseSearchMcpProviderConfig, item: Record<string, unknown>) {
  const externalId = firstString(item, resolveAliases(config, 'externalId'))
  const title = firstString(item, resolveAliases(config, 'title'))
    || firstString(item, resolveAliases(config, 'caseNumber'))

  if (!title) {
    return null
  }

  const caseNumber = firstString(item, resolveAliases(config, 'caseNumber')) || '案号待补充'
  const courtName = firstString(item, resolveAliases(config, 'courtName')) || `${config.providerName}判例库`
  const courtLevel = firstString(item, resolveAliases(config, 'courtLevel')) || '未标注'
  const region = firstString(item, resolveAliases(config, 'region')) || '未标注'
  const trialLevel = firstString(item, resolveAliases(config, 'trialLevel')) || '未标注'
  const caseType = firstString(item, resolveAliases(config, 'caseType')) || '裁判文书'
  const cause = firstString(item, resolveAliases(config, 'cause'))
    || firstStringArray(item, resolveAliases(config, 'cause')).join('、')
    || '未标注案由'
  const judgmentDate = normalizeDate(firstString(item, resolveAliases(config, 'judgmentDate'))) || new Date().toISOString()
  const effectiveDate = firstString(item, resolveAliases(config, 'effectiveDate')) || judgmentDate
  const factSummary = firstString(item, resolveAliases(config, 'factSummary'))
  const issueSummary = firstString(item, resolveAliases(config, 'issueSummary'))
  const holdingSummary = firstString(item, resolveAliases(config, 'holdingSummary'))
  const reasoningSummary = firstString(item, resolveAliases(config, 'reasoningSummary'))
  const resultSummary = firstString(item, resolveAliases(config, 'resultSummary'))
  const sourceUrl = firstString(item, resolveAliases(config, 'sourceUrl')) || undefined
  const focusTags = uniqueStrings(firstStringArray(item, resolveAliases(config, 'focusTags')), 8)
  const referencedStatutes = uniqueStrings(firstStringArray(item, resolveAliases(config, 'referencedStatutes')), 8)
  const keywords = uniqueStrings([
    title,
    caseNumber,
    courtName,
    cause,
    ...focusTags,
    ...referencedStatutes,
    ...firstStringArray(item, resolveAliases(config, 'keywords')),
  ], 12)

  const caseId = `knowledge-case-${config.providerId}-${sanitizeStableId(externalId || `${title}-${caseNumber}`)}`
  const excerptSeeds = uniqueStrings([
    holdingSummary,
    reasoningSummary,
    issueSummary,
    factSummary,
    resultSummary,
    firstString(item, resolveAliases(config, 'excerptSummary')),
  ], 3)

  return {
    id: caseId,
    title,
    caseNumber,
    courtName,
    courtLevel,
    region,
    trialLevel,
    caseType,
    cause,
    judgmentDate,
    effectiveDate,
    issueSummary: issueSummary || factSummary || holdingSummary || `${config.providerName} 返回了相关案例，待进一步补充争议焦点。`,
    holdingSummary: holdingSummary || reasoningSummary || factSummary || `${config.providerName} 返回了相关裁判要旨。`,
    reasoningSummary: reasoningSummary || holdingSummary || factSummary || `${config.providerName} 返回了相关裁判理由。`,
    resultSummary: resultSummary || holdingSummary || `${config.providerName} 返回了相关判例结果摘要。`,
    sourceUrl,
    sourceType: config.sourceType,
    keywords,
    focusTags,
    referencedStatutes,
    excerpts: excerptSeeds.length
      ? excerptSeeds.map((seed, index) => buildExcerpt(caseId, seed, `${config.providerName}摘要 ${index + 1}`, index === 0 ? 'holding' : 'reasoning'))
      : [buildExcerpt(caseId, holdingSummary || factSummary || title, `${config.providerName}摘要 1`, 'holding')],
  } satisfies KnowledgeCase
}

function resolveMcpUrl(config: CaseSearchMcpProviderConfig) {
  return config.mcpUrl?.trim() || config.defaultMcpUrl?.trim() || ''
}

async function postRpc<T>(config: CaseSearchMcpProviderConfig, request: JsonRpcRequest) {
  const mcpUrl = resolveMcpUrl(config)
  if (!mcpUrl || !config.apiKey?.trim()) {
    throw new Error(`${config.providerName} MCP 未配置。`)
  }

  const headers: Record<string, string> = {
    Accept: 'application/json, text/event-stream',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.apiKey}`,
  }

  const sessionId = sessionCache.get(config.providerId)
  if (sessionId) {
    headers['Mcp-Session-Id'] = sessionId
  }

  const response = await fetch(mcpUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(request),
  })

  if (!response.ok) {
    const message = (await response.text()).trim()
    throw new Error(message || `${config.providerName} MCP 请求失败（${response.status}）。`)
  }

  const nextSessionId = response.headers.get('mcp-session-id') ?? response.headers.get('Mcp-Session-Id')
  if (nextSessionId?.trim()) {
    sessionCache.set(config.providerId, nextSessionId)
  }

  return parseRpcResponse<T>(await response.text())
}

async function ensureInitialized(config: CaseSearchMcpProviderConfig) {
  if (initializedProviders.has(config.providerId)) {
    return
  }

  await postRpc(config, {
    jsonrpc: '2.0',
    id: createRequestId(`${config.providerId}-init`),
    method: 'initialize',
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: 'lawverify',
        version: '0.1.12',
      },
    },
  })

  await postRpc(config, {
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  })

  initializedProviders.add(config.providerId)
}

async function listTools(config: CaseSearchMcpProviderConfig) {
  const cached = toolCache.get(config.providerId)
  if (cached) {
    return cached
  }

  await ensureInitialized(config)
  const result = await postRpc<{ tools?: McpToolDescriptor[] }>(config, {
    jsonrpc: '2.0',
    id: createRequestId(`${config.providerId}-tools`),
    method: 'tools/list',
  })

  const tools = Array.isArray(result.tools) ? result.tools : []
  toolCache.set(config.providerId, tools)
  return tools
}

function pickToolByName(config: CaseSearchMcpProviderConfig, tools: McpToolDescriptor[]) {
  const names = new Set(tools.map((tool) => tool.name))
  const configured = config.configuredTool?.trim()

  if (configured && names.has(configured)) {
    return tools.find((tool) => tool.name === configured) ?? null
  }

  for (const name of config.searchToolCandidates) {
    const matched = tools.find((tool) => tool.name === name)
    if (matched) {
      return matched
    }
  }

  return tools.find((tool) => /case|cases|案例|裁判|qwal/i.test(tool.name)) ?? null
}

function buildToolArguments(tool: McpToolDescriptor, config: CaseSearchMcpProviderConfig, query: string, limit: number) {
  const properties = tool.inputSchema?.properties ?? {}
  const args: Record<string, unknown> = {}
  const assignFirst = (keys: string[], value: unknown) => {
    const matched = keys.find((key) => Object.prototype.hasOwnProperty.call(properties, key))
    if (matched) {
      args[matched] = value
      return true
    }
    return false
  }

  const queryKeys = [
    config.preferredQueryKey ?? '',
    'query',
    'question',
    'text',
    'keyword',
    'keywords',
    'content',
    'q',
    'input',
  ].filter(Boolean)

  const keywordAssigned = assignFirst(queryKeys, query)
  if (!keywordAssigned && !Object.keys(properties).length) {
    args[config.preferredQueryKey ?? 'query'] = query
  }

  assignFirst(['limit', 'top_k', 'topK', 'page_size', 'pageSize', 'size', 'count'], Math.min(Math.max(limit, 1), 10))
  assignFirst(['page', 'page_no', 'pageNo', 'pageNum'], 1)

  for (const [key, value] of Object.entries(config.staticArguments ?? {})) {
    if (!Object.keys(properties).length || Object.prototype.hasOwnProperty.call(properties, key)) {
      args[key] = value
    }
  }

  return args
}

export function createCaseSearchMcpClient(config: CaseSearchMcpProviderConfig) {
  return {
    isConfigured() {
      return Boolean(config.apiKey?.trim() && resolveMcpUrl(config))
    },
    async searchCases(query: string, limit = 5) {
      if (!query.trim() || !config.apiKey?.trim() || !resolveMcpUrl(config)) {
        return [] as KnowledgeCase[]
      }

      const tools = await listTools(config)
      const tool = pickToolByName(config, tools)
      if (!tool) {
        return [] as KnowledgeCase[]
      }

      const result = await postRpc<ToolCallResult>(config, {
        jsonrpc: '2.0',
        id: createRequestId(`${config.providerId}-cases`),
        method: 'tools/call',
        params: {
          name: tool.name,
          arguments: buildToolArguments(tool, config, query, limit),
        },
      })

      return extractToolPayload(result)
        .flatMap((item) => {
          const normalized = normalizeCaseItem(config, item)
          return normalized ? [normalized] : []
        })
        .slice(0, limit)
    },
  }
}
