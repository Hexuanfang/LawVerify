import { env } from '../config/env.js';
const MCP_PROTOCOL_VERSION = '2024-11-05';
const DEFAULT_YUANDIAN_MCP_URL = 'https://open.chineselaw.com/mcp';
const SEARCH_TOOL_CANDIDATES = [
    'yuandian_semantic_search_cases',
    'yuandian_case_vector_search__v2',
    'yuandian_rh_qwal_search__v3',
    'yuandian_search_authoritative_cases',
];
let cachedSessionId = null;
let initialized = false;
let cachedTools = null;
function createRequestId(prefix) {
    return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}
function sanitizeStableId(seed) {
    const normalized = seed.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '');
    return normalized || Math.random().toString(36).slice(2, 10);
}
function uniqueStrings(items, limit = items.length) {
    return Array.from(new Set(items.map((item) => item.trim()).filter(Boolean))).slice(0, limit);
}
function firstString(input, aliases) {
    if (!input || typeof input !== 'object') {
        return '';
    }
    const record = input;
    for (const alias of aliases) {
        const value = record[alias];
        if (typeof value === 'string' && value.trim()) {
            return value.trim();
        }
        if (typeof value === 'number' && Number.isFinite(value)) {
            return String(value);
        }
    }
    return '';
}
function firstStringArray(input, aliases) {
    if (!input || typeof input !== 'object') {
        return [];
    }
    const record = input;
    for (const alias of aliases) {
        const value = record[alias];
        if (Array.isArray(value)) {
            return value.filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean);
        }
        if (typeof value === 'string' && value.trim()) {
            return value
                .split(/[、,，;；\n]/)
                .map((item) => item.trim())
                .filter(Boolean);
        }
    }
    return [];
}
function pickToolByName(tools) {
    const names = new Set(tools.map((tool) => tool.name));
    const configured = env.YUANDIAN_CASE_SEARCH_TOOL?.trim();
    if (configured && names.has(configured)) {
        return tools.find((tool) => tool.name === configured) ?? null;
    }
    for (const name of SEARCH_TOOL_CANDIDATES) {
        const matched = tools.find((tool) => tool.name === name);
        if (matched) {
            return matched;
        }
    }
    return tools.find((tool) => /case|cases|案例|裁判|qwal/i.test(tool.name)) ?? null;
}
function buildToolArguments(tool, query, limit) {
    const properties = tool.inputSchema?.properties ?? {};
    const args = {};
    const assignFirst = (keys, value) => {
        const matched = keys.find((key) => Object.prototype.hasOwnProperty.call(properties, key));
        if (matched) {
            args[matched] = value;
            return true;
        }
        return false;
    };
    const keywordAssigned = assignFirst(['query', 'keyword', 'keywords', 'question', 'text', 'content', 'q', 'input'], query);
    if (!keywordAssigned && !Object.keys(properties).length) {
        args.query = query;
    }
    assignFirst(['limit', 'top_k', 'topK', 'page_size', 'pageSize', 'size'], limit);
    assignFirst(['page', 'page_no', 'pageNo', 'pageNum'], 1);
    return args;
}
function parseJsonPayload(value) {
    try {
        return JSON.parse(value);
    }
    catch {
        return null;
    }
}
function parseRpcResponse(payload) {
    const text = payload.trim();
    if (!text) {
        return {};
    }
    const direct = parseJsonPayload(text);
    if (direct) {
        if (direct.error?.message) {
            throw new Error(direct.error.message);
        }
        return (direct.result ?? direct);
    }
    const dataLines = text
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .filter(Boolean);
    for (let index = dataLines.length - 1; index >= 0; index -= 1) {
        const parsed = parseJsonPayload(dataLines[index]);
        if (!parsed) {
            continue;
        }
        if (parsed.error?.message) {
            throw new Error(parsed.error.message);
        }
        return (parsed.result ?? parsed);
    }
    throw new Error('元典 MCP 返回结果无法解析。');
}
async function postRpc(request) {
    const headers = {
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.YUANDIAN_API_KEY}`,
    };
    if (cachedSessionId) {
        headers['Mcp-Session-Id'] = cachedSessionId;
    }
    const response = await fetch(env.YUANDIAN_MCP_URL ?? DEFAULT_YUANDIAN_MCP_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify(request),
    });
    if (!response.ok) {
        const message = (await response.text()).trim();
        throw new Error(message || `元典 MCP 请求失败（${response.status}）。`);
    }
    cachedSessionId = response.headers.get('mcp-session-id')
        ?? response.headers.get('Mcp-Session-Id')
        ?? cachedSessionId;
    return parseRpcResponse(await response.text());
}
async function ensureInitialized() {
    if (initialized) {
        return;
    }
    await postRpc({
        jsonrpc: '2.0',
        id: createRequestId('yuandian-init'),
        method: 'initialize',
        params: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: {
                name: 'lawverify',
                version: '0.0.1',
            },
        },
    });
    await postRpc({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
    });
    initialized = true;
}
async function listTools() {
    if (cachedTools) {
        return cachedTools;
    }
    await ensureInitialized();
    const result = await postRpc({
        jsonrpc: '2.0',
        id: createRequestId('yuandian-tools'),
        method: 'tools/list',
    });
    cachedTools = Array.isArray(result.tools) ? result.tools : [];
    return cachedTools;
}
function flattenCandidateObjects(input) {
    if (!input) {
        return [];
    }
    if (Array.isArray(input)) {
        return input.flatMap((item) => flattenCandidateObjects(item));
    }
    if (typeof input !== 'object') {
        return [];
    }
    const record = input;
    const arrayKeys = ['items', 'results', 'list', 'records', 'data', 'cases', 'hits', 'document', 'documents'];
    for (const key of arrayKeys) {
        if (Array.isArray(record[key])) {
            return flattenCandidateObjects(record[key]);
        }
    }
    for (const key of ['results', 'result', 'payload']) {
        if (record[key] && typeof record[key] === 'object') {
            return flattenCandidateObjects(record[key]);
        }
    }
    return [record];
}
function normalizeYuandianDate(value) {
    const trimmed = value.trim();
    if (!trimmed) {
        return '';
    }
    if (/^\d{8}$/.test(trimmed)) {
        return `${trimmed.slice(0, 4)}-${trimmed.slice(4, 6)}-${trimmed.slice(6, 8)}T00:00:00.000Z`;
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
        return `${trimmed}T00:00:00.000Z`;
    }
    return trimmed;
}
function extractToolPayload(result) {
    const buckets = [];
    if (result.structuredContent) {
        buckets.push(...flattenCandidateObjects(result.structuredContent));
    }
    for (const item of result.content ?? []) {
        if (typeof item === 'string') {
            const parsed = parseJsonPayload(item);
            buckets.push(...flattenCandidateObjects(parsed ?? item));
            continue;
        }
        if (item && typeof item === 'object') {
            const record = item;
            if (record.type === 'text' && typeof record.text === 'string') {
                const parsed = parseJsonPayload(record.text);
                buckets.push(...flattenCandidateObjects(parsed ?? record.text));
                continue;
            }
            buckets.push(...flattenCandidateObjects(record));
        }
    }
    return buckets;
}
function buildExcerpt(caseId, seed, locator, excerptType) {
    return {
        id: `excerpt-${sanitizeStableId(`${caseId}-${excerptType}-${seed}`)}`,
        caseId,
        excerptType,
        locator,
        content: seed,
        summary: seed.slice(0, 120),
        keywords: uniqueStrings(seed.split(/[，。；、,\s]/).filter((item) => item.length >= 2), 6),
    };
}
function normalizeCaseItem(item) {
    const externalId = firstString(item, ['id', 'case_id', 'doc_id', 'gid', 'uuid', 'wenshu_id', 'scid']);
    const title = firstString(item, ['title', 'name', 'case_title', 'ajmc', 'bt', '案件名称'])
        || firstString(item, ['case_number', 'caseNumber', 'ah', '案号']);
    if (!title) {
        return null;
    }
    const caseNumber = firstString(item, ['caseNumber', 'case_number', 'ah', '案号']) || '案号待补充';
    const courtName = firstString(item, ['courtName', 'court_name', 'fymc', '法院名称']) || '元典判例库';
    const courtLevel = firstString(item, ['courtLevel', 'court_level', 'fyjb']) || '未标注';
    const region = firstString(item, ['region', 'province', 'fyss']) || '未标注';
    const trialLevel = firstString(item, ['trialLevel', 'trial_level', 'spcx', 'trial_procedure']) || '未标注';
    const caseType = firstString(item, ['caseType', 'case_type', 'ajlx', 'case_category', 'document_type']) || '裁判文书';
    const cause = firstString(item, ['cause', 'ay', '案由'])
        || firstStringArray(item, ['anyou', 'cause_of_action']).join('、')
        || '未标注案由';
    const judgmentDate = normalizeYuandianDate(firstString(item, ['judgmentDate', 'judgment_date', 'cprq', '裁判日期', 'decision_date']))
        || new Date().toISOString();
    const effectiveDate = firstString(item, ['effectiveDate', 'effective_date', 'scrq']) || judgmentDate;
    const issueSummary = firstString(item, ['issueSummary', '争议焦点', '争议问题', 'core_issue', 'summary']);
    const holdingSummary = firstString(item, ['holdingSummary', '裁判要旨', '裁判观点', 'judgment_summary', 'content']);
    const reasoningSummary = firstString(item, ['reasoningSummary', '裁判理由', 'reasoning', '裁判规则', 'content']);
    const resultSummary = firstString(item, ['resultSummary', '判决结果', 'result', '判决主文']);
    const sourceUrl = firstString(item, ['sourceUrl', 'url', 'link', 'detail_url', '详情链接']) || undefined;
    const focusTags = uniqueStrings([
        ...firstStringArray(item, ['focusTags', 'focus_tags', '争议标签', 'tags']),
        firstString(item, ['para_name']),
    ], 8);
    const referencedStatutes = uniqueStrings(firstStringArray(item, ['referencedStatutes', 'laws', 'legal_basis', '关联法条']), 8);
    const keywords = uniqueStrings([
        title,
        caseNumber,
        courtName,
        cause,
        ...focusTags,
        ...referencedStatutes,
        ...firstStringArray(item, ['keywords', '关键字']),
    ], 12);
    const caseId = `knowledge-case-yuandian-${sanitizeStableId(externalId || `${title}-${caseNumber}`)}`;
    const excerptSeeds = uniqueStrings([
        holdingSummary,
        reasoningSummary,
        issueSummary,
        firstString(item, ['snippet', 'summary', '摘要']),
    ], 3);
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
        issueSummary: issueSummary || holdingSummary || '元典 MCP 返回了相关案例，待进一步补充争议焦点。',
        holdingSummary: holdingSummary || reasoningSummary || '元典 MCP 返回了相关裁判要旨。',
        reasoningSummary: reasoningSummary || holdingSummary || '元典 MCP 返回了相关裁判理由。',
        resultSummary: resultSummary || holdingSummary || '元典 MCP 返回了相关判例结果摘要。',
        sourceUrl,
        sourceType: '元典MCP',
        keywords,
        focusTags,
        referencedStatutes,
        excerpts: excerptSeeds.length
            ? excerptSeeds.map((seed, index) => buildExcerpt(caseId, seed, `元典摘要 ${index + 1}`, index === 0 ? 'holding' : 'reasoning'))
            : [buildExcerpt(caseId, holdingSummary || title, '元典摘要 1', 'holding')],
    };
}
export function isYuandianCaseSearchConfigured() {
    return Boolean(env.YUANDIAN_API_KEY?.trim());
}
export async function searchYuandianCases(query, limit = 5) {
    if (!isYuandianCaseSearchConfigured() || !query.trim()) {
        return [];
    }
    const tools = await listTools();
    const tool = pickToolByName(tools);
    if (!tool) {
        return [];
    }
    const result = await postRpc({
        jsonrpc: '2.0',
        id: createRequestId('yuandian-cases'),
        method: 'tools/call',
        params: {
            name: tool.name,
            arguments: buildToolArguments(tool, query, limit),
        },
    });
    return extractToolPayload(result)
        .flatMap((item) => {
        const normalized = normalizeCaseItem(item);
        return normalized ? [normalized] : [];
    })
        .slice(0, limit);
}
