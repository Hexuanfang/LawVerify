import { env } from '../config/env.js';
import { createCaseSearchMcpClient } from './case-search-mcp-core.js';
const wkCaseSearchClient = createCaseSearchMcpClient({
    providerId: 'wk',
    providerName: '威科先行',
    sourceType: '威科MCP',
    apiKey: env.WK_API_KEY,
    mcpUrl: env.WK_MCP_URL,
    defaultMcpUrl: 'https://mcp.wkinfo.com.cn/mcp-servers/integrated/',
    configuredTool: env.WK_CASE_SEARCH_TOOL,
    searchToolCandidates: [
        'search_case',
        'search_case_keyword',
    ],
    preferredQueryKey: 'question',
    staticArguments: {
        output_format: 'json',
    },
    aliases: {
        caseNumber: ['documentNumber', 'caseNumber', 'case_number', 'ah', '案号'],
        courtName: ['courtText', 'courtName', 'court_name', 'courthouse_name', 'fymc', '法院名称'],
        cause: ['causeOfActionText', 'cause', 'cause_of_action', '案由'],
        judgmentDate: ['judgmentDate', 'judgment_date', 'decision_date', 'decisionDate', '裁判日期'],
        factSummary: ['caseFactSummary', '案情摘要', 'ascertain', '本院查明'],
        reasoningSummary: ['courtOpinion', 'reasoningSummary', '裁判理由', '本院认为'],
        resultSummary: ['judgedResultDatabase', 'resultSummary', '判决结果', '判决主文'],
        sourceUrl: ['url', 'sourceUrl', 'link', 'detail_url'],
    },
});
export function isWkCaseSearchConfigured() {
    return wkCaseSearchClient.isConfigured();
}
export function searchWkCases(query, limit = 5) {
    return wkCaseSearchClient.searchCases(query, limit);
}
