import { env } from '../config/env.js';
import { createCaseSearchMcpClient } from './case-search-mcp-core.js';
const pkulawCaseSearchClient = createCaseSearchMcpClient({
    providerId: 'pkulaw',
    providerName: '北大法宝',
    sourceType: '北大法宝MCP',
    apiKey: env.PKULAW_API_KEY,
    mcpUrl: env.PKULAW_MCP_URL,
    configuredTool: env.PKULAW_CASE_SEARCH_TOOL,
    searchToolCandidates: [
        'search_case',
        'search_case_keyword',
    ],
    preferredQueryKey: 'text',
    aliases: {
        externalId: ['gid', 'id', 'case_id', 'doc_id', 'uuid'],
        caseNumber: ['case_number', 'caseNumber', 'documentNumber', '案号'],
        courtName: ['courthouse_name', 'courtName', 'court_name', '法院名称'],
        caseType: ['case_type', 'caseType', 'doc_type', 'document_type'],
        cause: ['cause_of_action', 'cause', 'causeOfActionText', '案由'],
        judgmentDate: ['decision_date', 'decisionDate', 'judgmentDate', '裁判日期'],
        factSummary: ['ascertain', 'caseFactSummary', '本院查明', '案情摘要'],
        reasoningSummary: ['courtOpinion', 'reasoningSummary', '本院认为', '裁判理由'],
        sourceUrl: ['source', 'sourceUrl', 'url', 'link'],
    },
});
export function isPkulawCaseSearchConfigured() {
    return pkulawCaseSearchClient.isConfigured();
}
export function searchPkulawCases(query, limit = 5) {
    return pkulawCaseSearchClient.searchCases(query, limit);
}
