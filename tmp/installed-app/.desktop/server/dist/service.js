import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import * as mammoth from 'mammoth';
import { listKnowledgeFilesForWorkspace, reindexCommercialKnowledgeFile, searchCommercialKnowledgeFileRagChunks, uploadKnowledgeFilesToCommercialLibrary, } from './commercial/knowledge-file-service.js';
import { env } from './config/env.js';
import { getStorageRoot } from './config/paths.js';
import { buildClaimEvidenceMatches, buildClaimUnits, buildEvidenceFragments } from './intelligence/evidence-matching.js';
import { readObject, storeObject } from './infrastructure/object-storage.js';
import { isDatabaseEnabled } from './infrastructure/postgres.js';
import { createChatCompletion, createChatCompletionStream, isLlmConfigured } from './integrations/llm-service.js';
import { createEmbedding, createEmbeddings, isEmbeddingConfigured } from './integrations/embedding-service.js';
import { isYuandianCaseSearchConfigured, searchYuandianCases } from './integrations/yuandian-mcp.js';
import { shouldUseCommercialKnowledgeStore } from './knowledge-mode.js';
import { OFFICIAL_LEGAL_SOURCES } from './legal-source-catalog.js';
import { removeLocalKnowledgeFileIndex, replaceLocalKnowledgeFileIndex, searchLocalKnowledgeRagChunks } from './local-rag-store.js';
import { readWorkspace, runWithWorkspaceAccount, writeWorkspace } from './store.js';
// #region debug-point B-C:asset-reporting
function reportServiceDebug(hypothesisId, msg, data = {}) {
    void fetch('http://127.0.0.1:7777/event', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            sessionId: 'backend-file-load',
            runId: 'pre-fix',
            hypothesisId,
            location: 'server/src/service.ts',
            msg: `[DEBUG] ${msg}`,
            data,
            ts: Date.now(),
        }),
    }).catch(() => { });
}
function createId(prefix) {
    return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}
function parseDataUrl(dataUrl) {
    const matched = /^data:([^;,]+)?;base64,(.*)$/s.exec(dataUrl);
    if (!matched) {
        throw new Error('当前证据原件格式暂不支持通过内置接口读取。');
    }
    return {
        mimeType: matched[1] || 'application/octet-stream',
        buffer: Buffer.from(matched[2], 'base64'),
    };
}
function getQuote(text) {
    return text.replace(/\s+/g, ' ').slice(0, 48) || '待补充证据摘录';
}
function escapeHtml(value) {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}
function buildParagraphRichText(text) {
    const lines = text
        .split(/\n+/)
        .map((line) => line.trim())
        .filter(Boolean);
    if (!lines.length) {
        return '<p></p>';
    }
    return lines.map((line) => `<p>${escapeHtml(line)}</p>`).join('');
}
function createEvidenceLink(paragraphId, evidence, locator, quote) {
    return {
        id: createId(`${paragraphId}-link`),
        evidenceId: evidence.id,
        locator: locator ??
            (evidence.type === 'pdf'
                ? `第 ${evidence.pages ?? 1} 页`
                : evidence.type === 'image'
                    ? '图片高亮区域'
                    : '段落 1'),
        quote: quote ?? getQuote(evidence.ocrText),
    };
}
function getParagraphLinks(paragraph) {
    if (!paragraph) {
        return [];
    }
    return paragraph.links?.length ? paragraph.links : paragraph.link ? [paragraph.link] : [];
}
function normalizeParagraph(paragraph) {
    const links = paragraph.links?.length
        ? paragraph.links.map((link, index) => ({
            ...link,
            id: link.id ?? `${paragraph.id}-link-${index + 1}`,
        }))
        : paragraph.link
            ? [{ ...paragraph.link, id: paragraph.link.id ?? `${paragraph.id}-link-1` }]
            : [];
    return {
        ...paragraph,
        richText: paragraph.richText ?? buildParagraphRichText(paragraph.text),
        links,
        link: links[0],
        references: normalizeReferences(paragraph.references),
    };
}
function normalizeMatchScore(input, fallback = 0.6) {
    if (typeof input !== 'number' || Number.isNaN(input)) {
        return fallback;
    }
    return Math.max(0, Math.min(1, Number(input.toFixed(2))));
}
function isClaimRelation(value) {
    return value === 'support'
        || value === 'partial'
        || value === 'contradict'
        || value === 'unrelated'
        || value === 'insufficient';
}
function tryParseLlmJsonObject(raw) {
    const normalized = raw.trim();
    const unwrapped = normalized
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
    const candidates = [
        normalized,
        unwrapped,
    ];
    const objectStart = unwrapped.indexOf('{');
    const objectEnd = unwrapped.lastIndexOf('}');
    if (objectStart >= 0 && objectEnd > objectStart) {
        const objectSlice = unwrapped.slice(objectStart, objectEnd + 1).trim();
        candidates.push(objectSlice);
        candidates.push(objectSlice.replace(/,\s*(?=[}\]])/g, ''));
    }
    for (const candidate of candidates) {
        if (!candidate) {
            continue;
        }
        try {
            return JSON.parse(candidate);
        }
        catch {
            continue;
        }
    }
    return null;
}
async function reviewClaimCandidatesWithLlm(params) {
    const candidatePayload = params.candidates.map(({ match, fragment, evidence }) => ({
        candidateId: match.id,
        evidenceId: evidence.id,
        evidenceNumber: evidence.number,
        evidenceName: evidence.name,
        locator: fragment.locator,
        source: match.source,
        currentRelation: match.relation,
        currentScore: match.score,
        fragmentText: fragment.text,
    }));
    const completion = await createChatCompletion({
        messages: [
            {
                role: 'system',
                content: [
                    '你是法律证据匹配审查助手。',
                    '请根据文书主张与候选证据片段，判断每个候选是 support、partial、contradict、unrelated、insufficient 中的哪一类。',
                    '必须返回 JSON 对象，格式为 {"items":[{"candidateId":"...","relation":"support","score":0.91,"reason":"...","quote":"..."}]}。',
                    'score 必须是 0 到 1 之间的小数。',
                    'quote 必须引用候选证据片段中的原文短句，不要编造。',
                ].join(' '),
            },
            {
                role: 'user',
                content: JSON.stringify({
                    paragraphText: params.paragraph.text,
                    claim: {
                        id: params.claim.id,
                        text: params.claim.text,
                    },
                    candidates: candidatePayload,
                }),
            },
        ],
        temperature: 0.1,
        maxTokens: 1200,
        responseFormat: 'json_object',
    });
    const parsed = tryParseLlmJsonObject(completion.content);
    return parsed?.items ?? [];
}
function normalizeReferences(references) {
    return (references ?? []).map((reference, index) => ({
        ...reference,
        id: reference.id ?? `${reference.type}-${reference.targetId}-${index + 1}`,
    }));
}
const AUTO_EVIDENCE_LINK_NOTE = 'system:auto-evidence-linked';
const AUTO_STATUTE_REFERENCE_NOTE = 'system:auto-statute-detected';
const AUTO_CASE_REFERENCE_NOTE = 'system:auto-case-detected';
const OFFICIAL_FETCH_TIMEOUT_MS = 10000;
const NPC_SEARCH_ENDPOINT = 'https://flk.npc.gov.cn/law-search/search/list';
const NPC_DETAIL_ENDPOINT = 'https://flk.npc.gov.cn/law-search/search/flfgDetails';
const STATUTE_PLACEHOLDER_SNIPPETS = [
    '官方原文已定位',
    '当前官方接口未直接返回结构化正文',
];
function stripHtmlTags(value) {
    return value.replace(/<[^>]+>/g, '').trim();
}
function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function normalizeLawTitle(rawTitle) {
    return rawTitle
        .replace(/[《》"'“”‘’]/g, '')
        .replace(/\s+/g, '')
        .replace(/^(依据|根据|依照|按照|参照|适用|违反|依|按)+/u, '')
        .replace(/(规定|条款|规则|内容)+$/u, '')
        .trim();
}
function isPlaceholderStatuteContent(content) {
    if (!content?.trim()) {
        return true;
    }
    return STATUTE_PLACEHOLDER_SNIPPETS.some((snippet) => content.includes(snippet));
}
function stripLawPrefix(title) {
    return normalizeLawTitle(title).replace(/^中华人民共和国/, '');
}
function buildLawTitleCandidates(rawTitle) {
    const normalized = normalizeLawTitle(rawTitle);
    const withoutPrefix = stripLawPrefix(normalized);
    const aliasMap = {
        民诉法: ['民事诉讼法', '中华人民共和国民事诉讼法'],
        民事诉讼法: ['民诉法', '中华人民共和国民事诉讼法'],
        民诉解释: ['最高人民法院关于适用《中华人民共和国民事诉讼法》的解释', '最高人民法院关于适用中华人民共和国民事诉讼法的解释'],
        证据规定: ['最高人民法院关于民事诉讼证据的若干规定'],
        民法典: ['中华人民共和国民法典'],
    };
    const candidates = [normalized, withoutPrefix];
    if (withoutPrefix && !withoutPrefix.startsWith('中华人民共和国')) {
        candidates.push(`中华人民共和国${withoutPrefix}`);
    }
    for (const key of [normalized, withoutPrefix]) {
        candidates.push(...(aliasMap[key] ?? []));
    }
    return uniqueStrings(candidates.filter(Boolean));
}
function documentMatchesLawTitle(document, rawTitle) {
    const documentCandidates = new Set([
        ...buildLawTitleCandidates(document.title),
        ...document.keywords.map((item) => normalizeLawTitle(item)),
    ]);
    return buildLawTitleCandidates(rawTitle).some((candidate) => documentCandidates.has(candidate));
}
function normalizeStatuteLookupText(value) {
    return value
        .replace(/\s+/g, '')
        .replace(/[《》"'“”‘’]/g, '')
        .trim();
}
function extractArticlePreviewFromKnowledgeFile(file, articleNumber) {
    const rawText = file.extractedText?.trim();
    if (!rawText) {
        return null;
    }
    const escapedArticleNumber = escapeRegex(articleNumber);
    const articlePattern = new RegExp(`(${escapedArticleNumber}[\\s\\S]{0,2400}?)(?=\\n\\s*第[一二三四五六七八九十百千万零〇两0-9]+条|$)`, 'u');
    const matched = rawText.match(articlePattern);
    if (!matched?.[1]) {
        return null;
    }
    const preview = matched[1]
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    return preview || null;
}
function findKnowledgeFileStatutePreview(files, document, article) {
    if (!document || !article) {
        return null;
    }
    const normalizedTitle = normalizeStatuteLookupText(document.title);
    const candidates = files
        .filter((file) => file.extractionStatus === 'ready' && file.extractedText?.trim())
        .map((file) => {
        const normalizedFileTitle = normalizeStatuteLookupText(`${file.title} ${file.fileName}`);
        const titleMatched = normalizedFileTitle.includes(normalizedTitle) || normalizedTitle.includes(normalizedFileTitle);
        const explicitlyLinked = file.linkedStatuteIds.includes(document.id);
        const articlePreview = extractArticlePreviewFromKnowledgeFile(file, article.articleNumber);
        if (!articlePreview) {
            return null;
        }
        return {
            file,
            articlePreview,
            score: (explicitlyLinked ? 10 : 0) + (titleMatched ? 6 : 0),
        };
    })
        .filter((item) => Boolean(item))
        .sort((left, right) => right.score - left.score || right.file.updatedAt.localeCompare(left.file.updatedAt));
    return candidates[0] ?? null;
}
function hydrateResolvedStatuteBindingFromKnowledgeFiles(workspace, binding) {
    const preview = findKnowledgeFileStatutePreview(workspace.knowledgeFiles, binding.document, binding.article);
    if (!preview) {
        return binding;
    }
    return {
        document: binding.document,
        article: {
            ...binding.article,
            content: preview.articlePreview,
            plainText: preview.articlePreview,
            aliases: uniqueStrings([...binding.article.aliases, preview.file.title, preview.file.fileName], 16),
            topicTags: uniqueStrings([...binding.article.topicTags, '知识库原文'], 16),
        },
    };
}
function hydrateWorkspaceStatutesFromKnowledgeFiles(workspace) {
    if (!workspace.knowledgeFiles.length || !workspace.knowledgeStatutes.length) {
        return workspace;
    }
    return {
        ...workspace,
        knowledgeStatutes: workspace.knowledgeStatutes.map((document) => ({
            ...document,
            articles: document.articles.map((article) => {
                const preview = findKnowledgeFileStatutePreview(workspace.knowledgeFiles, document, article);
                if (!preview) {
                    return article;
                }
                return {
                    ...article,
                    content: preview.articlePreview,
                    plainText: preview.articlePreview,
                    aliases: uniqueStrings([...article.aliases, preview.file.title, preview.file.fileName], 16),
                    topicTags: uniqueStrings([...article.topicTags, '知识库原文'], 16),
                };
            }),
        })),
    };
}
function chineseNumeralToNumber(value) {
    const normalized = value.replace(/两/g, '二').replace(/[零〇]/g, '零').trim();
    if (!normalized) {
        return Number.NaN;
    }
    if (/^\d+$/.test(normalized)) {
        return Number(normalized);
    }
    const digits = {
        一: 1,
        二: 2,
        三: 3,
        四: 4,
        五: 5,
        六: 6,
        七: 7,
        八: 8,
        九: 9,
        零: 0,
    };
    const units = {
        十: 10,
        百: 100,
        千: 1000,
        万: 10000,
    };
    let total = 0;
    let section = 0;
    let number = 0;
    for (const char of normalized) {
        if (char in digits) {
            number = digits[char];
            continue;
        }
        if (!(char in units)) {
            return Number.NaN;
        }
        const unit = units[char];
        if (unit === 10000) {
            section += number;
            total += (section || 1) * unit;
            section = 0;
            number = 0;
            continue;
        }
        section += (number || 1) * unit;
        number = 0;
    }
    return total + section + number;
}
function numberToChinese(value) {
    if (!Number.isInteger(value) || value <= 0) {
        return '';
    }
    const digits = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
    const units = ['', '十', '百', '千'];
    const groups = ['', '万', '亿'];
    const parts = [];
    let remaining = value;
    let groupIndex = 0;
    while (remaining > 0) {
        const groupValue = remaining % 10000;
        if (groupValue !== 0) {
            let groupText = '';
            let zeroPending = false;
            for (let i = 0; i < 4; i += 1) {
                const digit = Math.floor(groupValue / 10 ** i) % 10;
                if (digit === 0) {
                    zeroPending = groupText.length > 0;
                    continue;
                }
                const prefix = zeroPending ? '零' : '';
                groupText = `${digits[digit]}${units[i]}${prefix}${groupText}`;
                zeroPending = false;
            }
            parts.unshift(`${groupText}${groups[groupIndex]}`);
        }
        else if (parts.length && !parts[0].startsWith('零')) {
            parts.unshift('零');
        }
        remaining = Math.floor(remaining / 10000);
        groupIndex += 1;
    }
    return parts
        .join('')
        .replace(/零+/g, '零')
        .replace(/零$/g, '')
        .replace(/^一十/, '十');
}
function normalizeArticleNumber(value) {
    const matched = /第([0-9零〇一二三四五六七八九十百千万两]+)条/u.exec(value.replace(/\s+/g, ''));
    if (!matched) {
        return null;
    }
    const articleIndex = chineseNumeralToNumber(matched[1]);
    if (!Number.isFinite(articleIndex) || articleIndex <= 0) {
        return null;
    }
    return {
        articleIndex,
        articleNumber: `第${numberToChinese(articleIndex)}条`,
    };
}
function extractStatuteMentions(text, limit = 3) {
    const pattern = /(?:《([^》]{2,40})》|((?:中华人民共和国)?[\u4e00-\u9fa5]{1,30}?(?:法|法典|条例|规定|解释)))\s*第([0-9零〇一二三四五六七八九十百千万两]+)条/gu;
    const matches = [];
    for (const matched of text.matchAll(pattern)) {
        const lawTitle = normalizeLawTitle(matched[1] ?? matched[2] ?? '');
        const article = normalizeArticleNumber(`第${matched[3]}条`);
        if (!lawTitle || !article) {
            continue;
        }
        const dedupeKey = `${lawTitle}|${article.articleNumber}`;
        if (matches.some((item) => `${item.lawTitle}|${item.articleNumber}` === dedupeKey)) {
            continue;
        }
        matches.push({
            raw: matched[0],
            lawTitle,
            articleNumber: article.articleNumber,
        });
        if (matches.length >= limit) {
            break;
        }
    }
    return matches;
}
function buildStatuteReference(document, article) {
    return {
        id: `statute-${article.id}`,
        type: 'statute',
        targetId: article.id,
        sourceTitle: document.title,
        label: `${document.title} ${article.articleNumber}`,
        locator: article.articleNumber,
        quote: article.content,
        note: AUTO_STATUTE_REFERENCE_NOTE,
    };
}
function buildCaseReference(entry, excerpt) {
    return {
        id: `case-${excerpt.id}`,
        type: 'case',
        targetId: excerpt.id,
        sourceTitle: entry.title,
        label: `${entry.courtName} · ${entry.caseNumber}`,
        locator: excerpt.locator,
        quote: excerpt.content,
        note: AUTO_CASE_REFERENCE_NOTE,
    };
}
function chunkItems(items, size) {
    if (size <= 0 || items.length <= size) {
        return [items];
    }
    const chunks = [];
    for (let index = 0; index < items.length; index += size) {
        chunks.push(items.slice(index, index + size));
    }
    return chunks;
}
function summarizeEvidenceForAutoLinkPrompt(evidence, insight, fragments) {
    return {
        evidenceId: evidence.id,
        evidenceNumber: evidence.number,
        evidenceName: evidence.name,
        fileName: evidence.fileName,
        anchorHint: evidence.anchorHint ?? '',
        summary: insight?.summary ?? summarizeForPrompt(evidence.ocrText || evidence.name, 120),
        keyFacts: insight?.keyFacts ?? [],
        issues: insight?.issues ?? [],
        positions: insight?.positions ?? [],
        fragmentSnippets: fragments.slice(0, 3).map((fragment) => ({
            locator: fragment.locator,
            summary: summarizeForPrompt(fragment.text, 90),
        })),
    };
}
function rankEvidenceCandidatesForParagraph(workspace, paragraph, evidences, limit = 8) {
    const source = paragraph.text;
    return [...evidences]
        .map((evidence) => {
        const insight = getLatestEvidenceInsight(workspace, evidence.id);
        const fragments = getEvidenceFragmentsForEvidence(workspace, evidence.id);
        const score = scoreKeywords(source, [
            evidence.number,
            evidence.name,
            evidence.fileName,
            evidence.anchorHint ?? '',
            evidence.ocrText,
            insight?.summary ?? '',
            ...(insight?.keyFacts ?? []),
            ...(insight?.positions ?? []),
            ...fragments.slice(0, 4).map((fragment) => fragment.summary),
        ])
            + (findExplicitEvidenceMentions(paragraph.text, [evidence]).length ? 4 : 0);
        return {
            evidence,
            insight,
            fragments,
            score,
        };
    })
        .sort((left, right) => right.score - left.score)
        .slice(0, Math.max(limit, Math.min(evidences.length, 3)))
        .map(({ evidence, insight, fragments }) => summarizeEvidenceForAutoLinkPrompt(evidence, insight ?? null, fragments));
}
function normalizeAutoLinkEvidenceIntents(input) {
    if (!Array.isArray(input)) {
        return [];
    }
    const normalized = [];
    for (const item of input) {
        if (!item || typeof item !== 'object') {
            continue;
        }
        const evidenceNumber = typeof item.evidenceNumber === 'string'
            ? item.evidenceNumber.trim()
            : '';
        if (!evidenceNumber) {
            continue;
        }
        normalized.push({
            evidenceNumber,
            reason: typeof item.reason === 'string'
                ? item.reason.trim()
                : undefined,
            quoteHint: typeof item.quoteHint === 'string'
                ? item.quoteHint.trim()
                : undefined,
        });
    }
    return normalized;
}
function normalizeAutoLinkStatuteIntents(input) {
    if (!Array.isArray(input)) {
        return [];
    }
    const normalized = [];
    for (const item of input) {
        if (!item || typeof item !== 'object') {
            continue;
        }
        const lawTitle = typeof item.lawTitle === 'string'
            ? normalizeLawTitle(item.lawTitle)
            : '';
        const articleNumber = typeof item.articleNumber === 'string'
            ? normalizeArticleNumber(item.articleNumber)?.articleNumber ?? ''
            : '';
        const query = typeof item.query === 'string'
            ? item.query.trim()
            : '';
        const keywords = Array.isArray(item.keywords)
            ? uniqueStrings(item.keywords.filter((value) => typeof value === 'string'), 6)
            : [];
        const reason = typeof item.reason === 'string'
            ? item.reason.trim()
            : undefined;
        if (!lawTitle && !articleNumber && !query && !keywords.length) {
            continue;
        }
        normalized.push({
            lawTitle: lawTitle || undefined,
            articleNumber: articleNumber || undefined,
            query: query || undefined,
            keywords,
            reason,
        });
    }
    return normalized;
}
function normalizeAutoLinkCaseIntents(input) {
    if (!Array.isArray(input)) {
        return [];
    }
    const normalized = [];
    for (const item of input) {
        if (!item || typeof item !== 'object') {
            continue;
        }
        const query = typeof item.query === 'string'
            ? item.query.trim()
            : '';
        if (!query) {
            continue;
        }
        normalized.push({
            query,
            reason: typeof item.reason === 'string'
                ? item.reason.trim()
                : undefined,
        });
    }
    return normalized;
}
async function analyzeCertificateAutoLinksWithLlm(workspace, certificate, evidences, caseContextMemory) {
    if (!certificate.paragraphs.length) {
        return new Map();
    }
    if (!isLlmConfigured()) {
        throw new Error('当前桌面端尚未配置 LLM API Key，证据联动依赖大模型理解，请先完成模型配置后再试。');
    }
    const caseFolder = workspace.cases.find((item) => item.id === certificate.caseId) ?? null;
    const analyses = new Map();
    const paragraphChunks = chunkItems(certificate.paragraphs, 8);
    for (const chunk of paragraphChunks) {
        const completion = await createChatCompletion({
            messages: [
                {
                    role: 'system',
                    content: [
                        '你是法律文书关联编排助手。',
                        '任务是逐段理解当前文书的事实主张、争点和论证目的，然后输出三类关联意图：证据、法条、案例。',
                        '证据关联必须基于段落含义和候选证据内容判断，不得仅因为段落提到了证据编号就机械绑定。',
                        '法条关联要先理解段落表达的法律规则、请求基础、抗辩逻辑，再给出可用于检索的 lawTitle/articleNumber/query/keywords。',
                        '案例关联要先理解段落争议焦点、裁判规则、事实类型，再给出适合检索同类案例的 query。',
                        '必须严格返回 JSON 对象，格式为 {"paragraphs":[{"paragraphId":"...","paragraphSummary":"...","evidenceLinks":[{"evidenceNumber":"E01","reason":"...","quoteHint":"..."}],"statuteIntents":[{"lawTitle":"...","articleNumber":"第六十七条","query":"...","keywords":["..."],"reason":"..."}],"caseIntents":[{"query":"...","reason":"..."}]}]}。',
                        'evidenceLinks 只能引用已给出的 evidenceNumber。',
                        '如果某段没有合适的证据、法条或案例，就返回空数组。',
                        '不得编造不存在的证据内容、法条条文或案例案号。',
                    ].join(' '),
                },
                {
                    role: 'user',
                    content: JSON.stringify({
                        caseName: caseFolder?.name ?? '',
                        caseDescription: caseFolder?.description ?? '',
                        certificateTitle: certificate.title,
                        certificateFocus: certificate.focus,
                        caseContextMemory: caseContextMemory
                            ? {
                                summary: caseContextMemory.summary,
                                disputedFacts: caseContextMemory.disputedFacts,
                                timeline: caseContextMemory.timeline,
                                supportMatrix: caseContextMemory.supportMatrix.map((item) => ({
                                    fact: item.fact,
                                    evidenceNumbers: item.evidenceNumbers,
                                })),
                            }
                            : null,
                        paragraphs: chunk.map((paragraph) => ({
                            paragraphId: paragraph.id,
                            text: paragraph.text,
                            evidenceCandidates: rankEvidenceCandidatesForParagraph(workspace, paragraph, evidences, 8),
                        })),
                    }),
                },
            ],
            temperature: 0.1,
            maxTokens: 2400,
            responseFormat: 'json_object',
        });
        const parsed = tryParseLlmJsonObject(completion.content);
        if (!parsed) {
            throw new Error('证据联动的大模型返回结果无法解析，请检查当前 LLM 配置或稍后重试。');
        }
        for (const item of parsed.paragraphs ?? []) {
            const paragraphId = typeof item?.paragraphId === 'string' ? item.paragraphId.trim() : '';
            if (!paragraphId) {
                continue;
            }
            analyses.set(paragraphId, {
                paragraphId,
                paragraphSummary: typeof item.paragraphSummary === 'string' ? item.paragraphSummary.trim() : undefined,
                evidenceLinks: normalizeAutoLinkEvidenceIntents(item.evidenceLinks).slice(0, 3),
                statuteIntents: normalizeAutoLinkStatuteIntents(item.statuteIntents).slice(0, 3),
                caseIntents: normalizeAutoLinkCaseIntents(item.caseIntents).slice(0, 2),
            });
        }
    }
    return analyses;
}
function findBestEvidenceFragmentForParagraph(workspace, evidence, paragraphText, quoteHint) {
    const fragments = getEvidenceFragmentsForEvidence(workspace, evidence.id);
    if (!fragments.length) {
        return null;
    }
    const source = [paragraphText, quoteHint ?? '', evidence.anchorHint ?? '', evidence.name].filter(Boolean).join(' ');
    return [...fragments]
        .map((fragment) => ({
        fragment,
        score: scoreKeywords(source, [
            fragment.locator,
            fragment.text,
            fragment.summary,
            ...fragment.keywords,
        ])
            + ((quoteHint && fragment.text.includes(quoteHint)) ? 4 : 0)
            + ((fragment.confidence ?? 0.7) * 2),
    }))
        .sort((left, right) => right.score - left.score)[0]?.fragment ?? null;
}
function attachAutoEvidenceLinksToCertificateWithLlm(workspace, certificate, evidences, analyses) {
    const evidenceByNumber = new Map(evidences.map((item) => [item.number.toLowerCase(), item]));
    return {
        ...certificate,
        paragraphs: certificate.paragraphs.map((paragraph) => {
            const preservedLinks = getParagraphLinks(paragraph).filter((item) => item.note !== AUTO_EVIDENCE_LINK_NOTE);
            const preservedEvidenceIds = new Set(preservedLinks.map((item) => item.evidenceId));
            const analysis = analyses.get(paragraph.id);
            const llmLinks = (analysis?.evidenceLinks ?? [])
                .flatMap((intent) => {
                const evidence = evidenceByNumber.get(intent.evidenceNumber.toLowerCase());
                if (!evidence || preservedEvidenceIds.has(evidence.id)) {
                    return [];
                }
                const fragment = findBestEvidenceFragmentForParagraph(workspace, evidence, paragraph.text, intent.quoteHint);
                return [{
                        ...createEvidenceLink(paragraph.id, evidence, fragment?.locator ?? evidence.anchorHint ?? '原件全文', intent.quoteHint?.trim() || fragment?.summary || getQuote(evidence.ocrText)),
                        note: AUTO_EVIDENCE_LINK_NOTE,
                    }];
            })
                .filter((item, itemIndex, items) => items.findIndex((candidate) => candidate.evidenceId === item.evidenceId) === itemIndex)
                .slice(0, Math.max(0, 2 - preservedLinks.length));
            const nextLinks = [...preservedLinks, ...llmLinks];
            return normalizeParagraph({
                ...paragraph,
                links: nextLinks,
                link: nextLinks[0],
            });
        }),
    };
}
function paragraphMentionsCaseReference(text) {
    const normalized = text.replace(/\s+/g, '');
    if (!normalized) {
        return false;
    }
    if (/（\d{4}）[^号]{1,40}号/u.test(normalized)) {
        return true;
    }
    return [
        '指导性案例',
        '参考案例',
        '典型案例',
        '公报案例',
        '参阅案例',
        '类案',
        '案例',
        '裁判要旨',
        '裁判观点',
        '判决书',
        '裁定书',
        '人民法院',
    ].some((keyword) => normalized.includes(keyword));
}
function findExplicitEvidenceMentions(paragraphText, evidences) {
    const normalizedParagraph = paragraphText.replace(/\s+/g, '').toLowerCase();
    if (!normalizedParagraph) {
        return [];
    }
    return evidences
        .map((evidence) => {
        const normalizedNumber = evidence.number.replace(/\s+/g, '').toLowerCase();
        const normalizedName = evidence.name.replace(/\s+/g, '').toLowerCase();
        const exactTitleMention = normalizedName ? normalizedParagraph.includes(`《${normalizedName}》`) : false;
        const nameMention = normalizedName ? normalizedParagraph.includes(normalizedName) : false;
        const numberMention = normalizedNumber ? normalizedParagraph.includes(normalizedNumber) : false;
        const fileNameMention = evidence.fileName
            ? normalizedParagraph.includes(evidence.fileName.replace(/\s+/g, '').toLowerCase())
            : false;
        const score = (exactTitleMention ? 6 : 0)
            + (nameMention ? 4 : 0)
            + (numberMention ? 3 : 0)
            + (fileNameMention ? 1 : 0);
        return {
            evidence,
            score,
        };
    })
        .filter((item) => item.score > 0)
        .sort((left, right) => right.score - left.score)
        .map((item) => item.evidence);
}
function findLocalStatuteBinding(workspace, mention) {
    for (const document of workspace.knowledgeStatutes) {
        if (!documentMatchesLawTitle(document, mention.lawTitle)) {
            continue;
        }
        const article = document.articles.find((item) => normalizeArticleNumber(item.articleNumber)?.articleNumber === mention.articleNumber);
        if (article) {
            return hydrateResolvedStatuteBindingFromKnowledgeFiles(workspace, { document, article });
        }
    }
    return null;
}
async function fetchJsonWithTimeout(url, init) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OFFICIAL_FETCH_TIMEOUT_MS);
    try {
        const response = await fetch(url, {
            ...init,
            signal: controller.signal,
        });
        if (!response.ok) {
            throw new Error(`请求失败：${response.status}`);
        }
        return await response.json();
    }
    finally {
        clearTimeout(timer);
    }
}
function mapNpcEffectiveStatus(status) {
    if (status === 1) {
        return 'repealed';
    }
    if (status === 2) {
        return 'amended';
    }
    return 'effective';
}
async function searchNpcStatute(title) {
    const payload = await fetchJsonWithTimeout(NPC_SEARCH_ENDPOINT, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json;charset=utf-8',
        },
        body: JSON.stringify({
            searchRange: 1,
            searchType: 2,
            searchContent: title,
            sxx: [],
            sxrq: [],
            gbrq: [],
            pageNum: 1,
            pageSize: 10,
        }),
    });
    const rows = payload.rows ?? [];
    const titleCandidates = buildLawTitleCandidates(title);
    const strictMatch = rows.find((item) => {
        const candidateTitle = normalizeLawTitle(stripHtmlTags(item.title ?? ''));
        return titleCandidates.includes(candidateTitle);
    });
    if (strictMatch) {
        return strictMatch;
    }
    const fuzzyMatch = rows.find((item) => {
        const candidateTitle = normalizeLawTitle(stripHtmlTags(item.title ?? ''));
        return titleCandidates.some((candidate) => candidateTitle.includes(candidate) || candidate.includes(candidateTitle));
    });
    return fuzzyMatch ?? null;
}
async function fetchNpcDetail(bbbs) {
    const url = `${NPC_DETAIL_ENDPOINT}?bbbs=${encodeURIComponent(bbbs)}`;
    const payload = await fetchJsonWithTimeout(url);
    return payload.data ?? null;
}
function upsertKnowledgeStatuteDocument(workspace, nextDocument) {
    const existingIndex = workspace.knowledgeStatutes.findIndex((item) => item.id === nextDocument.id
        || (nextDocument.sourceDocumentId && item.sourceDocumentId === nextDocument.sourceDocumentId)
        || documentMatchesLawTitle(item, nextDocument.title));
    if (existingIndex === -1) {
        workspace.knowledgeStatutes.unshift(nextDocument);
        return nextDocument;
    }
    const existing = workspace.knowledgeStatutes[existingIndex];
    const articles = [...existing.articles];
    for (const article of nextDocument.articles) {
        const articleIndex = articles.findIndex((item) => normalizeArticleNumber(item.articleNumber)?.articleNumber === article.articleNumber);
        if (articleIndex === -1) {
            articles.push(article);
            continue;
        }
        const existingArticle = articles[articleIndex];
        const keepExistingContent = !isPlaceholderStatuteContent(existingArticle.content)
            && isPlaceholderStatuteContent(article.content);
        articles[articleIndex] = keepExistingContent
            ? {
                ...existingArticle,
                aliases: uniqueStrings([...existingArticle.aliases, ...article.aliases], 12),
                topicTags: uniqueStrings([...existingArticle.topicTags, ...article.topicTags], 12),
            }
            : {
                ...existingArticle,
                ...article,
                aliases: uniqueStrings([...existingArticle.aliases, ...article.aliases], 12),
                topicTags: uniqueStrings([...existingArticle.topicTags, ...article.topicTags], 12),
            };
    }
    const merged = {
        ...existing,
        ...nextDocument,
        id: existing.id,
        articles,
        keywords: uniqueStrings([...existing.keywords, ...nextDocument.keywords], 20),
    };
    workspace.knowledgeStatutes[existingIndex] = merged;
    return merged;
}
async function resolveStatuteMentionFromOfficialSource(workspace, mention) {
    const titleCandidates = buildLawTitleCandidates(mention.lawTitle);
    for (const title of titleCandidates) {
        const searchRow = await searchNpcStatute(title).catch(() => null);
        if (!searchRow?.bbbs) {
            continue;
        }
        const detail = await fetchNpcDetail(searchRow.bbbs).catch(() => null);
        if (!detail?.bbbs) {
            continue;
        }
        const existingDocument = workspace.knowledgeStatutes.find((item) => item.sourceDocumentId === detail.bbbs)
            ?? workspace.knowledgeStatutes.find((item) => documentMatchesLawTitle(item, detail.title ?? title))
            ?? null;
        const article = existingDocument?.articles.find((item) => normalizeArticleNumber(item.articleNumber)?.articleNumber === mention.articleNumber)
            ?? {
                id: createId('article'),
                documentId: existingDocument?.id ?? createId('statute'),
                articleNumber: mention.articleNumber,
                content: `${mention.articleNumber} 官方原文已定位，请点击“官方原文”查看完整条文。当前官方接口未直接返回结构化正文，已先完成法条绑定。`,
                plainText: `${mention.articleNumber} 官方原文已定位，请点击“官方原文”查看完整条文。当前官方接口未直接返回结构化正文，已先完成法条绑定。`,
                aliases: uniqueStrings([mention.raw, mention.lawTitle]),
                topicTags: ['官方检索'],
            };
        const nextDocument = upsertKnowledgeStatuteDocument(workspace, {
            id: existingDocument?.id ?? article.documentId,
            title: detail.title?.trim() || title,
            docType: detail.flxz?.trim() || searchRow.flxz?.trim() || '法律',
            issuer: detail.zdjgName?.trim() || searchRow.zdjgName?.trim() || '全国人大常委会办公厅',
            effectiveStatus: mapNpcEffectiveStatus(detail.sxx ?? searchRow.sxx),
            effectiveDate: detail.sxrq ? `${detail.sxrq}T00:00:00.000Z` : new Date().toISOString(),
            publishDate: detail.gbrq ? `${detail.gbrq}T00:00:00.000Z` : new Date().toISOString(),
            revisionDate: detail.gbrq ? `${detail.gbrq}T00:00:00.000Z` : undefined,
            version: detail.sxrq ? `官方同步 ${detail.sxrq}` : '官方同步',
            sourceUrl: `https://flk.npc.gov.cn/detail2.html?bbbs=${encodeURIComponent(detail.bbbs)}`,
            sourceProvider: 'npc_flk',
            sourceAuthority: '全国人大常委会办公厅',
            sourceDocumentId: detail.bbbs,
            sourceVerifiedAt: new Date().toISOString(),
            keywords: uniqueStrings([title, detail.title ?? '', searchRow.flxz ?? '', '国家法律法规数据库']),
            articles: [
                {
                    ...article,
                    documentId: existingDocument?.id ?? article.documentId,
                },
            ],
        });
        const resolvedArticle = nextDocument.articles.find((item) => normalizeArticleNumber(item.articleNumber)?.articleNumber === mention.articleNumber);
        if (resolvedArticle) {
            return {
                document: nextDocument,
                article: resolvedArticle,
            };
        }
    }
    return null;
}
async function resolveStatuteMention(workspace, mention, cache) {
    const cacheKey = `${mention.lawTitle}|${mention.articleNumber}`;
    if (cache.has(cacheKey)) {
        return cache.get(cacheKey) ?? null;
    }
    const localBinding = findLocalStatuteBinding(workspace, mention);
    if (localBinding) {
        cache.set(cacheKey, localBinding);
        return localBinding;
    }
    const officialBinding = await resolveStatuteMentionFromOfficialSource(workspace, mention).catch(() => null);
    cache.set(cacheKey, officialBinding);
    return officialBinding;
}
async function attachAutoStatuteReferencesToParagraph(workspace, paragraph, cache) {
    const mentions = extractStatuteMentions(paragraph.text);
    const preservedReferences = (paragraph.references ?? []).filter((item) => item.note !== AUTO_STATUTE_REFERENCE_NOTE);
    const autoReferences = [];
    for (const mention of mentions) {
        const binding = await resolveStatuteMention(workspace, mention, cache);
        if (!binding || autoReferences.some((item) => item.targetId === binding.article.id)) {
            continue;
        }
        autoReferences.push(buildStatuteReference(binding.document, binding.article));
    }
    return normalizeParagraph({
        ...paragraph,
        references: [...preservedReferences, ...autoReferences],
    });
}
async function attachAutoStatuteReferencesToCertificate(workspace, certificate) {
    const cache = new Map();
    const paragraphs = [];
    for (const paragraph of certificate.paragraphs) {
        paragraphs.push(await attachAutoStatuteReferencesToParagraph(workspace, paragraph, cache));
    }
    return {
        ...certificate,
        paragraphs,
    };
}
export function sanitizeWorkspaceForClient(workspace) {
    return {
        ...workspace,
        evidences: workspace.evidences.map((evidence) => ({
            ...evidence,
            sourceDataUrl: undefined,
            previewDataUrl: undefined,
        })),
    };
}
export async function getEvidenceSourceAsset(evidenceId) {
    const workspace = await readWorkspace();
    const evidence = workspace.evidences.find((item) => item.id === evidenceId);
    // #region debug-point C:asset-lookup
    reportServiceDebug('C', 'get-evidence-source-asset-lookup', {
        evidenceId,
        found: Boolean(evidence),
    });
    // #endregion
    if (!evidence) {
        throw new Error('证据不存在。');
    }
    const dataUrl = evidence.sourceDataUrl ?? evidence.previewDataUrl;
    // #region debug-point B-C:asset-data-url-state
    reportServiceDebug('C', 'get-evidence-source-asset-data-url-state', {
        evidenceId,
        hasSourceDataUrl: Boolean(evidence.sourceDataUrl),
        hasPreviewDataUrl: Boolean(evidence.previewDataUrl),
        selectedSource: evidence.sourceDataUrl ? 'sourceDataUrl' : evidence.previewDataUrl ? 'previewDataUrl' : 'none',
        sourceMimeType: evidence.sourceMimeType ?? null,
        evidenceType: evidence.type,
        fileName: evidence.fileName,
    });
    // #endregion
    if (!dataUrl) {
        throw new Error('当前证据未保存可读取的原件数据。');
    }
    const { buffer, mimeType } = parseDataUrl(dataUrl);
    // #region debug-point B:asset-parse-success
    reportServiceDebug('B', 'get-evidence-source-asset-parse-success', {
        evidenceId,
        mimeType: evidence.sourceMimeType || mimeType,
        bufferLength: buffer.length,
    });
    // #endregion
    return {
        buffer,
        mimeType: evidence.sourceMimeType || mimeType,
        fileName: evidence.fileName,
    };
}
function splitIntoMeaningfulLines(text, limit = 6) {
    return text
        .split(/\n+/)
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, limit);
}
function splitIntoSentences(text, limit = 6) {
    return text
        .replace(/\s+/g, ' ')
        .split(/(?<=[。！？!?；;])/u)
        .map((segment) => segment.trim())
        .filter(Boolean)
        .slice(0, limit);
}
function uniqueStrings(items, limit = items.length) {
    const normalized = items
        .map((item) => item.trim())
        .filter(Boolean);
    return normalized.filter((item, index) => normalized.findIndex((candidate) => candidate.toLowerCase() === item.toLowerCase()) === index).slice(0, limit);
}
function extractRegexMatches(text, pattern, limit = 6) {
    return uniqueStrings(Array.from(text.matchAll(pattern), (match) => match[0]), limit);
}
function getEvidenceFragmentsForEvidence(workspace, evidenceId) {
    return workspace.evidenceFragments.filter((fragment) => fragment.evidenceId === evidenceId);
}
function getLatestEvidenceInsight(workspace, evidenceId) {
    return workspace.evidenceInsights
        .filter((item) => item.evidenceId === evidenceId)
        .sort((left, right) => right.version - left.version)[0] ?? null;
}
function getLatestCaseContextMemory(workspace, caseId) {
    return workspace.caseContextMemories
        .filter((item) => item.caseId === caseId)
        .sort((left, right) => right.version - left.version)[0] ?? null;
}
function getLatestDraftMemory(workspace, certificateId) {
    return workspace.draftMemories.find((item) => item.certificateId === certificateId) ?? null;
}
function buildSummaryTextFromInsightDraft(draft) {
    const lines = [
        draft.summary.trim(),
        ...draft.keyFacts.slice(0, 4).map((item, index) => `${index + 1}. ${item}`),
    ].filter(Boolean);
    return lines.join('\n');
}
function buildFallbackEvidenceInsightDraft(evidence, fragments) {
    const baseText = getMeaningfulEvidenceText(evidence.summaryText || evidence.ocrText) || evidence.summaryText || evidence.ocrText;
    const sentences = splitIntoSentences(baseText || evidence.name, 5);
    const fragmentLines = fragments.flatMap((fragment) => splitIntoSentences(fragment.text, 1)).slice(0, 4);
    const keyFacts = uniqueStrings([...(splitIntoMeaningfulLines(evidence.summaryText ?? '', 4)), ...sentences, ...fragmentLines], 4);
    const summary = keyFacts[0] ?? summarizeForPrompt(baseText || evidence.name, 120);
    const entities = uniqueStrings([
        evidence.name,
        ...extractRegexMatches(baseText, /[\u4e00-\u9fa5A-Za-z0-9()（）]{2,20}(公司|法院|微信|合同|票据|发票|银行|账户|账号)/g, 6),
    ], 6);
    const timelineEvents = uniqueStrings([
        ...extractRegexMatches(baseText, /\d{4}年\d{1,2}月\d{1,2}日[^。；;\n]*/g, 6),
        ...extractRegexMatches(baseText, /\d{1,2}月\d{1,2}日[^。；;\n]*/g, 6),
    ], 6);
    const amounts = uniqueStrings(extractRegexMatches(baseText, /[¥￥]?\d[\d,]*(?:\.\d+)?\s*元/g, 6), 6);
    const issues = uniqueStrings([
        ...(isPlaceholderEvidenceText(evidence.ocrText) ? ['当前证据仍依赖预处理文本，建议补充 OCR 或人工校核。'] : []),
        ...(fragments.length ? [] : ['当前证据尚未形成稳定片段，后续建议补充分段理解。']),
    ], 4);
    return {
        summary,
        keyFacts,
        entities,
        timelineEvents,
        amounts,
        positions: [],
        issues,
        sourceFragmentIds: fragments.slice(0, 4).map((fragment) => fragment.id),
        confidence: isPlaceholderEvidenceText(evidence.ocrText) ? 0.45 : 0.68,
        status: 'ready',
    };
}
async function buildEvidenceInsightDraftWithLlm(evidence, fragments) {
    if (!isLlmConfigured()) {
        return buildFallbackEvidenceInsightDraft(evidence, fragments);
    }
    const meaningfulText = getMeaningfulEvidenceText(evidence.ocrText);
    const imageDataUrl = evidence.sourceDataUrl ?? evidence.previewDataUrl;
    const canUseImageVision = evidence.type === 'image' && isImageDataUrl(imageDataUrl, evidence.sourceMimeType);
    if (!meaningfulText && !canUseImageVision) {
        return buildFallbackEvidenceInsightDraft(evidence, fragments);
    }
    const completion = await createChatCompletion({
        messages: [
            {
                role: 'system',
                content: [
                    '你是律师证据理解与记忆抽取助手。',
                    '请基于证据原文、证据片段或证据图片，提炼可复用的结构化记忆。',
                    '必须返回 JSON 对象，格式为 {"summary":"...","keyFacts":["..."],"entities":["..."],"timelineEvents":["..."],"amounts":["..."],"positions":["..."],"issues":["..."],"confidence":0.82}。',
                    'summary 用 1 到 2 句话概括材料核心内容。',
                    'keyFacts 提炼 2 到 4 条关键事实。',
                    'timelineEvents 只写材料中明确可识别的时间事件。',
                    'amounts 只写明确出现的金额。',
                    'positions 用于描述该证据更支持哪一方或哪一类主张。',
                    'issues 用于描述真实性、关联性、证明力、缺页、截图截断、时间不明等风险。',
                    '不得编造材料中不存在的信息。',
                ].join(' '),
            },
            {
                role: 'user',
                content: canUseImageVision
                    ? [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                evidenceNumber: evidence.number,
                                evidenceName: evidence.name,
                                fileName: evidence.fileName,
                                fragments: fragments.slice(0, 4).map((fragment) => ({
                                    locator: fragment.locator,
                                    text: summarizeForPrompt(fragment.text, 180),
                                })),
                                task: '请对这份图片证据形成长期可复用的结构化理解记忆。',
                            }),
                        },
                        {
                            type: 'image_url',
                            image_url: {
                                url: imageDataUrl,
                            },
                        },
                    ]
                    : JSON.stringify({
                        evidenceNumber: evidence.number,
                        evidenceName: evidence.name,
                        fileName: evidence.fileName,
                        ocrText: meaningfulText,
                        fragments: fragments.slice(0, 4).map((fragment) => ({
                            locator: fragment.locator,
                            text: summarizeForPrompt(fragment.text, 180),
                        })),
                    }),
            },
        ],
        temperature: 0.1,
        maxTokens: 1200,
        responseFormat: 'json_object',
    });
    const parsed = JSON.parse(completion.content);
    const fallback = buildFallbackEvidenceInsightDraft(evidence, fragments);
    return {
        summary: typeof parsed.summary === 'string' && parsed.summary.trim() ? parsed.summary.trim() : fallback.summary,
        keyFacts: Array.isArray(parsed.keyFacts) ? uniqueStrings(parsed.keyFacts.filter((item) => typeof item === 'string'), 4) : fallback.keyFacts,
        entities: Array.isArray(parsed.entities) ? uniqueStrings(parsed.entities.filter((item) => typeof item === 'string'), 8) : fallback.entities,
        timelineEvents: Array.isArray(parsed.timelineEvents) ? uniqueStrings(parsed.timelineEvents.filter((item) => typeof item === 'string'), 6) : fallback.timelineEvents,
        amounts: Array.isArray(parsed.amounts) ? uniqueStrings(parsed.amounts.filter((item) => typeof item === 'string'), 6) : fallback.amounts,
        positions: Array.isArray(parsed.positions) ? uniqueStrings(parsed.positions.filter((item) => typeof item === 'string'), 4) : fallback.positions,
        issues: Array.isArray(parsed.issues) ? uniqueStrings(parsed.issues.filter((item) => typeof item === 'string'), 4) : fallback.issues,
        sourceFragmentIds: fragments.slice(0, 4).map((fragment) => fragment.id),
        confidence: normalizeMatchScore(parsed.confidence, fallback.confidence),
        status: 'ready',
        error: undefined,
    };
}
function upsertEvidenceInsight(workspace, insight) {
    workspace.evidenceInsights = workspace.evidenceInsights.filter((item) => item.evidenceId !== insight.evidenceId);
    workspace.evidenceInsights.unshift(insight);
}
function upsertCaseContextMemory(workspace, memory) {
    workspace.caseContextMemories = workspace.caseContextMemories.filter((item) => item.caseId !== memory.caseId);
    workspace.caseContextMemories.unshift(memory);
}
function upsertDraftMemory(workspace, memory) {
    workspace.draftMemories = workspace.draftMemories.filter((item) => item.certificateId !== memory.certificateId);
    workspace.draftMemories.unshift(memory);
}
function ensureEvidenceInsightsForCase(workspace, evidences) {
    const ensured = [];
    for (const evidence of evidences) {
        const existing = getLatestEvidenceInsight(workspace, evidence.id);
        if (existing?.status === 'ready') {
            ensured.push(existing);
            continue;
        }
        const fallbackDraft = buildFallbackEvidenceInsightDraft(evidence, getEvidenceFragmentsForEvidence(workspace, evidence.id));
        const nextInsight = {
            id: existing?.id ?? createId('evidence-insight'),
            caseId: evidence.caseId,
            evidenceId: evidence.id,
            version: (existing?.version ?? 0) + (existing ? 0 : 1),
            ...fallbackDraft,
            updatedAt: existing?.updatedAt ?? new Date().toISOString(),
        };
        upsertEvidenceInsight(workspace, nextInsight);
        ensured.push(nextInsight);
    }
    return ensured;
}
function normalizeSupportMatrix(supportMatrix, evidenceByNumber) {
    if (!Array.isArray(supportMatrix)) {
        return [];
    }
    return supportMatrix
        .map((item) => {
        if (!item || typeof item !== 'object') {
            return null;
        }
        const fact = typeof item.fact === 'string' ? item.fact.trim() : '';
        const evidenceNumbers = Array.isArray(item.evidenceNumbers)
            ? uniqueStrings(item.evidenceNumbers.filter((value) => typeof value === 'string'), 6)
            : [];
        const matchedEvidences = evidenceNumbers
            .map((number) => evidenceByNumber.get(number.toLowerCase()) ?? null)
            .filter((value) => Boolean(value));
        if (!fact) {
            return null;
        }
        return {
            fact,
            evidenceIds: matchedEvidences.map((evidence) => evidence.id),
            evidenceNumbers: matchedEvidences.map((evidence) => evidence.number),
        };
    })
        .filter((item) => Boolean(item));
}
function buildFallbackCaseContextMemoryDraft(caseFolder, evidences, insights) {
    const parties = uniqueStrings(insights.flatMap((insight) => insight.entities), 8);
    const disputedFacts = uniqueStrings(insights.flatMap((insight) => insight.keyFacts), 6);
    const timeline = uniqueStrings(insights.flatMap((insight) => insight.timelineEvents), 8);
    const paymentFlow = uniqueStrings(insights.flatMap((insight) => insight.amounts), 8);
    const contradictions = uniqueStrings(insights.flatMap((insight) => insight.issues.filter((issue) => /矛盾|冲突|不一致/u.test(issue))), 6);
    const openQuestions = uniqueStrings(insights.flatMap((insight) => insight.issues.filter((issue) => !/矛盾|冲突|不一致/u.test(issue))), 6);
    const supportMatrix = insights
        .flatMap((insight) => insight.keyFacts.slice(0, 2).map((fact) => ({
        fact,
        evidenceIds: [insight.evidenceId],
        evidenceNumbers: [evidences.find((item) => item.id === insight.evidenceId)?.number ?? ''],
    })))
        .filter((item) => item.evidenceNumbers[0])
        .slice(0, 8);
    return {
        summary: disputedFacts[0]
            ?? `${caseFolder.name}当前已形成 ${evidences.length} 份证据的案件记忆，可用于后续文书撰写与核验。`,
        parties,
        disputedFacts,
        timeline,
        paymentFlow,
        contradictions,
        openQuestions,
        supportMatrix,
        evidenceInsightIds: insights.map((insight) => insight.id),
    };
}
async function buildCaseContextMemoryDraftWithLlm(caseFolder, evidences, insights) {
    const fallback = buildFallbackCaseContextMemoryDraft(caseFolder, evidences, insights);
    if (!isLlmConfigured() || !insights.length) {
        return fallback;
    }
    const evidenceByNumber = new Map(evidences.map((evidence) => [evidence.number.toLowerCase(), evidence]));
    const completion = await createChatCompletion({
        messages: [
            {
                role: 'system',
                content: [
                    '你是案件上下文记忆构建助手。',
                    '请根据多份证据理解结果，输出一份适合文书生成与核验复用的案件记忆。',
                    '必须严格返回 JSON 对象，格式为 {"summary":"...","parties":["..."],"disputedFacts":["..."],"timeline":["..."],"paymentFlow":["..."],"contradictions":["..."],"openQuestions":["..."],"supportMatrix":[{"fact":"...","evidenceNumbers":["E01","E02"]}]}。',
                    'supportMatrix 中的 evidenceNumbers 只能引用已给出的证据编号。',
                    '不要编造不存在的事实，不要把猜测写成结论。',
                ].join(' '),
            },
            {
                role: 'user',
                content: JSON.stringify({
                    caseName: caseFolder.name,
                    caseDescription: caseFolder.description,
                    evidences: evidences.map((evidence) => {
                        const insight = insights.find((item) => item.evidenceId === evidence.id);
                        return {
                            number: evidence.number,
                            name: evidence.name,
                            type: evidence.type,
                            summary: insight?.summary ?? '',
                            keyFacts: insight?.keyFacts ?? [],
                            timelineEvents: insight?.timelineEvents ?? [],
                            amounts: insight?.amounts ?? [],
                            positions: insight?.positions ?? [],
                            issues: insight?.issues ?? [],
                        };
                    }),
                }),
            },
        ],
        temperature: 0.1,
        maxTokens: 1600,
        responseFormat: 'json_object',
    });
    const parsed = JSON.parse(completion.content);
    return {
        summary: parsed.summary?.trim() || fallback.summary,
        parties: Array.isArray(parsed.parties) ? uniqueStrings(parsed.parties.filter((item) => typeof item === 'string'), 8) : fallback.parties,
        disputedFacts: Array.isArray(parsed.disputedFacts) ? uniqueStrings(parsed.disputedFacts.filter((item) => typeof item === 'string'), 8) : fallback.disputedFacts,
        timeline: Array.isArray(parsed.timeline) ? uniqueStrings(parsed.timeline.filter((item) => typeof item === 'string'), 10) : fallback.timeline,
        paymentFlow: Array.isArray(parsed.paymentFlow) ? uniqueStrings(parsed.paymentFlow.filter((item) => typeof item === 'string'), 8) : fallback.paymentFlow,
        contradictions: Array.isArray(parsed.contradictions) ? uniqueStrings(parsed.contradictions.filter((item) => typeof item === 'string'), 8) : fallback.contradictions,
        openQuestions: Array.isArray(parsed.openQuestions) ? uniqueStrings(parsed.openQuestions.filter((item) => typeof item === 'string'), 8) : fallback.openQuestions,
        supportMatrix: normalizeSupportMatrix(parsed.supportMatrix, evidenceByNumber).length
            ? normalizeSupportMatrix(parsed.supportMatrix, evidenceByNumber)
            : fallback.supportMatrix,
        evidenceInsightIds: insights.map((insight) => insight.id),
    };
}
async function rebuildCaseContextMemory(workspace, caseFolder, evidences) {
    const insights = ensureEvidenceInsightsForCase(workspace, evidences);
    const existing = getLatestCaseContextMemory(workspace, caseFolder.id);
    const draft = await buildCaseContextMemoryDraftWithLlm(caseFolder, evidences, insights);
    const memory = {
        id: existing?.id ?? createId('case-memory'),
        caseId: caseFolder.id,
        version: (existing?.version ?? 0) + 1,
        ...draft,
        updatedAt: new Date().toISOString(),
    };
    upsertCaseContextMemory(workspace, memory);
    return memory;
}
function buildCaseMemoryPromptContext(memory) {
    if (!memory) {
        return null;
    }
    return {
        summary: memory.summary,
        parties: memory.parties,
        disputedFacts: memory.disputedFacts,
        timeline: memory.timeline,
        paymentFlow: memory.paymentFlow,
        contradictions: memory.contradictions,
        openQuestions: memory.openQuestions,
        supportMatrix: memory.supportMatrix.map((item) => ({
            fact: item.fact,
            evidenceNumbers: item.evidenceNumbers,
        })),
    };
}
function buildDraftMemory(workspace, certificate, writingGoal, caseContextMemory, evidences) {
    const existing = getLatestDraftMemory(workspace, certificate.id);
    const evidenceById = new Map(evidences.map((evidence) => [evidence.id, evidence]));
    const usedEvidenceInsightIds = Array.from(new Set(certificate.paragraphs.flatMap((paragraph) => getParagraphLinks(paragraph)
        .map((link) => getLatestEvidenceInsight(workspace, link.evidenceId)?.id ?? null)
        .filter((item) => Boolean(item)))));
    return {
        id: existing?.id ?? createId('draft-memory'),
        caseId: certificate.caseId,
        certificateId: certificate.id,
        writingGoal,
        caseContextMemoryId: caseContextMemory?.id,
        usedEvidenceInsightIds,
        paragraphPlans: certificate.paragraphs.map((paragraph) => ({
            paragraphId: paragraph.id,
            intent: summarizeForPrompt(paragraph.text, 80),
            evidenceNumbers: Array.from(new Set(getParagraphLinks(paragraph)
                .map((link) => evidenceById.get(link.evidenceId)?.number ?? '')
                .filter(Boolean))),
        })),
        updatedAt: new Date().toISOString(),
    };
}
function tokenizeKeywordSource(text) {
    return text
        .toLowerCase()
        .split(/[\s,.;:，。；：、()（）【】\[\]\-_/]+/)
        .map((item) => item.trim())
        .filter((item) => item.length >= 2);
}
function scoreKeywords(source, candidates) {
    const tokens = tokenizeKeywordSource(source);
    if (!tokens.length) {
        return 0;
    }
    return tokens.reduce((total, token) => total + (candidates.some((item) => item.toLowerCase().includes(token)) ? 1 : 0), 0);
}
function buildParagraphText(evidence, role, focus) {
    const sideLabel = role === 'plaintiff' ? '原告质证意见' : '被告质证意见';
    const focusText = focus.trim() || '真实性、关联性与证明力';
    const quote = getQuote(evidence.summaryText || evidence.ocrText);
    return `${sideLabel}：针对证据 ${evidence.number}《${evidence.name}》，当前可重点围绕“${focusText}”展开核验。结合材料摘录“${quote}”，建议进一步核对形成时间、来源链路及与待证事实的对应关系。`;
}
function inferEvidenceType(fileName, mimeType) {
    const lowerFileName = fileName.toLowerCase();
    const lowerMime = mimeType?.toLowerCase() ?? '';
    if (lowerMime.includes('pdf') || lowerFileName.endsWith('.pdf')) {
        return 'pdf';
    }
    if (lowerMime.includes('powerpoint') ||
        lowerMime.includes('presentation') ||
        lowerFileName.endsWith('.ppt') ||
        lowerFileName.endsWith('.pptx')) {
        return 'ppt';
    }
    if (lowerMime.startsWith('image/') ||
        /\.(png|jpe?g|webp|gif|bmp|tiff?|svg)$/i.test(lowerFileName)) {
        return 'image';
    }
    if (lowerMime.includes('word') ||
        lowerMime.includes('officedocument.wordprocessingml') ||
        /\.(docx?|rtf|wps)$/i.test(lowerFileName)) {
        return 'word';
    }
    if (lowerMime.startsWith('text/') ||
        /\.(txt|md|json|csv)$/i.test(lowerFileName)) {
        return 'text';
    }
    return 'other';
}
function inferSourceMimeType(fileName, mimeType, type) {
    if (mimeType?.trim()) {
        return mimeType;
    }
    const lowerFileName = fileName.toLowerCase();
    if (type === 'image') {
        if (lowerFileName.endsWith('.png'))
            return 'image/png';
        if (/\.(jpg|jpeg)$/i.test(lowerFileName))
            return 'image/jpeg';
        if (lowerFileName.endsWith('.webp'))
            return 'image/webp';
        if (lowerFileName.endsWith('.gif'))
            return 'image/gif';
        if (lowerFileName.endsWith('.bmp'))
            return 'image/bmp';
        return 'image/*';
    }
    if (type === 'pdf') {
        return 'application/pdf';
    }
    if (type === 'ppt') {
        return lowerFileName.endsWith('.ppt')
            ? 'application/vnd.ms-powerpoint'
            : 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    }
    if (type === 'word') {
        if (lowerFileName.endsWith('.doc'))
            return 'application/msword';
        if (lowerFileName.endsWith('.rtf'))
            return 'application/rtf';
        return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    }
    if (type === 'text') {
        return 'text/plain';
    }
    return 'application/octet-stream';
}
function buildEvidenceOcrPlaceholder(fileName, evidenceType) {
    const kindLabel = {
        pdf: 'PDF 分页抽取',
        ppt: 'PPT 页面提取',
        image: '图片 OCR',
        word: 'Word 段落抽取',
        text: '文本直读',
        other: '通用文件预处理',
    };
    return [
        `【${kindLabel[evidenceType]}】`,
        `文件：${fileName}`,
        '1. 当前内容为系统解析后的摘要结果。',
        '2. 请结合右侧原件继续人工核验。',
        '3. 支持用于文书生成、引用绑定与逐段复核。',
    ].join('\n');
}
function isPlaceholderEvidenceText(text) {
    const normalizedLines = text
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    if (!normalizedLines.length) {
        return true;
    }
    const placeholderLinePatterns = [
        /^【.*】$/u,
        /^文件：/u,
        /^1\.\s*当前内容为/u,
        /^2\.\s*请结合原件/u,
        /^3\.\s*支持用于/u,
        /^3\.\s*可直接用于/u,
    ];
    return normalizedLines.every((line) => placeholderLinePatterns.some((pattern) => pattern.test(line)));
}
function getMeaningfulEvidenceText(text) {
    const normalized = text.replace(/\r\n/g, '\n').trim();
    if (!normalized || isPlaceholderEvidenceText(normalized)) {
        return '';
    }
    return normalized;
}
function isImageDataUrl(url, mimeType) {
    if (!url?.startsWith('data:')) {
        return false;
    }
    return Boolean(mimeType?.toLowerCase().startsWith('image/')) || /^data:image\//i.test(url);
}
async function understandEvidenceWithLlm(evidence, fragments) {
    if (!isLlmConfigured()) {
        throw new Error('当前尚未配置大模型，无法执行证据内容理解。');
    }
    const meaningfulText = getMeaningfulEvidenceText(evidence.ocrText);
    const imageDataUrl = evidence.sourceDataUrl ?? evidence.previewDataUrl;
    const canUseImageVision = evidence.type === 'image' && isImageDataUrl(imageDataUrl, evidence.sourceMimeType);
    if (!meaningfulText && !canUseImageVision) {
        throw new Error('当前证据尚无可供模型理解的文本或图片原件。请先完成 OCR / 解析后再执行内容理解。');
    }
    return buildEvidenceInsightDraftWithLlm(evidence, fragments);
}
function normalizeEvidenceRelativePath(relativePath, fileName) {
    const normalized = relativePath?.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    return normalized || fileName;
}
function getEvidenceFileStem(fileName) {
    return fileName.replace(/\.[^.]+$/, '');
}
function cleanupEvidenceNameSegment(value) {
    const normalized = value
        .replace(/\.[^.]+$/, '')
        .replace(/^[\s._-]*[([{（【]?\d{1,3}[)\]）】._-]*/u, '')
        .replace(/^[\s._-]*(证据|附件|附证|材料)[\s._-]*\d{1,3}[\s._-]*/u, '')
        .replace(/_/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
    return normalized || getEvidenceFileStem(value).trim();
}
function buildNormalizedEvidenceName(fileName, relativePath) {
    const normalizedPath = normalizeEvidenceRelativePath(relativePath, fileName);
    const segments = normalizedPath.split('/').filter(Boolean);
    const folderSegments = segments.slice(1, -1);
    const contextSegments = folderSegments.slice(-2).map(cleanupEvidenceNameSegment).filter(Boolean);
    const baseName = cleanupEvidenceNameSegment(segments[segments.length - 1] ?? fileName);
    const mergedSegments = [...contextSegments, baseName].filter(Boolean);
    const dedupedSegments = mergedSegments.filter((segment, index) => mergedSegments.findIndex((candidate) => candidate.toLowerCase() === segment.toLowerCase()) === index);
    const candidate = dedupedSegments.join(' - ').trim();
    return candidate || getEvidenceFileStem(fileName);
}
function sortImportedEvidenceFiles(files) {
    return [...files].sort((left, right) => normalizeEvidenceRelativePath(left.relativePath, left.fileName).localeCompare(normalizeEvidenceRelativePath(right.relativePath, right.fileName), 'zh-CN'));
}
function normalizeImportedEvidenceFile(file) {
    const type = inferEvidenceType(file.fileName, file.sourceMimeType);
    const sourceMimeType = inferSourceMimeType(file.fileName, file.sourceMimeType, type);
    return {
        ...file,
        type,
        sourceMimeType,
        name: file.name?.trim() || buildNormalizedEvidenceName(file.fileName, file.relativePath),
        relativePath: normalizeEvidenceRelativePath(file.relativePath, file.fileName),
        ocrText: file.ocrText?.trim() || buildEvidenceOcrPlaceholder(file.fileName, type),
        pages: file.pages ?? (type === 'pdf' ? 1 : 1),
        anchorHint: file.anchorHint
            ?? (type === 'pdf'
                ? '第 1 页'
                : type === 'image'
                    ? '图片高亮区域'
                    : type === 'word'
                        ? '段落 1'
                        : '段落 1'),
        summaryStatus: file.summaryStatus ?? 'idle',
    };
}
function buildCertificate(caseFolder, evidences, role, focus) {
    const createdAt = new Date().toISOString();
    const paragraphs = evidences.map((evidence, index) => {
        const text = buildParagraphText(evidence, role, focus);
        return {
            id: createId(`paragraph-${index + 1}`),
            text,
            richText: buildParagraphRichText(text),
            note: `自动绑定到 ${evidence.number}，可继续人工校正定位信息。`,
            verified: index === 0,
            links: [createEvidenceLink(`paragraph-${index + 1}`, evidence)],
        };
    });
    return {
        id: createId('certificate'),
        caseId: caseFolder.id,
        title: `${role === 'plaintiff' ? '原告' : '被告'}质证意见`,
        role,
        focus,
        paragraphIds: paragraphs.map((paragraph) => paragraph.id),
        paragraphs,
        createdAt,
    };
}
function buildFallbackTitle(caseFolder, role) {
    return `${role === 'plaintiff' ? '原告' : '被告'}质证意见`;
}
function buildEvidenceContext(workspace, evidences) {
    const fragmentsByEvidenceId = new Map();
    for (const fragment of workspace.evidenceFragments) {
        const existing = fragmentsByEvidenceId.get(fragment.evidenceId) ?? [];
        existing.push(fragment);
        fragmentsByEvidenceId.set(fragment.evidenceId, existing);
    }
    return evidences.map((evidence) => ({
        insight: getLatestEvidenceInsight(workspace, evidence.id)
            ?? buildFallbackEvidenceInsightDraft(evidence, fragmentsByEvidenceId.get(evidence.id) ?? []),
        evidenceId: evidence.id,
        number: evidence.number,
        name: evidence.name,
        type: evidence.type,
        locator: evidence.anchorHint || (evidence.type === 'pdf' ? `第 ${evidence.pages ?? 1} 页` : '原件全文'),
        summary: summarizeForPrompt(getLatestEvidenceInsight(workspace, evidence.id)?.summary
            || evidence.summaryText
            || evidence.ocrText),
        fragments: (fragmentsByEvidenceId.get(evidence.id) ?? [])
            .slice(0, 4)
            .map((fragment) => ({
            id: fragment.id,
            locator: fragment.locator,
            text: summarizeForPrompt(fragment.text, 220),
        })),
    }));
}
function summarizeForPrompt(text, limit = 300) {
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (!normalized) {
        return '暂无可用摘要';
    }
    return normalized.length > limit ? `${normalized.slice(0, limit)}...` : normalized;
}
function inferParagraphLinksFromEvidenceNumbers(paragraph, evidences, paragraphIndex) {
    const evidenceMap = new Map(evidences.map((item) => [item.number.toLowerCase(), item]));
    const explicitNumbers = (paragraph.evidenceNumbers ?? []).map((item) => item.toLowerCase());
    const resolved = explicitNumbers
        .map((number) => evidenceMap.get(number) ?? null)
        .filter((item) => Boolean(item));
    const matched = resolved.length
        ? resolved
        : inferParagraphEvidencesByText(paragraph.text, evidences, paragraphIndex);
    return matched.map((evidence, index) => createEvidenceLink(`paragraph-${paragraphIndex + 1}`, evidence, evidence.anchorHint || (evidence.type === 'pdf' ? `第 ${evidence.pages ?? 1} 页` : '段落 1'), getQuote(evidence.summaryText || evidence.ocrText)));
}
function inferParagraphEvidencesByText(text, evidences, paragraphIndex) {
    const directMentioned = evidences.filter((evidence) => text.includes(evidence.number) || text.includes(evidence.name));
    if (directMentioned.length) {
        return directMentioned.slice(0, 2);
    }
    const scored = evidences
        .map((evidence) => ({
        evidence,
        score: scoreKeywords(text, [
            evidence.number,
            evidence.name,
            evidence.summaryText || '',
            evidence.anchorHint || '',
            summarizeForPrompt(evidence.ocrText, 180),
        ])
            + (text.includes(evidence.number) ? 6 : 0)
            + (text.includes(evidence.name) ? 4 : 0),
    }))
        .sort((left, right) => right.score - left.score);
    const positivelyMatched = scored
        .filter((item) => item.score > 0)
        .slice(0, 2)
        .map((item) => item.evidence);
    if (positivelyMatched.length) {
        return positivelyMatched;
    }
    return evidences.length ? [evidences[Math.min(paragraphIndex, evidences.length - 1)]] : [];
}
function buildCertificateParagraphsFromLlmOutput(paragraphs, evidences, prompt, previousParagraphs) {
    return paragraphs
        .map((item) => ({
        text: item.text?.trim() ?? '',
        evidenceNumbers: item.evidenceNumbers ?? [],
    }))
        .filter((item) => item.text)
        .map((item, index) => {
        const previousParagraph = previousParagraphs?.[index];
        const id = previousParagraph?.id ?? createId(`paragraph-${index + 1}`);
        return {
            id,
            text: item.text,
            richText: buildParagraphRichText(item.text),
            note: prompt?.trim() ? `根据用户要求生成：${prompt.trim()}` : '由 AI 基于证据与案件要求生成。',
            verified: false,
            links: inferParagraphLinksFromEvidenceNumbers(item, evidences, index),
        };
    });
}
function normalizeStreamedTagText(value) {
    if (!value) {
        return '';
    }
    return value
        .replace(/\r\n/g, '\n')
        .replace(/\u00a0/g, ' ')
        .trim();
}
function parseEvidenceNumbersAttribute(value) {
    if (!value) {
        return [];
    }
    return Array.from(new Set(value
        .split(/[,\s，]+/)
        .map((item) => item.trim().toUpperCase())
        .filter((item) => /^E\d+$/.test(item))));
}
function extractSingleTag(raw, tag) {
    const matched = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i').exec(raw);
    return normalizeStreamedTagText(matched?.[1]);
}
function parseStreamedCertificateDraft(raw) {
    const paragraphs = [];
    const paragraphRegex = /<paragraph(?:\s+evidence="([^"]*)")?\s*>([\s\S]*?)<\/paragraph>/gi;
    for (const matched of raw.matchAll(paragraphRegex)) {
        const text = normalizeStreamedTagText(matched[2]);
        if (!text) {
            continue;
        }
        paragraphs.push({
            text,
            evidenceNumbers: parseEvidenceNumbersAttribute(matched[1]),
        });
    }
    return {
        title: extractSingleTag(raw, 'title') || undefined,
        focus: extractSingleTag(raw, 'focus') || undefined,
        paragraphs,
        agentReply: extractSingleTag(raw, 'reply') || undefined,
    };
}
function buildStreamingCertificateMessages(params) {
    const baseSystem = [
        params.mode === 'rewrite' ? '你是律师文书改写助手。' : '你是律师文书起草助手。',
        params.mode === 'rewrite'
            ? '请基于当前草稿、案件记忆、证据理解结果和用户追问，对当前文书做定向改写。'
            : '请基于案件信息、案件记忆、证据理解结果和用户要求，生成中文法律文书草稿。',
        '你现在必须按可流式解析的标签格式输出，禁止使用 Markdown 代码块，禁止输出标签以外的解释说明。',
        '输出顺序必须严格为：<title>...</title><focus>...</focus><paragraph evidence="E01,E02">...</paragraph>...<reply>...</reply>。',
        '至少输出 6 个 <paragraph> 段落，必要时可输出到 18 段。',
        '每个 <paragraph> 必须只包含一整段正式法律文书内容，且 evidence 属性必须填写至少 1 个证据编号，不能为空；如主要依据多份证据，可填写 1 到 3 个编号，例如 evidence="E01,E02"。',
        '不要编造不存在的证据，不要引用未提供的事实。',
        '输出的 title、focus、paragraph 文本必须是面向法官或诉讼参与人的正式法律文书内容，不得写入任何技术处理过程。',
        '严禁出现以下表达或同类含义：OCR、图片识别、文本抽取、自动提取、大模型、AI 分析、向量召回、证据匹配、支持矩阵、时间线抽取、结构化记忆、prompt、system prompt、系统判断、模型认为。',
        '如当前文书类型为质证意见，段落必须体现标题、案号案由、质证人、质证日期、总引言、分证据质证及综合质证意见这些层级；不能省略为普通散文段落。',
        params.sampleStyleGuide,
    ].join(' ');
    const userPayload = {
        caseName: params.caseFolder.name,
        caseDescription: params.caseFolder.description,
        role: params.role,
        draftingFocus: params.focus,
        userPrompt: params.prompt,
        sampleStyleGuide: params.sampleStyleGuide,
        caseMemory: params.caseMemoryContext,
        currentDraft: params.currentDraft,
        evidences: params.evidenceContext,
    };
    return [
        {
            role: 'system',
            content: baseSystem,
        },
        {
            role: 'user',
            content: JSON.stringify(userPayload),
        },
    ];
}
async function streamStructuredCertificateFromLlm(params) {
    let raw = '';
    let emittedParagraphCount = 0;
    let lastTitle = '';
    let lastFocus = '';
    for await (const chunk of createChatCompletionStream({
        messages: params.messages,
        temperature: 0.25,
        maxTokens: 2800,
    })) {
        raw += chunk;
        const parsed = parseStreamedCertificateDraft(raw);
        if ((parsed.title && parsed.title !== lastTitle) || (parsed.focus && parsed.focus !== lastFocus)) {
            lastTitle = parsed.title || lastTitle;
            lastFocus = parsed.focus || lastFocus;
            await params.onEvent({
                type: 'meta',
                title: lastTitle || undefined,
                focus: lastFocus || undefined,
            });
        }
        while (emittedParagraphCount < parsed.paragraphs.length) {
            const paragraph = parsed.paragraphs[emittedParagraphCount];
            await params.onEvent({
                type: 'paragraph',
                index: emittedParagraphCount,
                text: paragraph.text,
                evidenceNumbers: paragraph.evidenceNumbers,
            });
            emittedParagraphCount += 1;
        }
    }
    return parseStreamedCertificateDraft(raw);
}
function buildDraftContext(certificate) {
    return certificate.paragraphs.map((paragraph, index) => ({
        paragraphIndex: index + 1,
        text: paragraph.text,
        evidenceLinks: getParagraphLinks(paragraph).map((link) => ({
            locator: link.locator,
            quote: link.quote,
        })),
    }));
}
function inferLegalDocumentKind(input) {
    const source = [input.prompt, input.title, input.focus].filter(Boolean).join(' ').toLowerCase();
    if (source.includes('答辩状') || source.includes('答辩意见')) {
        return 'answer';
    }
    return 'cross_examination';
}
function buildCertificateSampleStyleGuide(params) {
    const roleLabel = params.role === 'defendant' ? '被告' : '原告';
    if (params.kind === 'answer') {
        return [
            '请优先按“民事答辩状”样式组织文书结构。',
            '整体结构尽量采用：标题 -> 当事人基本信息 -> 引言 -> 基本事实陈述 -> 对各项诉讼请求的逐项答辩 -> 专门法律论证 -> 判例或法条支持 -> 总体答辩意见 -> 此致法院 -> 落款日期 -> 附主要法律依据。',
            '正文主轴应围绕“答辩人对原告诉讼请求的答辩意见”展开，优先使用“关于第一项诉讼请求……”“关于第二项诉讼请求……”等写法逐项回应。',
            '如果需要展开论证，应使用“第一……第二……第三……”的层次结构，重点论证事实依据、法律依据、因果关系、责任分担及裁判规则。',
            '答辩状应突出：答辩人的事实陈述、对原告诉讼请求的逐项反驳、法律关系定性、适用法条和请求法院采纳的处理结论。',
            '正文措辞要像正式向法院提交的民事答辩状，不要写成质证提纲、产品说明、办案笔记或口语化对话。',
        ].join(' ');
    }
    return [
        `必须严格按照“${roleLabel}质证意见”样式组织文书结构，不要只写成泛化的质证提纲。`,
        `标题必须直接写“${roleLabel}质证意见”，不要写“质证书”“质证提纲”“证据意见”等其他标题。`,
        '标题下方必须单列案件基础信息，写成“案号：……    案由：……”的形式；如现有材料未明确案号或案由，可保留空白或用“待补充”表示，但结构必须保留。',
        `案件基础信息后必须单列“质证人（${roleLabel}）：……”和“质证日期：……”。`,
        `正文开头必须先写一段总引言，采用“${roleLabel}……现就……提交的证据材料，发表如下质证意见：”这一类正式表述。`,
        '正文主体必须按“ 一、对原告证据一（……）的质证意见 / 二、对原告证据二（……）的质证意见 / 三、对原告证据三（……）的质证意见 ”这种层级展开，不能只按争点分段概述。',
        '对每一组证据，必须尽量完整写出“【对真实性的意见】”“【对合法性、关联性的意见】”“【对证明目的的意见】”三个固定小标题；如某项证据通常不涉及合法性争议，也应优先保留该标题后再给出简洁意见。',
        '当“对证明目的的意见”为不予认可或部分认可时，后文必须继续分层展开，优先使用“（一）……（二）……（三）……”以及“第一、第二、第三”的论证结构，而不是一句话带过。',
        '每一项论证都要紧扣该组证据欲证明的具体事实，分别评价其能否证明、证明到何种程度、为何不足以支持对方主张。',
        '文末必须补一段综合质证意见，对证据整体证明力、事实认定和应否支持对方请求作归纳性陈述。',
        '全文措辞必须像正式提交法院的质证意见，保持完整、严肃、专业，不要写成摘要、提示词回显、产品说明、办案笔记或口语化对话。',
    ].join(' ');
}
async function generateCertificateWithLlm(params) {
    const evidenceContext = buildEvidenceContext(params.workspace, params.evidences);
    const caseMemoryContext = buildCaseMemoryPromptContext(params.caseContextMemory);
    const documentKind = inferLegalDocumentKind({
        prompt: params.prompt,
        focus: params.focus,
    });
    const sampleStyleGuide = buildCertificateSampleStyleGuide({
        role: params.role,
        kind: documentKind,
    });
    const completion = await createChatCompletion({
        messages: [
            {
                role: 'system',
                content: [
                    '你是律师文书起草助手。',
                    '请基于案件信息、案件记忆、证据理解结果和用户要求，生成中文法律文书草稿。',
                    '严格返回 JSON 对象，格式为 {"title":"...","focus":"...","agentReply":"...","paragraphs":[{"text":"...","evidenceNumbers":["E01","E02"]}]}。',
                    'paragraphs 至少 6 段，最多 18 段。',
                    '每个段落都必须返回非空 evidenceNumbers，至少 1 个，最多 3 个，禁止返回空数组。',
                    '不要编造不存在的证据，不要引用未提供的事实。',
                    '优先使用案件记忆中的争点、时间线、支持矩阵来组织结构。',
                    '行文要专业、克制、适合法律工作场景。',
                    '输出的 title、focus、paragraphs.text 必须是面向法官或诉讼参与人的正式法律文书内容，不得写入任何技术处理过程。',
                    '严禁出现以下表达或同类含义：OCR、图片识别、文本抽取、自动提取、大模型、AI 分析、向量召回、证据匹配、支持矩阵、时间线抽取、结构化记忆、prompt、system prompt、系统判断、模型认为。',
                    '如果需要说明证据基础，只能写“依据现有证据”“结合聊天记录、合同、票据等材料”，不能提及系统如何处理这些材料。',
                    '如当前文书类型为质证意见，段落必须体现标题、案号案由、质证人、质证日期、总引言、分证据质证及综合质证意见这些层级；不能省略为普通散文段落。',
                    sampleStyleGuide,
                ].join(' '),
            },
            {
                role: 'user',
                content: JSON.stringify({
                    caseName: params.caseFolder.name,
                    caseDescription: params.caseFolder.description,
                    role: params.role,
                    draftingFocus: params.focus,
                    userPrompt: params.prompt?.trim() || '请基于现有证据生成一版结构完整、可用于后续核验修改的法律文书。',
                    sampleStyleGuide,
                    caseMemory: caseMemoryContext,
                    evidences: evidenceContext,
                }),
            },
        ],
        temperature: 0.3,
        maxTokens: 2400,
        responseFormat: 'json_object',
    });
    const parsed = JSON.parse(completion.content);
    const generatedParagraphs = (parsed.paragraphs ?? [])
        .map((item) => item.text?.trim() ?? '')
        .filter(Boolean);
    if (!generatedParagraphs.length) {
        throw new Error('模型未返回有效文书段落。');
    }
    const paragraphs = buildCertificateParagraphsFromLlmOutput(parsed.paragraphs ?? [], params.evidences, params.prompt);
    const certificate = {
        id: createId('certificate'),
        caseId: params.caseFolder.id,
        title: parsed.title?.trim() || buildFallbackTitle(params.caseFolder, params.role),
        role: params.role,
        focus: parsed.focus?.trim() || params.focus,
        paragraphIds: paragraphs.map((paragraph) => paragraph.id),
        paragraphs,
        createdAt: new Date().toISOString(),
    };
    return {
        certificate,
        agentReply: parsed.agentReply?.trim() || '我已根据当前证据和你的要求生成一版文书草稿，并尽量为各段落绑定了对应证据。',
    };
}
async function rewriteCertificateWithLlm(params) {
    const evidenceContext = buildEvidenceContext(params.workspace, params.evidences);
    const caseMemoryContext = buildCaseMemoryPromptContext(params.caseContextMemory);
    const documentKind = inferLegalDocumentKind({
        prompt: params.prompt,
        title: params.certificate.title,
        focus: params.certificate.focus,
    });
    const sampleStyleGuide = buildCertificateSampleStyleGuide({
        role: params.certificate.role,
        kind: documentKind,
    });
    const completion = await createChatCompletion({
        messages: [
            {
                role: 'system',
                content: [
                    '你是律师文书改写助手。',
                    '请基于当前草稿、案件记忆、案件证据和用户追问，对当前文书做定向改写。',
                    '优先在现有结构基础上调整，不要无故整篇推翻重写。',
                    '严格返回 JSON 对象，格式为 {"title":"...","focus":"...","agentReply":"...","paragraphs":[{"text":"...","evidenceNumbers":["E01"]}]}。',
                    'paragraphs 保持 4 到 10 段，行文专业、克制，不得编造新事实或新证据。',
                    '每个段落都必须返回非空 evidenceNumbers，至少 1 个，最多 3 个，禁止返回空数组。',
                    '输出的 title、focus、paragraphs.text 必须保持正式法律文书口径，不得出现技术处理过程、系统工作流或模型分析措辞。',
                    '严禁出现以下表达或同类含义：OCR、图片识别、文本抽取、自动提取、大模型、AI 分析、向量召回、证据匹配、支持矩阵、时间线抽取、结构化记忆、prompt、system prompt、系统判断、模型认为。',
                    '如需交代证据依据，只能写案件事实、证据名称、证据内容及其证明事项，不能描述系统如何得到这些内容。',
                    sampleStyleGuide,
                ].join(' '),
            },
            {
                role: 'user',
                content: JSON.stringify({
                    caseName: params.caseFolder.name,
                    currentTitle: params.certificate.title,
                    currentFocus: params.certificate.focus,
                    userPrompt: params.prompt.trim(),
                    sampleStyleGuide,
                    caseMemory: caseMemoryContext,
                    currentDraft: buildDraftContext(params.certificate),
                    evidences: evidenceContext,
                }),
            },
        ],
        temperature: 0.25,
        maxTokens: 2600,
        responseFormat: 'json_object',
    });
    const parsed = JSON.parse(completion.content);
    const paragraphs = buildCertificateParagraphsFromLlmOutput(parsed.paragraphs ?? [], params.evidences, params.prompt, params.certificate.paragraphs);
    if (!paragraphs.length) {
        throw new Error('模型未返回有效改写结果。');
    }
    return {
        certificate: {
            ...params.certificate,
            title: parsed.title?.trim() || params.certificate.title,
            focus: parsed.focus?.trim() || params.certificate.focus,
            paragraphIds: paragraphs.map((paragraph) => paragraph.id),
            paragraphs,
        },
        agentReply: parsed.agentReply?.trim() || '我已根据你的追问对当前草稿完成二次改写，并尽量保留证据来源。',
    };
}
function splitImportedParagraphs(content) {
    const normalized = content
        .replace(/\r\n/g, '\n')
        .replace(/\u00a0/g, ' ')
        .trim();
    if (!normalized) {
        return [];
    }
    return normalized
        .split(/\n\s*\n+/)
        .map((item) => item.trim())
        .filter(Boolean);
}
function buildImportedCertificate(caseFolder, payload) {
    const createdAt = new Date().toISOString();
    const inputParagraphs = payload.paragraphs?.filter((item) => item.text.trim()) ?? [];
    const paragraphs = inputParagraphs.length
        ? inputParagraphs
        : splitImportedParagraphs(payload.content).map((text) => ({ text }));
    const normalizedParagraphs = (paragraphs.length ? paragraphs : [{ text: payload.content.trim() || '导入文书暂无正文内容。' }])
        .map((paragraph, index) => ({
        id: createId(`paragraph-${index + 1}`),
        text: paragraph.text.trim(),
        richText: paragraph.richText?.trim() || buildParagraphRichText(paragraph.text),
        note: `导入自 ${payload.sourceFileName}，可继续补充证据定位与核验批注。`,
        verified: false,
        links: [],
    }));
    return {
        id: createId('certificate'),
        caseId: caseFolder.id,
        title: payload.title.trim() || `${caseFolder.name}导入文书`,
        role: 'plaintiff',
        focus: '导入文书',
        paragraphIds: normalizedParagraphs.map((paragraph) => paragraph.id),
        paragraphs: normalizedParagraphs,
        createdAt,
    };
}
function attachAutoEvidenceLinksToCertificate(certificate, evidences) {
    if (!certificate.paragraphs.length || !evidences.length) {
        return certificate;
    }
    const evidenceById = new Map(evidences.map((item) => [item.id, item]));
    const evidenceFragments = buildEvidenceFragments(evidences);
    const claimUnits = buildClaimUnits([certificate]);
    const matches = buildClaimEvidenceMatches([certificate], claimUnits, evidenceFragments);
    const claimIdsByParagraph = new Map();
    for (const claim of claimUnits) {
        const existing = claimIdsByParagraph.get(claim.paragraphId) ?? [];
        existing.push(claim.id);
        claimIdsByParagraph.set(claim.paragraphId, existing);
    }
    return {
        ...certificate,
        paragraphs: certificate.paragraphs.map((paragraph) => {
            const claimIds = new Set(claimIdsByParagraph.get(paragraph.id) ?? []);
            const preservedLinks = getParagraphLinks(paragraph).filter((item) => item.note !== AUTO_EVIDENCE_LINK_NOTE);
            const preservedEvidenceIds = new Set(preservedLinks.map((item) => item.evidenceId));
            const explicitLinks = findExplicitEvidenceMentions(paragraph.text, evidences)
                .filter((evidence) => !preservedEvidenceIds.has(evidence.id))
                .slice(0, 2)
                .map((evidence) => ({
                ...createEvidenceLink(paragraph.id, evidence, evidence.anchorHint || '段落 1', getQuote(paragraph.text)),
                note: AUTO_EVIDENCE_LINK_NOTE,
            }));
            const explicitEvidenceIds = new Set(explicitLinks.map((item) => item.evidenceId));
            const autoLinks = (!claimIds.size ? [] : matches
                .filter((match) => claimIds.has(match.claimUnitId)
                && !preservedEvidenceIds.has(match.evidenceId)
                && !explicitEvidenceIds.has(match.evidenceId)
                && (match.relation === 'support' || match.relation === 'partial')
                && match.score >= 0.58)
                .sort((left, right) => {
                const relationPriority = { support: 0, partial: 1, contradict: 2, unrelated: 3, insufficient: 4 };
                return relationPriority[left.relation] - relationPriority[right.relation] || right.score - left.score;
            })
                .filter((match, index, list) => list.findIndex((item) => item.evidenceId === match.evidenceId) === index)
                .slice(0, 2)
                .flatMap((match) => {
                const evidence = evidenceById.get(match.evidenceId);
                if (!evidence) {
                    return [];
                }
                return [{
                        ...createEvidenceLink(paragraph.id, evidence, match.locator, match.quote),
                        note: AUTO_EVIDENCE_LINK_NOTE,
                    }];
            }));
            const availableAutoSlots = Math.max(0, 2 - preservedLinks.length);
            const nextLinks = [
                ...preservedLinks,
                ...[...explicitLinks, ...autoLinks].slice(0, availableAutoSlots),
            ];
            return normalizeParagraph({
                ...paragraph,
                links: nextLinks,
                link: nextLinks[0],
            });
        }),
    };
}
function mergeKnowledgeCasesIntoWorkspace(workspace, items) {
    if (!items.length) {
        return [];
    }
    const mergedItems = [];
    for (const rawItem of items) {
        const item = normalizeImportedKnowledgeCase(rawItem);
        const existingIndex = workspace.knowledgeCases.findIndex((entry) => (entry.sourceUrl && item.sourceUrl && entry.sourceUrl === item.sourceUrl)
            || (entry.caseNumber === item.caseNumber && entry.title === item.title));
        if (existingIndex >= 0) {
            const existing = workspace.knowledgeCases[existingIndex];
            const merged = {
                ...existing,
                ...item,
                id: existing.id,
                excerpts: item.excerpts.length ? item.excerpts : existing.excerpts,
            };
            workspace.knowledgeCases[existingIndex] = merged;
            mergedItems.push(merged);
            continue;
        }
        workspace.knowledgeCases.unshift(item);
        mergedItems.push(item);
    }
    return mergedItems;
}
async function recommendKnowledgeCasesFromWorkspace(workspace, payload) {
    const caseFolder = payload.caseId ? workspace.cases.find((item) => item.id === payload.caseId) : null;
    const source = [caseFolder?.name, caseFolder?.description, payload.focus, payload.paragraphText].filter(Boolean).join(' ');
    const externalItems = isYuandianCaseSearchConfigured() && source.trim()
        ? await searchYuandianCases(source, 6).catch(() => [])
        : [];
    if (externalItems.length) {
        return {
            items: externalItems.slice(0, 6),
        };
    }
    const localItems = [...workspace.knowledgeCases]
        .map((item) => ({
        ...item,
        score: scoreKeywords(source, [
            item.title,
            item.cause,
            item.issueSummary,
            item.holdingSummary,
            item.reasoningSummary,
            ...item.keywords,
            ...item.focusTags,
            ...item.referencedStatutes,
        ]) + item.excerpts.reduce((total, excerpt) => total + scoreKeywords(source, [excerpt.content, ...excerpt.keywords]), 0),
    }))
        .sort((left, right) => right.score - left.score)
        .slice(0, 6)
        .map(({ score: _score, ...item }) => item);
    const items = [...localItems]
        .filter((item, index, entries) => entries.findIndex((candidate) => (candidate.sourceUrl && item.sourceUrl && candidate.sourceUrl === item.sourceUrl)
        || (candidate.caseNumber === item.caseNumber && candidate.title === item.title)) === index)
        .slice(0, 6);
    return {
        items,
    };
}
async function hydrateWorkspaceKnowledgeFiles(workspace) {
    if (!shouldUseCommercialKnowledgeStore() || !isDatabaseEnabled()) {
        return workspace;
    }
    try {
        return {
            ...workspace,
            knowledgeFiles: await listKnowledgeFilesForWorkspace(),
        };
    }
    catch {
        return workspace;
    }
}
function buildLocalKnowledgeVectorConfigurationError() {
    return '本地 RAG 向量能力尚未配置，请先配置 Embedding API。';
}
async function syncLocalKnowledgeFileVectorIndex(target) {
    const extractedText = target.extractedText.trim();
    const chunks = extractedText ? chunkKnowledgeText(extractedText) : [];
    const now = new Date().toISOString();
    target.summary = extractedText ? summarizeKnowledgeText(extractedText) : '文件已上传，待完成文本抽取后再参与检索。';
    target.vectorChunkCount = chunks.length;
    target.vectorKeywords = extractedText ? buildKnowledgeVectorKeywords(target.title, extractedText) : [];
    target.vectorUpdatedAt = undefined;
    if (!extractedText) {
        await removeLocalKnowledgeFileIndex(target.id);
        target.vectorStatus = target.extractionStatus === 'failed' ? 'failed' : 'pending';
        target.vectorError = target.extractionError?.trim() || '当前文件尚未完成文本抽取，暂未进入向量化。';
        target.updatedAt = now;
        return;
    }
    if (!isEmbeddingConfigured()) {
        await removeLocalKnowledgeFileIndex(target.id);
        target.vectorStatus = 'failed';
        target.vectorError = buildLocalKnowledgeVectorConfigurationError();
        target.updatedAt = now;
        return;
    }
    try {
        const embeddings = await createEmbeddings(chunks);
        await replaceLocalKnowledgeFileIndex({
            fileId: target.id,
            fileTitle: target.title,
            fileName: target.fileName,
            updatedAt: now,
            chunks: chunks.map((chunk, chunkIndex) => ({
                chunkIndex,
                content: chunk,
                embedding: embeddings[chunkIndex],
            })),
        });
        target.vectorStatus = 'ready';
        target.vectorError = undefined;
        target.vectorUpdatedAt = now;
    }
    catch (error) {
        await removeLocalKnowledgeFileIndex(target.id);
        target.vectorStatus = 'failed';
        target.vectorError = error instanceof Error ? error.message : '本地知识向量化失败。';
    }
    target.updatedAt = now;
}
function rankKnowledgeFileRagChunks(workspace, source, limit = 6) {
    if (!source.trim()) {
        return [];
    }
    const ranked = workspace.knowledgeFiles
        .filter((item) => item.extractedText.trim())
        .flatMap((file) => chunkKnowledgeText(file.extractedText).map((chunk) => ({
        fileId: file.id,
        fileTitle: file.title,
        fileName: file.fileName,
        content: chunk,
        score: scoreKeywords(source, [
            file.title,
            file.fileName,
            file.summary,
            ...file.vectorKeywords,
            chunk,
        ])
            + extractStatuteMentions(chunk, 4).length * 4,
    })))
        .filter((item) => item.score > 0)
        .sort((left, right) => right.score - left.score);
    return ranked.slice(0, limit);
}
async function searchLocalKnowledgeFileRagChunks(source, limit = 6) {
    if (!source.trim() || !isEmbeddingConfigured()) {
        return [];
    }
    try {
        const embedding = await createEmbedding(source.trim());
        return await searchLocalKnowledgeRagChunks({
            embedding,
            limit,
        });
    }
    catch {
        return [];
    }
}
async function getKnowledgeFileRagChunks(workspace, source, limit = 6) {
    if (!source.trim()) {
        return [];
    }
    if (shouldUseCommercialKnowledgeStore() && isDatabaseEnabled()) {
        try {
            const commercialChunks = await searchCommercialKnowledgeFileRagChunks({
                source,
                limit,
            });
            if (commercialChunks.length) {
                return commercialChunks;
            }
        }
        catch {
            // Keep the recommendation flow usable when the commercial RAG stack is
            // not fully available in the current environment.
        }
    }
    const localChunks = await searchLocalKnowledgeFileRagChunks(source, limit);
    if (localChunks.length) {
        return localChunks;
    }
    return rankKnowledgeFileRagChunks(workspace, source, limit);
}
async function recommendKnowledgeStatutesFromWorkspace(workspace, payload) {
    const hydratedWorkspace = hydrateWorkspaceStatutesFromKnowledgeFiles(workspace);
    const caseFolder = payload.caseId ? hydratedWorkspace.cases.find((item) => item.id === payload.caseId) : null;
    const source = [caseFolder?.name, caseFolder?.description, payload.focus, payload.paragraphText].filter(Boolean).join(' ');
    const ragChunks = await getKnowledgeFileRagChunks(hydratedWorkspace, source, 6);
    const chunkSource = ragChunks.map((item) => `${item.fileTitle}\n${item.content}`).join('\n');
    const scoringSource = [source, chunkSource].filter(Boolean).join('\n');
    const boostedArticleIds = new Set();
    for (const chunk of ragChunks) {
        for (const mention of extractStatuteMentions(chunk.content, 4)) {
            const binding = findLocalStatuteBinding(hydratedWorkspace, mention);
            if (binding) {
                boostedArticleIds.add(binding.article.id);
            }
        }
    }
    const items = [...hydratedWorkspace.knowledgeStatutes]
        .map((document) => {
        const rankedArticles = [...document.articles]
            .map((article) => ({
            article,
            score: scoreKeywords(scoringSource || source, [
                document.title,
                document.docType,
                document.issuer,
                ...document.keywords,
                article.articleNumber,
                article.content,
                article.plainText,
                ...article.aliases,
                ...article.topicTags,
            ])
                + (boostedArticleIds.has(article.id) ? 10 : 0),
        }))
            .sort((left, right) => right.score - left.score);
        const bestArticleScore = rankedArticles[0]?.score ?? 0;
        const documentScore = scoreKeywords(scoringSource || source, [document.title, document.docType, document.issuer, ...document.keywords])
            + bestArticleScore;
        return {
            ...document,
            articles: rankedArticles.map((item) => item.article),
            score: documentScore,
        };
    })
        .filter((item) => item.score > 0 || !source.trim())
        .sort((left, right) => right.score - left.score)
        .slice(0, 5)
        .map(({ score: _score, ...document }) => document);
    return {
        items,
    };
}
async function recommendStatuteBindingsFromWorkspace(workspace, intents, cache, limit = 2) {
    const hydratedWorkspace = hydrateWorkspaceStatutesFromKnowledgeFiles(workspace);
    const results = [];
    for (const intent of intents) {
        if (intent.lawTitle && intent.articleNumber) {
            const binding = await resolveStatuteMention(hydratedWorkspace, {
                raw: `${intent.lawTitle}${intent.articleNumber}`,
                lawTitle: intent.lawTitle,
                articleNumber: intent.articleNumber,
            }, cache);
            if (binding && !results.some((item) => item.article.id === binding.article.id)) {
                results.push(binding);
            }
            if (results.length >= limit) {
                break;
            }
            continue;
        }
        const source = [
            intent.lawTitle ?? '',
            intent.articleNumber ?? '',
            intent.query ?? '',
            ...(intent.keywords ?? []),
            intent.reason ?? '',
        ].filter(Boolean).join(' ');
        const rankedBindings = workspace.knowledgeStatutes
            .flatMap((document) => document.articles.map((article) => hydrateResolvedStatuteBindingFromKnowledgeFiles(hydratedWorkspace, {
            document,
            article,
        })))
            .map(({ document, article }) => ({
            document,
            article,
            score: scoreKeywords(source, [
                document.title,
                document.docType,
                document.issuer,
                ...document.keywords,
                article.articleNumber,
                article.content,
                article.plainText,
                ...article.aliases,
                ...article.topicTags,
            ])
                + (intent.lawTitle && documentMatchesLawTitle(document, intent.lawTitle) ? 6 : 0)
                + (intent.articleNumber && normalizeArticleNumber(article.articleNumber)?.articleNumber === intent.articleNumber ? 6 : 0),
        }))
            .filter((item) => item.score > 0)
            .sort((left, right) => right.score - left.score);
        for (const item of rankedBindings) {
            if (results.some((entry) => entry.article.id === item.article.id)) {
                continue;
            }
            results.push({
                document: item.document,
                article: item.article,
            });
            if (results.length >= limit) {
                break;
            }
        }
        if (results.length >= limit) {
            break;
        }
    }
    return results;
}
async function attachAutoStatuteReferencesToCertificateWithLlm(workspace, certificate, analyses) {
    const cache = new Map();
    const paragraphs = [];
    for (let index = 0; index < certificate.paragraphs.length; index += 1) {
        const paragraph = certificate.paragraphs[index];
        const preservedReferences = (paragraph.references ?? []).filter((item) => item.note !== AUTO_STATUTE_REFERENCE_NOTE);
        const analysis = analyses.get(paragraph.id);
        const llmBindings = await recommendStatuteBindingsFromWorkspace(workspace, analysis?.statuteIntents ?? [], cache, Math.max(0, 2 - preservedReferences.filter((item) => item.type === 'statute').length));
        const llmReferences = llmBindings
            .map((binding) => buildStatuteReference(binding.document, binding.article))
            .filter((item, itemIndex, items) => items.findIndex((candidate) => candidate.targetId === item.targetId) === itemIndex);
        paragraphs.push(normalizeParagraph({
            ...paragraph,
            references: [...preservedReferences, ...llmReferences],
        }));
    }
    return {
        ...certificate,
        paragraphs,
    };
}
async function attachAutoCaseReferencesToCertificateWithLlm(workspace, certificate, analyses) {
    const caseFolder = workspace.cases.find((item) => item.id === certificate.caseId) ?? null;
    const queryCache = new Map();
    const paragraphs = [];
    for (let index = 0; index < certificate.paragraphs.length; index += 1) {
        const paragraph = certificate.paragraphs[index];
        const preservedReferences = (paragraph.references ?? []).filter((item) => item.note !== AUTO_CASE_REFERENCE_NOTE);
        const analysis = analyses.get(paragraph.id);
        const caseReferences = [];
        for (const intent of analysis?.caseIntents ?? []) {
            const query = [intent.query, paragraph.text].filter(Boolean).join(' ');
            if (!queryCache.has(query)) {
                const { items } = await recommendKnowledgeCasesFromWorkspace(workspace, {
                    caseId: caseFolder?.id,
                    paragraphText: query,
                    focus: certificate.focus || caseFolder?.description,
                });
                queryCache.set(query, mergeKnowledgeCasesIntoWorkspace(workspace, items));
            }
            const entries = queryCache.get(query) ?? [];
            for (const entry of entries) {
                const excerpt = entry.excerpts[0];
                if (!excerpt) {
                    continue;
                }
                if (preservedReferences.some((item) => item.type === 'case' && item.targetId === excerpt.id)
                    || caseReferences.some((item) => item.targetId === excerpt.id)) {
                    continue;
                }
                caseReferences.push(buildCaseReference(entry, excerpt));
                if (caseReferences.length >= Math.max(0, 2 - preservedReferences.filter((item) => item.type === 'case').length)) {
                    break;
                }
            }
            if (caseReferences.length >= Math.max(0, 2 - preservedReferences.filter((item) => item.type === 'case').length)) {
                break;
            }
        }
        paragraphs.push(normalizeParagraph({
            ...paragraph,
            references: [...preservedReferences, ...caseReferences],
        }));
    }
    return {
        ...certificate,
        paragraphs,
    };
}
async function attachAutoCaseReferencesToParagraph(workspace, paragraph, payload) {
    const preservedReferences = (paragraph.references ?? []).filter((item) => item.note !== AUTO_CASE_REFERENCE_NOTE);
    if (!paragraphMentionsCaseReference(paragraph.text)) {
        return normalizeParagraph({
            ...paragraph,
            references: preservedReferences,
        });
    }
    const { items } = await recommendKnowledgeCasesFromWorkspace(workspace, {
        caseId: payload.caseId,
        paragraphText: paragraph.text,
        focus: payload.focus,
    });
    const mergedEntries = mergeKnowledgeCasesIntoWorkspace(workspace, items);
    const autoReferences = [];
    for (const entry of mergedEntries) {
        const excerpt = entry.excerpts[0];
        if (!excerpt) {
            continue;
        }
        if (preservedReferences.some((item) => item.type === 'case' && item.targetId === excerpt.id)
            || autoReferences.some((item) => item.targetId === excerpt.id)) {
            continue;
        }
        autoReferences.push(buildCaseReference(entry, excerpt));
        if (autoReferences.length >= 2) {
            break;
        }
    }
    return normalizeParagraph({
        ...paragraph,
        references: [...preservedReferences, ...autoReferences],
    });
}
async function attachAutoCaseReferencesToCertificate(workspace, certificate) {
    const caseFolder = workspace.cases.find((item) => item.id === certificate.caseId) ?? null;
    const paragraphs = [];
    for (const paragraph of certificate.paragraphs) {
        paragraphs.push(await attachAutoCaseReferencesToParagraph(workspace, paragraph, {
            caseId: caseFolder?.id,
            focus: certificate.focus || caseFolder?.description,
        }));
    }
    return {
        ...certificate,
        paragraphs,
    };
}
function withToken(workspace, token = 'lawverify-demo-token') {
    return {
        token,
        workspace,
    };
}
function isEmailAccount(value) {
    return /\S+@\S+\.\S+/.test(value.trim());
}
export async function login(payload) {
    const account = payload.account.trim();
    if (!account) {
        throw new Error('请输入手机号或邮箱。');
    }
    if (payload.loginType === 'password' && payload.password.trim().length < 6) {
        throw new Error('密码长度至少为 6 位。');
    }
    return runWithWorkspaceAccount(isEmailAccount(account) ? account.toLowerCase() : null, async () => {
        const workspace = await readWorkspace();
        return withToken(workspace);
    });
}
export async function createCloudWorkspaceSession(payload) {
    const email = payload.email.trim().toLowerCase();
    if (!email) {
        throw new Error('请输入官网账号邮箱。');
    }
    return runWithWorkspaceAccount(email, async () => {
        const workspace = await readWorkspace();
        workspace.user = {
            ...workspace.user,
            email,
            name: payload.name?.trim() || workspace.user.name,
            organization: payload.organization?.trim() || workspace.user.organization,
            title: payload.role?.trim() || workspace.user.title,
        };
        await writeWorkspace(workspace);
        return withToken(workspace);
    });
}
export async function bindWorkspaceCloudAccount(payload) {
    const email = payload.email.trim().toLowerCase();
    if (!email) {
        throw new Error('请输入官网账号邮箱。');
    }
    return runWithWorkspaceAccount(email, async () => {
        const workspace = await readWorkspace();
        workspace.user = {
            ...workspace.user,
            email,
            name: payload.name?.trim() || workspace.user.name,
            organization: payload.organization?.trim() || workspace.user.organization,
            title: payload.role?.trim() || workspace.user.title,
        };
        await writeWorkspace(workspace);
        return { workspace };
    });
}
export async function bootstrap() {
    const workspace = hydrateWorkspaceStatutesFromKnowledgeFiles(await hydrateWorkspaceKnowledgeFiles(await readWorkspace()));
    return { workspace };
}
export async function recharge(amount = 100) {
    const workspace = await readWorkspace();
    workspace.user.points += amount;
    workspace.user.pointLogs.unshift({
        id: createId('point'),
        type: 'recharge',
        amount,
        note: `演示充值 +${amount}`,
        createdAt: new Date().toISOString(),
    });
    await writeWorkspace(workspace);
    return { workspace };
}
export async function createCase(name) {
    const workspace = await readWorkspace();
    const caseFolder = {
        id: createId('case'),
        name: name.trim(),
        description: '请在此补充案件背景、争议焦点与诉讼阶段。',
        createdAt: new Date().toISOString(),
        status: 'draft',
    };
    workspace.cases.unshift(caseFolder);
    await writeWorkspace(workspace);
    return { workspace, caseFolder };
}
export async function updateCase(caseId, patch) {
    const workspace = await readWorkspace();
    workspace.cases = workspace.cases.map((item) => item.id === caseId ? { ...item, ...patch } : item);
    await writeWorkspace(workspace);
    return { workspace };
}
export async function deleteCase(caseId) {
    const workspace = await readWorkspace();
    workspace.cases = workspace.cases.filter((item) => item.id !== caseId);
    workspace.evidences = workspace.evidences.filter((item) => item.caseId !== caseId);
    workspace.certificates = workspace.certificates.filter((item) => item.caseId !== caseId);
    await writeWorkspace(workspace);
    return { workspace };
}
export async function importEvidences(payload) {
    const workspace = await readWorkspace();
    const caseFolder = workspace.cases.find((item) => item.id === payload.caseId);
    if (!caseFolder) {
        throw new Error('案件不存在。');
    }
    const caseEvidences = workspace.evidences.filter((item) => item.caseId === payload.caseId);
    const created = sortImportedEvidenceFiles(payload.files).map((rawFile, index) => {
        const file = normalizeImportedEvidenceFile(rawFile);
        return {
            id: createId('evidence'),
            caseId: payload.caseId,
            number: `E${String(caseEvidences.length + index + 1).padStart(2, '0')}`,
            name: file.name.trim() || buildNormalizedEvidenceName(file.fileName, file.relativePath),
            type: file.type,
            fileName: file.fileName,
            relativePath: file.relativePath,
            uploadedAt: new Date().toISOString(),
            ocrText: file.ocrText,
            previewDataUrl: file.previewDataUrl,
            sourceDataUrl: file.sourceDataUrl,
            sourceMimeType: file.sourceMimeType,
            pages: file.pages,
            anchorHint: file.anchorHint,
            summaryText: file.summaryText,
            summaryStatus: file.summaryStatus,
            summaryError: file.summaryError,
            summaryUpdatedAt: file.summaryUpdatedAt,
        };
    });
    workspace.evidences.unshift(...created);
    workspace.cases = workspace.cases.map((item) => item.id === caseFolder.id ? { ...item, status: item.status === 'ready' ? 'in_review' : item.status } : item);
    await rebuildCaseContextMemory(workspace, caseFolder, workspace.evidences.filter((item) => item.caseId === caseFolder.id));
    await writeWorkspace(workspace);
    return { workspace, created };
}
export async function replaceCaseEvidences(payload) {
    const workspace = await readWorkspace();
    const caseFolder = workspace.cases.find((item) => item.id === payload.caseId);
    if (!caseFolder) {
        throw new Error('案件不存在。');
    }
    const removedEvidenceIds = new Set(workspace.evidences.filter((item) => item.caseId === payload.caseId).map((item) => item.id));
    workspace.evidences = workspace.evidences.filter((item) => item.caseId !== payload.caseId);
    workspace.evidenceInsights = workspace.evidenceInsights.filter((item) => item.caseId !== payload.caseId);
    workspace.caseContextMemories = workspace.caseContextMemories.filter((item) => item.caseId !== payload.caseId);
    workspace.certificates = workspace.certificates.map((certificate) => ({
        ...certificate,
        paragraphs: certificate.paragraphs.map((paragraph) => {
            const nextLinks = (paragraph.links ?? (paragraph.link ? [paragraph.link] : [])).filter((link) => !removedEvidenceIds.has(link.evidenceId));
            return normalizeParagraph({
                ...paragraph,
                verified: nextLinks.length ? paragraph.verified : false,
                links: nextLinks,
                link: nextLinks[0],
            });
        }),
    }));
    const created = sortImportedEvidenceFiles(payload.files).map((rawFile, index) => {
        const file = normalizeImportedEvidenceFile(rawFile);
        return {
            id: createId('evidence'),
            caseId: payload.caseId,
            number: `E${String(index + 1).padStart(2, '0')}`,
            name: file.name.trim() || buildNormalizedEvidenceName(file.fileName, file.relativePath),
            type: file.type,
            fileName: file.fileName,
            relativePath: file.relativePath,
            uploadedAt: new Date().toISOString(),
            ocrText: file.ocrText,
            previewDataUrl: file.previewDataUrl,
            sourceDataUrl: file.sourceDataUrl,
            sourceMimeType: file.sourceMimeType,
            pages: file.pages,
            anchorHint: file.anchorHint,
            summaryText: file.summaryText,
            summaryStatus: file.summaryStatus,
            summaryError: file.summaryError,
            summaryUpdatedAt: file.summaryUpdatedAt,
        };
    });
    workspace.evidences.unshift(...created);
    workspace.cases = workspace.cases.map((item) => item.id === caseFolder.id ? { ...item, status: 'in_review' } : item);
    await rebuildCaseContextMemory(workspace, caseFolder, workspace.evidences.filter((item) => item.caseId === caseFolder.id));
    await writeWorkspace(workspace);
    return { workspace, created };
}
export async function updateEvidence(evidenceId, patch) {
    const workspace = await readWorkspace();
    const current = workspace.evidences.find((item) => item.id === evidenceId);
    workspace.evidences = workspace.evidences.map((item) => item.id === evidenceId ? { ...item, ...patch } : item);
    if (current) {
        const updatedEvidence = workspace.evidences.find((item) => item.id === evidenceId) ?? current;
        const latestInsight = getLatestEvidenceInsight(workspace, evidenceId);
        const fallbackDraft = buildFallbackEvidenceInsightDraft(updatedEvidence, getEvidenceFragmentsForEvidence(workspace, evidenceId));
        upsertEvidenceInsight(workspace, {
            id: latestInsight?.id ?? createId('evidence-insight'),
            caseId: updatedEvidence.caseId,
            evidenceId,
            version: latestInsight?.version ?? 1,
            ...fallbackDraft,
            updatedAt: new Date().toISOString(),
        });
        const caseFolder = workspace.cases.find((item) => item.id === updatedEvidence.caseId);
        if (caseFolder) {
            await rebuildCaseContextMemory(workspace, caseFolder, workspace.evidences.filter((item) => item.caseId === caseFolder.id));
        }
    }
    await writeWorkspace(workspace);
    return { workspace };
}
export async function summarizeEvidence(evidenceId) {
    const workspace = await readWorkspace();
    const evidence = workspace.evidences.find((item) => item.id === evidenceId);
    if (!evidence) {
        throw new Error('证据不存在。');
    }
    const caseFolder = workspace.cases.find((item) => item.id === evidence.caseId) ?? null;
    const fragments = getEvidenceFragmentsForEvidence(workspace, evidence.id);
    const existingInsight = getLatestEvidenceInsight(workspace, evidence.id);
    const processingInsight = {
        id: existingInsight?.id ?? createId('evidence-insight'),
        caseId: evidence.caseId,
        evidenceId: evidence.id,
        version: (existingInsight?.version ?? 0) + 1,
        summary: existingInsight?.summary ?? '',
        keyFacts: existingInsight?.keyFacts ?? [],
        entities: existingInsight?.entities ?? [],
        timelineEvents: existingInsight?.timelineEvents ?? [],
        amounts: existingInsight?.amounts ?? [],
        positions: existingInsight?.positions ?? [],
        issues: existingInsight?.issues ?? [],
        sourceFragmentIds: fragments.slice(0, 4).map((fragment) => fragment.id),
        confidence: existingInsight?.confidence ?? 0.4,
        status: 'processing',
        error: undefined,
        updatedAt: new Date().toISOString(),
    };
    workspace.evidences = workspace.evidences.map((item) => item.id === evidenceId
        ? {
            ...item,
            summaryStatus: 'processing',
            summaryError: undefined,
        }
        : item);
    upsertEvidenceInsight(workspace, processingInsight);
    await writeWorkspace(workspace);
    try {
        const insightDraft = await understandEvidenceWithLlm(evidence, fragments);
        const summaryText = buildSummaryTextFromInsightDraft(insightDraft);
        const updatedAt = new Date().toISOString();
        const nextInsight = {
            id: processingInsight.id,
            caseId: evidence.caseId,
            evidenceId: evidence.id,
            version: processingInsight.version,
            ...insightDraft,
            updatedAt,
        };
        workspace.evidences = workspace.evidences.map((item) => item.id === evidenceId
            ? {
                ...item,
                summaryText,
                summaryStatus: 'ready',
                summaryError: undefined,
                summaryUpdatedAt: updatedAt,
            }
            : item);
        upsertEvidenceInsight(workspace, nextInsight);
        if (caseFolder) {
            const caseEvidences = workspace.evidences.filter((item) => item.caseId === caseFolder.id);
            await rebuildCaseContextMemory(workspace, caseFolder, caseEvidences);
        }
        await writeWorkspace(workspace);
    }
    catch (error) {
        const fallbackInsight = buildFallbackEvidenceInsightDraft(evidence, fragments);
        workspace.evidences = workspace.evidences.map((item) => item.id === evidenceId
            ? {
                ...item,
                summaryStatus: 'failed',
                summaryError: error instanceof Error ? error.message : '证据内容理解失败',
                summaryUpdatedAt: new Date().toISOString(),
            }
            : item);
        upsertEvidenceInsight(workspace, {
            id: processingInsight.id,
            caseId: evidence.caseId,
            evidenceId: evidence.id,
            version: processingInsight.version,
            ...fallbackInsight,
            status: 'failed',
            error: error instanceof Error ? error.message : '证据内容理解失败',
            updatedAt: new Date().toISOString(),
        });
        await writeWorkspace(workspace);
    }
    return { workspace };
}
export async function deleteEvidence(evidenceId) {
    const workspace = await readWorkspace();
    const evidence = workspace.evidences.find((item) => item.id === evidenceId) ?? null;
    workspace.evidences = workspace.evidences.filter((item) => item.id !== evidenceId);
    workspace.evidenceInsights = workspace.evidenceInsights.filter((item) => item.evidenceId !== evidenceId);
    workspace.certificates = workspace.certificates.map((certificate) => ({
        ...certificate,
        paragraphs: certificate.paragraphs.map((paragraph) => {
            const nextLinks = (paragraph.links ?? (paragraph.link ? [paragraph.link] : [])).filter((link) => link.evidenceId !== evidenceId);
            return normalizeParagraph({
                ...paragraph,
                verified: nextLinks.length ? paragraph.verified : false,
                links: nextLinks,
                link: nextLinks[0],
            });
        }),
    }));
    if (evidence) {
        const caseFolder = workspace.cases.find((item) => item.id === evidence.caseId) ?? null;
        workspace.draftMemories = workspace.draftMemories.map((memory) => ({
            ...memory,
            usedEvidenceInsightIds: memory.usedEvidenceInsightIds.filter((id) => workspace.evidenceInsights.some((insight) => insight.id === id)),
            paragraphPlans: memory.paragraphPlans.map((plan) => ({
                ...plan,
                evidenceNumbers: plan.evidenceNumbers.filter((number) => workspace.evidences.some((item) => item.caseId === memory.caseId && item.number === number)),
            })),
        }));
        if (caseFolder) {
            await rebuildCaseContextMemory(workspace, caseFolder, workspace.evidences.filter((item) => item.caseId === caseFolder.id));
        }
        else {
            workspace.caseContextMemories = workspace.caseContextMemories.filter((item) => item.caseId !== evidence.caseId);
        }
    }
    await writeWorkspace(workspace);
    return { workspace };
}
export async function generateCertificate(payload) {
    const workspace = await readWorkspace();
    const caseFolder = workspace.cases.find((item) => item.id === payload.caseId);
    if (!caseFolder) {
        throw new Error('案件不存在。');
    }
    const evidences = workspace.evidences.filter((item) => payload.evidenceIds.includes(item.id));
    if (evidences.length === 0) {
        throw new Error('请至少勾选一份证据。');
    }
    const caseContextMemory = await rebuildCaseContextMemory(workspace, caseFolder, workspace.evidences.filter((item) => item.caseId === caseFolder.id));
    const { certificate: rawCertificate, agentReply } = isLlmConfigured()
        ? await generateCertificateWithLlm({
            workspace,
            caseFolder,
            evidences,
            caseContextMemory,
            role: payload.role,
            focus: payload.focus,
            prompt: payload.prompt,
        })
        : {
            certificate: buildCertificate(caseFolder, evidences, payload.role, payload.focus),
            agentReply: '当前未配置模型，已回退为基础规则生成文书。',
        };
    const certificate = await attachAutoStatuteReferencesToCertificate(workspace, rawCertificate);
    workspace.certificates.unshift(certificate);
    workspace.cases = workspace.cases.map((item) => item.id === caseFolder.id ? { ...item, status: 'in_review' } : item);
    upsertDraftMemory(workspace, buildDraftMemory(workspace, certificate, payload.prompt?.trim() || payload.focus, caseContextMemory, evidences));
    await writeWorkspace(workspace);
    return { workspace, certificate, agentReply };
}
export async function streamGenerateCertificate(payload, onEvent) {
    const workspace = await readWorkspace();
    const caseFolder = workspace.cases.find((item) => item.id === payload.caseId);
    if (!caseFolder) {
        throw new Error('案件不存在。');
    }
    const evidences = workspace.evidences.filter((item) => payload.evidenceIds.includes(item.id));
    if (evidences.length === 0) {
        throw new Error('请至少勾选一份证据。');
    }
    const caseContextMemory = await rebuildCaseContextMemory(workspace, caseFolder, workspace.evidences.filter((item) => item.caseId === caseFolder.id));
    let certificate;
    let agentReply;
    if (!isLlmConfigured()) {
        certificate = await attachAutoStatuteReferencesToCertificate(workspace, buildCertificate(caseFolder, evidences, payload.role, payload.focus));
        agentReply = '当前未配置模型，已回退为基础规则生成文书。';
        await onEvent({ type: 'meta', title: certificate.title, focus: certificate.focus });
        for (const [index, paragraph] of certificate.paragraphs.entries()) {
            await onEvent({
                type: 'paragraph',
                index,
                text: paragraph.text,
                evidenceNumbers: getParagraphLinks(paragraph)
                    .map((link) => workspace.evidences.find((item) => item.id === link.evidenceId)?.number ?? '')
                    .filter(Boolean),
            });
        }
    }
    else {
        const evidenceContext = buildEvidenceContext(workspace, evidences);
        const caseMemoryContext = buildCaseMemoryPromptContext(caseContextMemory);
        const documentKind = inferLegalDocumentKind({
            prompt: payload.prompt,
            focus: payload.focus,
        });
        const sampleStyleGuide = buildCertificateSampleStyleGuide({
            role: payload.role,
            kind: documentKind,
        });
        const parsed = await streamStructuredCertificateFromLlm({
            messages: buildStreamingCertificateMessages({
                mode: 'generate',
                role: payload.role,
                sampleStyleGuide,
                caseFolder,
                caseMemoryContext,
                evidenceContext,
                focus: payload.focus,
                prompt: payload.prompt?.trim() || '请基于现有证据生成一版结构完整、可用于后续核验修改的法律文书。',
            }),
            onEvent,
        });
        if (!parsed.paragraphs.length) {
            throw new Error('模型未返回有效文书段落。');
        }
        const paragraphs = buildCertificateParagraphsFromLlmOutput(parsed.paragraphs, evidences, payload.prompt);
        certificate = await attachAutoStatuteReferencesToCertificate(workspace, {
            id: createId('certificate'),
            caseId: caseFolder.id,
            title: parsed.title?.trim() || buildFallbackTitle(caseFolder, payload.role),
            role: payload.role,
            focus: parsed.focus?.trim() || payload.focus,
            paragraphIds: paragraphs.map((paragraph) => paragraph.id),
            paragraphs,
            createdAt: new Date().toISOString(),
        });
        agentReply =
            parsed.agentReply?.trim()
                || (certificate.title
                    ? `已根据你的要求生成《${certificate.title}》。${certificate.focus ? `本版焦点：${certificate.focus}。` : ''}`
                    : '已根据你的要求生成一版文书草稿。');
    }
    workspace.certificates.unshift(certificate);
    workspace.cases = workspace.cases.map((item) => item.id === caseFolder.id ? { ...item, status: 'in_review' } : item);
    upsertDraftMemory(workspace, buildDraftMemory(workspace, certificate, payload.prompt?.trim() || payload.focus, caseContextMemory, evidences));
    await writeWorkspace(workspace);
    await onEvent({
        type: 'done',
        workspace,
        certificate,
        agentReply,
    });
}
export async function rewriteCertificate(payload) {
    if (!payload.prompt.trim()) {
        throw new Error('请先输入改写要求。');
    }
    const workspace = await readWorkspace();
    const certificate = workspace.certificates.find((item) => item.id === payload.certificateId);
    if (!certificate) {
        throw new Error('当前文书不存在。');
    }
    if (!isLlmConfigured()) {
        throw new Error('当前未配置模型，暂时无法执行二次改写。');
    }
    const caseFolder = workspace.cases.find((item) => item.id === certificate.caseId);
    if (!caseFolder) {
        throw new Error('案件不存在。');
    }
    const preferredEvidenceIds = payload.evidenceIds.length
        ? payload.evidenceIds
        : Array.from(new Set(certificate.paragraphs.flatMap((paragraph) => getParagraphLinks(paragraph).map((link) => link.evidenceId))));
    const evidences = workspace.evidences.filter((item) => preferredEvidenceIds.includes(item.id) && item.caseId === certificate.caseId);
    if (!evidences.length) {
        throw new Error('当前草稿尚未关联可用于改写的证据。');
    }
    const caseContextMemory = await rebuildCaseContextMemory(workspace, caseFolder, workspace.evidences.filter((item) => item.caseId === caseFolder.id));
    const result = await rewriteCertificateWithLlm({
        workspace,
        certificate,
        caseFolder,
        evidences,
        caseContextMemory,
        prompt: payload.prompt,
    });
    const rewrittenCertificate = await attachAutoStatuteReferencesToCertificate(workspace, result.certificate);
    workspace.certificates = workspace.certificates.map((item) => item.id === certificate.id ? rewrittenCertificate : item);
    upsertDraftMemory(workspace, buildDraftMemory(workspace, rewrittenCertificate, payload.prompt.trim(), caseContextMemory, evidences));
    await writeWorkspace(workspace);
    return {
        workspace: await readWorkspace(),
        certificate: rewrittenCertificate,
        agentReply: result.agentReply,
    };
}
export async function streamRewriteCertificate(payload, onEvent) {
    if (!payload.prompt.trim()) {
        throw new Error('请先输入改写要求。');
    }
    const workspace = await readWorkspace();
    const certificate = workspace.certificates.find((item) => item.id === payload.certificateId);
    if (!certificate) {
        throw new Error('当前文书不存在。');
    }
    if (!isLlmConfigured()) {
        throw new Error('当前未配置模型，暂时无法执行二次改写。');
    }
    const caseFolder = workspace.cases.find((item) => item.id === certificate.caseId);
    if (!caseFolder) {
        throw new Error('案件不存在。');
    }
    const preferredEvidenceIds = payload.evidenceIds.length
        ? payload.evidenceIds
        : Array.from(new Set(certificate.paragraphs.flatMap((paragraph) => getParagraphLinks(paragraph).map((link) => link.evidenceId))));
    const evidences = workspace.evidences.filter((item) => preferredEvidenceIds.includes(item.id) && item.caseId === certificate.caseId);
    if (!evidences.length) {
        throw new Error('当前草稿尚未关联可用于改写的证据。');
    }
    const caseContextMemory = await rebuildCaseContextMemory(workspace, caseFolder, workspace.evidences.filter((item) => item.caseId === caseFolder.id));
    const evidenceContext = buildEvidenceContext(workspace, evidences);
    const caseMemoryContext = buildCaseMemoryPromptContext(caseContextMemory);
    const documentKind = inferLegalDocumentKind({
        prompt: payload.prompt,
        title: certificate.title,
        focus: certificate.focus,
    });
    const sampleStyleGuide = buildCertificateSampleStyleGuide({
        role: certificate.role,
        kind: documentKind,
    });
    const parsed = await streamStructuredCertificateFromLlm({
        messages: buildStreamingCertificateMessages({
            mode: 'rewrite',
            role: certificate.role,
            sampleStyleGuide,
            caseFolder,
            caseMemoryContext,
            evidenceContext,
            focus: certificate.focus,
            prompt: payload.prompt.trim(),
            currentDraft: buildDraftContext(certificate),
        }),
        onEvent,
    });
    if (!parsed.paragraphs.length) {
        throw new Error('模型未返回有效改写结果。');
    }
    const rewrittenParagraphs = buildCertificateParagraphsFromLlmOutput(parsed.paragraphs, evidences, payload.prompt, certificate.paragraphs);
    const rewrittenCertificate = await attachAutoStatuteReferencesToCertificate(workspace, {
        ...certificate,
        title: parsed.title?.trim() || certificate.title,
        focus: parsed.focus?.trim() || certificate.focus,
        paragraphIds: rewrittenParagraphs.map((paragraph) => paragraph.id),
        paragraphs: rewrittenParagraphs,
    });
    workspace.certificates = workspace.certificates.map((item) => item.id === certificate.id ? rewrittenCertificate : item);
    upsertDraftMemory(workspace, buildDraftMemory(workspace, rewrittenCertificate, payload.prompt.trim(), caseContextMemory, evidences));
    await writeWorkspace(workspace);
    await onEvent({
        type: 'done',
        workspace: await readWorkspace(),
        certificate: rewrittenCertificate,
        agentReply: parsed.agentReply?.trim()
            || `已按你的追问改写当前草稿《${rewrittenCertificate.title}》，并尽量保留段落对应的证据来源。`,
    });
}
export async function importCertificate(payload) {
    const workspace = await readWorkspace();
    const caseFolder = workspace.cases.find((item) => item.id === payload.caseId);
    if (!caseFolder) {
        throw new Error('案件不存在。');
    }
    if (!payload.content.trim()) {
        throw new Error('导入文书内容为空。');
    }
    const caseEvidences = workspace.evidences.filter((item) => item.caseId === caseFolder.id);
    const certificate = await attachAutoStatuteReferencesToCertificate(workspace, attachAutoEvidenceLinksToCertificate(buildImportedCertificate(caseFolder, payload), caseEvidences));
    workspace.certificates.unshift(certificate);
    workspace.cases = workspace.cases.map((item) => item.id === caseFolder.id ? { ...item, status: 'in_review' } : item);
    await writeWorkspace(workspace);
    const nextWorkspace = await readWorkspace();
    return {
        workspace: nextWorkspace,
        certificate: nextWorkspace.certificates.find((item) => item.id === certificate.id) ?? certificate,
    };
}
export async function updateParagraph(certificateId, paragraphId, patch) {
    const workspace = await readWorkspace();
    const cache = new Map();
    const nextCertificates = [];
    for (const certificate of workspace.certificates) {
        if (certificate.id !== certificateId) {
            nextCertificates.push(certificate);
            continue;
        }
        const nextParagraphs = [];
        for (const paragraph of certificate.paragraphs) {
            if (paragraph.id !== paragraphId) {
                nextParagraphs.push(paragraph);
                continue;
            }
            const mergedParagraph = normalizeParagraph({ ...paragraph, ...patch });
            nextParagraphs.push(await attachAutoStatuteReferencesToParagraph(workspace, mergedParagraph, cache));
        }
        nextCertificates.push({
            ...certificate,
            paragraphs: nextParagraphs,
        });
    }
    workspace.certificates = nextCertificates;
    await writeWorkspace(workspace);
    return { workspace: await readWorkspace() };
}
export async function autoLinkCertificate(certificateId) {
    if (!isLlmConfigured()) {
        throw new Error('当前桌面端尚未配置 LLM API Key，证据联动依赖大模型理解，请先完成模型配置后再试。');
    }
    const workspace = await readWorkspace();
    const certificate = workspace.certificates.find((item) => item.id === certificateId);
    if (!certificate) {
        throw new Error('文书不存在。');
    }
    const caseEvidences = workspace.evidences.filter((item) => item.caseId === certificate.caseId);
    const caseFolder = workspace.cases.find((item) => item.id === certificate.caseId) ?? null;
    const caseContextMemory = caseFolder && caseEvidences.length
        ? await rebuildCaseContextMemory(workspace, caseFolder, caseEvidences)
        : null;
    const analyses = await analyzeCertificateAutoLinksWithLlm(workspace, certificate, caseEvidences, caseContextMemory);
    const nextCertificate = await attachAutoCaseReferencesToCertificateWithLlm(workspace, await attachAutoStatuteReferencesToCertificateWithLlm(workspace, attachAutoEvidenceLinksToCertificateWithLlm(workspace, certificate, caseEvidences, analyses), analyses), analyses);
    workspace.certificates = workspace.certificates.map((item) => item.id === certificateId ? nextCertificate : item);
    await writeWorkspace(workspace);
    const refreshedWorkspace = await readWorkspace();
    const refreshedCertificate = refreshedWorkspace.certificates.find((item) => item.id === certificateId) ?? nextCertificate;
    return {
        workspace: refreshedWorkspace,
        linkedParagraphCount: refreshedCertificate.paragraphs.filter((paragraph) => getParagraphLinks(paragraph).length > 0 || (paragraph.references ?? []).length > 0).length,
        evidenceLinkCount: refreshedCertificate.paragraphs.reduce((total, paragraph) => total + getParagraphLinks(paragraph).filter((item) => item.note === AUTO_EVIDENCE_LINK_NOTE).length, 0),
        statuteReferenceCount: refreshedCertificate.paragraphs.reduce((total, paragraph) => total + (paragraph.references ?? []).filter((item) => item.note === AUTO_STATUTE_REFERENCE_NOTE).length, 0),
        caseReferenceCount: refreshedCertificate.paragraphs.reduce((total, paragraph) => total + (paragraph.references ?? []).filter((item) => item.note === AUTO_CASE_REFERENCE_NOTE).length, 0),
    };
}
export async function reviewParagraphMatches(certificateId, paragraphId) {
    if (!isLlmConfigured()) {
        throw new Error('LLM 尚未配置，无法执行 AI 复核。');
    }
    const workspace = await readWorkspace();
    const certificate = workspace.certificates.find((item) => item.id === certificateId);
    if (!certificate) {
        throw new Error('文书不存在。');
    }
    const paragraph = certificate.paragraphs.find((item) => item.id === paragraphId);
    if (!paragraph) {
        throw new Error('段落不存在。');
    }
    const claimUnits = workspace.claimUnits.filter((item) => item.paragraphId === paragraphId);
    if (!claimUnits.length) {
        throw new Error('当前段落尚未生成可复核主张。');
    }
    const evidenceById = new Map(workspace.evidences.map((item) => [item.id, item]));
    const fragmentById = new Map(workspace.evidenceFragments.map((item) => [item.id, item]));
    const existingModelMatches = workspace.claimEvidenceMatches.filter((item) => item.source === 'model');
    const nextModelMatches = existingModelMatches.filter((item) => !claimUnits.some((claim) => claim.id === item.claimUnitId));
    const reviewedMatches = [];
    for (const claim of claimUnits) {
        const candidates = workspace.claimEvidenceMatches
            .filter((item) => item.claimUnitId === claim.id && item.source !== 'model')
            .map((match) => {
            const fragment = fragmentById.get(match.evidenceFragmentId);
            const evidence = evidenceById.get(match.evidenceId);
            if (!fragment || !evidence) {
                return null;
            }
            return { match, fragment, evidence };
        })
            .filter((item) => Boolean(item))
            .sort((left, right) => right.match.score - left.match.score)
            .slice(0, 3);
        if (!candidates.length) {
            continue;
        }
        const llmItems = await reviewClaimCandidatesWithLlm({
            claim,
            paragraph,
            candidates,
        });
        for (const item of llmItems) {
            if (!item.candidateId || !isClaimRelation(item.relation)) {
                continue;
            }
            const candidate = candidates.find((entry) => entry.match.id === item.candidateId);
            if (!candidate) {
                continue;
            }
            reviewedMatches.push({
                id: `${claim.id}-model-${candidate.fragment.id}`,
                caseId: claim.caseId,
                claimUnitId: claim.id,
                evidenceId: candidate.evidence.id,
                evidenceFragmentId: candidate.fragment.id,
                relation: item.relation,
                score: normalizeMatchScore(item.score, candidate.match.score),
                reason: item.reason?.trim() || '模型已完成候选片段复核。',
                quote: item.quote?.trim() || candidate.match.quote || candidate.fragment.summary,
                locator: candidate.fragment.locator,
                source: 'model',
                verified: false,
            });
        }
    }
    workspace.claimEvidenceMatches = [...nextModelMatches, ...reviewedMatches];
    await writeWorkspace(workspace);
    return {
        workspace: await readWorkspace(),
        reviewedCount: reviewedMatches.length,
    };
}
export async function listKnowledgeCases(query) {
    const workspace = await readWorkspace();
    let cases = [...workspace.knowledgeCases];
    if (query?.keyword?.trim()) {
        const keyword = query.keyword.trim();
        cases = cases.filter((item) => [
            item.title,
            item.caseNumber,
            item.courtName,
            item.cause,
            item.issueSummary,
            item.holdingSummary,
            item.reasoningSummary,
            ...item.keywords,
            ...item.focusTags,
        ].some((text) => text.includes(keyword)));
    }
    if (query?.focusTag?.trim()) {
        cases = cases.filter((item) => item.focusTags.includes(query.focusTag.trim()));
    }
    if (query?.cause?.trim()) {
        cases = cases.filter((item) => item.cause.includes(query.cause.trim()));
    }
    return { items: cases };
}
export async function getKnowledgeCaseDetail(caseId) {
    const workspace = await readWorkspace();
    const entry = workspace.knowledgeCases.find((item) => item.id === caseId);
    if (!entry) {
        throw new Error('案例不存在。');
    }
    return entry;
}
function normalizeImportedKnowledgeCase(item) {
    const nextCaseId = item.id?.trim() || createId('knowledge-case');
    return {
        id: nextCaseId,
        title: item.title?.trim() || '未命名案例',
        caseNumber: item.caseNumber?.trim() || '案号待补充',
        courtName: item.courtName?.trim() || '未标注法院',
        courtLevel: item.courtLevel?.trim() || '未标注',
        region: item.region?.trim() || '未标注',
        trialLevel: item.trialLevel?.trim() || '未标注',
        caseType: item.caseType?.trim() || '裁判文书',
        cause: item.cause?.trim() || '未标注案由',
        judgmentDate: item.judgmentDate?.trim() || new Date().toISOString(),
        effectiveDate: item.effectiveDate?.trim() || item.judgmentDate?.trim() || new Date().toISOString(),
        issueSummary: item.issueSummary?.trim() || '待补充争议焦点',
        holdingSummary: item.holdingSummary?.trim() || '待补充裁判要旨',
        reasoningSummary: item.reasoningSummary?.trim() || '待补充裁判理由',
        resultSummary: item.resultSummary?.trim() || '待补充结果摘要',
        sourceUrl: item.sourceUrl?.trim() || undefined,
        sourceType: item.sourceType?.trim() || '外部案例库',
        keywords: uniqueStrings((item.keywords ?? []).map((keyword) => keyword.trim()).filter(Boolean), 20),
        focusTags: uniqueStrings((item.focusTags ?? []).map((keyword) => keyword.trim()).filter(Boolean), 12),
        referencedStatutes: uniqueStrings((item.referencedStatutes ?? []).map((keyword) => keyword.trim()).filter(Boolean), 12),
        excerpts: (item.excerpts ?? []).map((excerpt, index) => ({
            id: excerpt.id?.trim() || createId(`excerpt-${index + 1}`),
            caseId: nextCaseId,
            excerptType: excerpt.excerptType,
            locator: excerpt.locator?.trim() || `摘要 ${index + 1}`,
            content: excerpt.content?.trim() || excerpt.summary?.trim() || '待补充摘要',
            summary: excerpt.summary?.trim() || excerpt.content?.trim() || '待补充摘要',
            keywords: uniqueStrings((excerpt.keywords ?? []).map((keyword) => keyword.trim()).filter(Boolean), 12),
        })),
    };
}
export async function importKnowledgeCases(payload) {
    if (!Array.isArray(payload.items) || !payload.items.length) {
        throw new Error('请至少提供一个案例。');
    }
    const workspace = await readWorkspace();
    const nextItems = [...workspace.knowledgeCases];
    for (const rawItem of payload.items) {
        const item = normalizeImportedKnowledgeCase(rawItem);
        const existingIndex = nextItems.findIndex((entry) => (entry.sourceUrl && item.sourceUrl && entry.sourceUrl === item.sourceUrl)
            || (entry.caseNumber === item.caseNumber && entry.title === item.title));
        if (existingIndex >= 0) {
            nextItems[existingIndex] = {
                ...nextItems[existingIndex],
                ...item,
                id: nextItems[existingIndex].id,
                excerpts: item.excerpts.length ? item.excerpts : nextItems[existingIndex].excerpts,
            };
            continue;
        }
        nextItems.unshift(item);
    }
    workspace.knowledgeCases = nextItems;
    await writeWorkspace(workspace);
    return {
        workspace: await readWorkspace(),
        importedCount: payload.items.length,
    };
}
export async function listKnowledgeStatutes(query) {
    const workspace = hydrateWorkspaceStatutesFromKnowledgeFiles(await hydrateWorkspaceKnowledgeFiles(await readWorkspace()));
    let statutes = [...workspace.knowledgeStatutes];
    if (query?.keyword?.trim()) {
        const keyword = query.keyword.trim();
        statutes = statutes.filter((item) => [
            item.title,
            item.docType,
            item.issuer,
            ...item.keywords,
            ...item.articles.flatMap((article) => [article.articleNumber, article.content, ...article.aliases, ...article.topicTags]),
        ].some((text) => text.includes(keyword)));
    }
    if (query?.docType?.trim()) {
        statutes = statutes.filter((item) => item.docType.includes(query.docType.trim()));
    }
    if (query?.effectiveStatus?.trim()) {
        statutes = statutes.filter((item) => item.effectiveStatus === query.effectiveStatus);
    }
    return { items: statutes };
}
export async function listOfficialLegalSources() {
    return {
        items: OFFICIAL_LEGAL_SOURCES,
        primarySourceId: 'npc_flk',
        recommendedStrategy: {
            primary: '国家法律法规数据库作为主法源',
            supplement: ['国家行政法规库', '国家规章库', '司法部规章库'],
            refreshCadence: '每日增量巡检 + 手动强制刷新',
        },
    };
}
export async function getKnowledgeStatuteDetail(documentId) {
    const workspace = hydrateWorkspaceStatutesFromKnowledgeFiles(await hydrateWorkspaceKnowledgeFiles(await readWorkspace()));
    const document = workspace.knowledgeStatutes.find((item) => item.id === documentId);
    if (!document) {
        throw new Error('法条文件不存在。');
    }
    return document;
}
function normalizeImportedKnowledgeStatuteArticle(documentId, article, index) {
    const normalizedArticleNumber = normalizeArticleNumber(article.articleNumber ?? '');
    if (!normalizedArticleNumber) {
        throw new Error(`导入失败：第 ${index + 1} 条法条缺少合法的“第几条”编号。`);
    }
    const content = article.content?.trim() || article.plainText?.trim();
    if (!content) {
        throw new Error(`导入失败：${normalizedArticleNumber.articleNumber} 缺少条文内容。`);
    }
    return {
        id: article.id?.trim() || createId('article'),
        documentId,
        articleNumber: normalizedArticleNumber.articleNumber,
        clauseNumber: article.clauseNumber?.trim() || undefined,
        itemNumber: article.itemNumber?.trim() || undefined,
        content,
        plainText: article.plainText?.trim() || content,
        aliases: uniqueStrings((article.aliases ?? []).map((item) => item.trim()).filter(Boolean), 16),
        topicTags: uniqueStrings((article.topicTags ?? []).map((item) => item.trim()).filter(Boolean), 16),
    };
}
function normalizeImportedKnowledgeStatuteDocument(item) {
    const title = item.title?.trim();
    if (!title) {
        throw new Error('导入失败：法律文件标题不能为空。');
    }
    const documentId = item.id?.trim() || createId('statute');
    const articles = (item.articles ?? []).map((article, index) => normalizeImportedKnowledgeStatuteArticle(documentId, article, index));
    if (!articles.length) {
        throw new Error(`导入失败：${title} 至少需要一条法条内容。`);
    }
    return {
        id: documentId,
        title,
        docType: item.docType?.trim() || '法律',
        issuer: item.issuer?.trim() || '未注明发布机关',
        effectiveStatus: item.effectiveStatus === 'amended' || item.effectiveStatus === 'repealed' ? item.effectiveStatus : 'effective',
        effectiveDate: item.effectiveDate?.trim() || new Date().toISOString(),
        publishDate: item.publishDate?.trim() || item.effectiveDate?.trim() || new Date().toISOString(),
        revisionDate: item.revisionDate?.trim() || undefined,
        version: item.version?.trim() || '导入版本',
        sourceUrl: item.sourceUrl?.trim() || undefined,
        sourceTextUrl: item.sourceTextUrl?.trim() || undefined,
        sourcePdfUrl: item.sourcePdfUrl?.trim() || undefined,
        sourceProvider: item.sourceProvider,
        sourceAuthority: item.sourceAuthority?.trim() || undefined,
        sourceDocumentId: item.sourceDocumentId?.trim() || undefined,
        sourceVerifiedAt: item.sourceVerifiedAt?.trim() || new Date().toISOString(),
        keywords: uniqueStrings((item.keywords ?? []).map((keyword) => keyword.trim()).filter(Boolean), 24),
        articles,
    };
}
export async function importKnowledgeStatutes(payload) {
    if (!Array.isArray(payload.items) || !payload.items.length) {
        throw new Error('请至少上传一份法条文件。');
    }
    const workspace = await readWorkspace();
    let importedCount = 0;
    for (const item of payload.items) {
        const normalizedDocument = normalizeImportedKnowledgeStatuteDocument(item);
        upsertKnowledgeStatuteDocument(workspace, normalizedDocument);
        importedCount += 1;
    }
    await writeWorkspace(workspace);
    return {
        workspace: await readWorkspace(),
        importedCount,
    };
}
function inferKnowledgeFileKind(fileName, mimeType) {
    const lowerName = fileName.toLowerCase();
    const lowerMime = mimeType.toLowerCase();
    if (lowerName.endsWith('.doc')
        || lowerName.endsWith('.docx')
        || lowerName.endsWith('.rtf')
        || lowerName.endsWith('.wps')
        || lowerMime.includes('word')
        || lowerMime.includes('wordprocessingml')
        || lowerMime.includes('rtf')) {
        return 'word';
    }
    if (lowerName.endsWith('.pdf') || lowerMime.includes('pdf')) {
        return 'pdf';
    }
    if (lowerName.endsWith('.txt')
        || lowerName.endsWith('.md')
        || lowerName.endsWith('.markdown')
        || lowerName.endsWith('.json')
        || lowerMime.startsWith('text/')
        || lowerMime.includes('json')) {
        return 'text';
    }
    return 'other';
}
function summarizeKnowledgeText(text) {
    return text
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 220);
}
function chunkKnowledgeText(text, chunkSize = 480) {
    const source = text.replace(/\r/g, '').trim();
    if (!source) {
        return [];
    }
    const paragraphs = source
        .split(/\n\s*\n+/)
        .map((item) => item.trim())
        .filter(Boolean);
    if (!paragraphs.length) {
        return [source];
    }
    const chunks = [];
    let current = '';
    for (const paragraph of paragraphs) {
        if (!current) {
            current = paragraph;
            continue;
        }
        if (`${current}\n\n${paragraph}`.length <= chunkSize) {
            current = `${current}\n\n${paragraph}`;
            continue;
        }
        chunks.push(current);
        current = paragraph;
    }
    if (current) {
        chunks.push(current);
    }
    return chunks;
}
function buildKnowledgeVectorKeywords(title, text) {
    const candidates = extractRegexMatches(`${title}\n${text}`, /[\u4e00-\u9fa5A-Za-z0-9]{2,20}/g, 64);
    return uniqueStrings(candidates.filter((item) => !/^\d+$/.test(item)), 18);
}
function buildKnowledgeFileRecord(payload) {
    const now = new Date().toISOString();
    const fileName = payload.fileName.trim();
    const title = payload.title?.trim() || fileName.replace(/\.[^.]+$/, '');
    const fileExtension = fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.')).toLowerCase() : '';
    const mimeType = payload.mimeType?.trim() || 'application/octet-stream';
    const extractedText = payload.extractedText?.trim() || '';
    const extractionStatus = payload.extractionStatus ?? (extractedText ? 'ready' : 'pending');
    const chunks = extractedText ? chunkKnowledgeText(extractedText) : [];
    const vectorStatus = extractedText
        ? 'ready'
        : extractionStatus === 'failed'
            ? 'failed'
            : 'pending';
    return {
        id: createId('knowledge-file'),
        title,
        fileName,
        storageKey: payload.storageKey?.trim() || undefined,
        storageUrl: payload.storageUrl?.trim() || undefined,
        fileExtension,
        mimeType,
        fileKind: inferKnowledgeFileKind(fileName, mimeType),
        uploadedAt: now,
        updatedAt: now,
        fileSize: payload.fileSize,
        extractionStatus,
        extractionError: payload.extractionError?.trim() || undefined,
        extractedText,
        summary: extractedText ? summarizeKnowledgeText(extractedText) : '文件已上传，待完成文本抽取后再参与检索。',
        vectorStatus,
        vectorError: extractedText ? undefined : payload.extractionError?.trim() || '当前文件尚未完成文本抽取，暂未进入向量化。',
        vectorChunkCount: chunks.length,
        vectorKeywords: extractedText ? buildKnowledgeVectorKeywords(title, extractedText) : [],
        vectorUpdatedAt: extractedText ? now : undefined,
        linkedStatuteIds: payload.linkedStatuteIds ?? [],
    };
}
function stripRtfKnowledgeControlText(content) {
    return content
        .replace(/\\par[d]?/g, '\n')
        .replace(/\\'[0-9a-fA-F]{2}/g, ' ')
        .replace(/\\[a-z]+\d* ?/g, ' ')
        .replace(/[{}]/g, ' ')
        .replace(/\s+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}
async function extractKnowledgeUploadText(file, resolvedFileName) {
    const lowerName = resolvedFileName.toLowerCase();
    const lowerMime = file.mimetype.toLowerCase();
    if (lowerName.endsWith('.txt')
        || lowerName.endsWith('.md')
        || lowerName.endsWith('.markdown')
        || lowerMime.startsWith('text/')) {
        return {
            extractedText: file.buffer.toString('utf8').trim(),
            extractionStatus: 'ready',
        };
    }
    if (lowerName.endsWith('.rtf') || lowerMime.includes('rtf')) {
        return {
            extractedText: stripRtfKnowledgeControlText(file.buffer.toString('utf8')).trim(),
            extractionStatus: 'ready',
        };
    }
    if (lowerName.endsWith('.pdf')) {
        return {
            extractedText: '',
            extractionStatus: 'pending',
            extractionError: 'PDF 文件已上传，当前版本待接入专用解析/OCR 管线后再执行正文抽取。',
        };
    }
    if (lowerName.endsWith('.docx')) {
        try {
            const result = await mammoth.extractRawText({ buffer: file.buffer });
            return {
                extractedText: result.value.trim(),
                extractionStatus: 'ready',
            };
        }
        catch (error) {
            return {
                extractedText: '',
                extractionStatus: 'failed',
                extractionError: error instanceof Error ? error.message : 'DOCX 正文抽取失败。',
            };
        }
    }
    if (lowerName.endsWith('.doc') || lowerName.endsWith('.wps')) {
        return {
            extractedText: '',
            extractionStatus: 'pending',
            extractionError: '旧版 Word/WPS 文件已上传，建议另存为 .docx 后再导入。',
        };
    }
    return {
        extractedText: '',
        extractionStatus: 'pending',
        extractionError: '文件已上传，当前格式尚未接入自动抽取管线。',
    };
}
function normalizeStorageObjectKey(key) {
    return key.replace(/\\/g, '/').replace(/^\/+/, '');
}
function buildStorageObjectUrl(key) {
    return `${env.STORAGE_PUBLIC_BASE_URL}/${normalizeStorageObjectKey(key)}`.replace(/\\/g, '/');
}
async function collectLocalStoredFiles(rootDir, storageRoot) {
    try {
        const entries = await readdir(rootDir, { withFileTypes: true });
        const nestedResults = await Promise.all(entries.map(async (entry) => {
            const fullPath = path.join(rootDir, entry.name);
            if (entry.isDirectory()) {
                return collectLocalStoredFiles(fullPath, storageRoot);
            }
            if (!entry.isFile()) {
                return [];
            }
            try {
                const metadata = await stat(fullPath);
                return [{
                        key: normalizeStorageObjectKey(path.relative(storageRoot, fullPath)),
                        extension: path.extname(entry.name).toLowerCase(),
                        size: metadata.size,
                        modifiedAtMs: metadata.mtimeMs,
                    }];
            }
            catch {
                return [];
            }
        }));
        return nestedResults.flat();
    }
    catch {
        return [];
    }
}
async function resolveHistoricalKnowledgeFileStorage(target) {
    const storageRoot = getStorageRoot();
    const knowledgeRoot = path.join(storageRoot, 'knowledge');
    const expectedExtension = (target.fileExtension || path.extname(target.fileName)).toLowerCase();
    const expectedSize = typeof target.fileSize === 'number' && target.fileSize > 0 ? target.fileSize : undefined;
    const uploadedAtMs = Number.isFinite(Date.parse(target.uploadedAt)) ? Date.parse(target.uploadedAt) : undefined;
    let candidates = await collectLocalStoredFiles(knowledgeRoot, storageRoot);
    if (!candidates.length) {
        return null;
    }
    if (expectedExtension) {
        candidates = candidates.filter((candidate) => candidate.extension === expectedExtension);
    }
    if (!candidates.length) {
        return null;
    }
    if (expectedSize !== undefined) {
        candidates = candidates.filter((candidate) => candidate.size === expectedSize);
    }
    if (!candidates.length) {
        return null;
    }
    candidates.sort((left, right) => {
        const leftDiff = uploadedAtMs === undefined ? 0 : Math.abs(left.modifiedAtMs - uploadedAtMs);
        const rightDiff = uploadedAtMs === undefined ? 0 : Math.abs(right.modifiedAtMs - uploadedAtMs);
        if (leftDiff !== rightDiff) {
            return leftDiff - rightDiff;
        }
        return right.modifiedAtMs - left.modifiedAtMs;
    });
    const matched = candidates[0];
    if (!matched) {
        return null;
    }
    return {
        key: matched.key,
        url: buildStorageObjectUrl(matched.key),
    };
}
async function reprocessStoredKnowledgeFile(target) {
    let storageKey = target.storageKey?.trim();
    if (!storageKey) {
        const recoveredStorage = await resolveHistoricalKnowledgeFileStorage(target);
        if (!recoveredStorage) {
            return false;
        }
        target.storageKey = recoveredStorage.key;
        target.storageUrl = recoveredStorage.url;
        storageKey = recoveredStorage.key;
    }
    else if (!target.storageUrl?.trim()) {
        target.storageUrl = buildStorageObjectUrl(storageKey);
    }
    const buffer = await readObject(storageKey);
    const extraction = await extractKnowledgeUploadText({
        fieldname: 'file',
        originalname: path.basename(target.fileName),
        encoding: '7bit',
        mimetype: target.mimeType || 'application/octet-stream',
        size: buffer.length,
        buffer,
        stream: undefined,
        destination: '',
        filename: '',
        path: '',
    }, target.fileName);
    const extractedText = extraction.extractedText?.trim() || '';
    const now = new Date().toISOString();
    target.extractedText = extractedText;
    target.extractionStatus = extraction.extractionStatus ?? (extractedText ? 'ready' : 'pending');
    target.extractionError = extraction.extractionError?.trim() || undefined;
    target.summary = extractedText ? summarizeKnowledgeText(extractedText) : '文件已上传，待完成文本抽取后再参与检索。';
    target.updatedAt = now;
    return true;
}
export async function uploadKnowledgeFiles(payload) {
    if (!Array.isArray(payload.files) || !payload.files.length) {
        throw new Error('请至少上传一个知识文件。');
    }
    if (shouldUseCommercialKnowledgeStore() && isDatabaseEnabled()) {
        try {
            const uploadedFiles = await uploadKnowledgeFilesToCommercialLibrary(payload);
            const workspace = await hydrateWorkspaceKnowledgeFiles(await readWorkspace());
            return {
                workspace,
                importedCount: uploadedFiles.length,
                files: uploadedFiles,
            };
        }
        catch {
            // When the database is configured but temporarily unavailable, keep the
            // upload flow usable by falling back to the workspace store.
        }
    }
    const workspace = await readWorkspace();
    const nextFiles = [...workspace.knowledgeFiles];
    const uploadedFiles = [];
    for (const [index, file] of payload.files.entries()) {
        const manifestItem = payload.manifest?.[index];
        const relativePath = manifestItem?.relativePath?.trim() || file.originalname;
        const title = manifestItem?.title?.trim() || path.basename(relativePath, path.extname(relativePath));
        const extraction = await extractKnowledgeUploadText(file, relativePath);
        const stored = await storeObject(file, {
            bucket: 'knowledge',
            fileName: relativePath,
        });
        const record = buildKnowledgeFileRecord({
            title,
            fileName: relativePath,
            storageKey: stored.key,
            storageUrl: stored.url,
            mimeType: file.mimetype || 'application/octet-stream',
            fileSize: file.size,
            extractedText: extraction.extractedText,
            extractionStatus: extraction.extractionStatus,
            extractionError: extraction.extractionError,
            linkedStatuteIds: [],
        });
        const existingIndex = nextFiles.findIndex((item) => item.fileName === record.fileName);
        if (existingIndex >= 0) {
            const nextRecord = {
                ...nextFiles[existingIndex],
                ...record,
                id: nextFiles[existingIndex].id,
                uploadedAt: nextFiles[existingIndex].uploadedAt,
            };
            await syncLocalKnowledgeFileVectorIndex(nextRecord);
            nextFiles[existingIndex] = nextRecord;
            uploadedFiles.push(nextRecord);
            continue;
        }
        await syncLocalKnowledgeFileVectorIndex(record);
        nextFiles.unshift(record);
        uploadedFiles.push(record);
    }
    workspace.knowledgeFiles = nextFiles;
    await writeWorkspace(workspace);
    return {
        workspace: await readWorkspace(),
        importedCount: uploadedFiles.length,
        files: uploadedFiles,
    };
}
export async function importKnowledgeFiles(payload) {
    if (!Array.isArray(payload.files) || !payload.files.length) {
        throw new Error('请至少上传一个知识文件。');
    }
    const workspace = await readWorkspace();
    const nextFiles = [...workspace.knowledgeFiles];
    for (const file of payload.files) {
        if (!file.fileName?.trim()) {
            throw new Error('导入失败：知识文件名称不能为空。');
        }
        const record = buildKnowledgeFileRecord(file);
        const existingIndex = nextFiles.findIndex((item) => item.fileName === record.fileName);
        if (existingIndex >= 0) {
            const nextRecord = {
                ...nextFiles[existingIndex],
                ...record,
                id: nextFiles[existingIndex].id,
                uploadedAt: nextFiles[existingIndex].uploadedAt,
            };
            await syncLocalKnowledgeFileVectorIndex(nextRecord);
            nextFiles[existingIndex] = nextRecord;
            continue;
        }
        await syncLocalKnowledgeFileVectorIndex(record);
        nextFiles.unshift(record);
    }
    workspace.knowledgeFiles = nextFiles;
    await writeWorkspace(workspace);
    return {
        workspace: await readWorkspace(),
        importedCount: payload.files.length,
    };
}
export async function reindexKnowledgeFile(fileId) {
    if (isDatabaseEnabled()) {
        try {
            const file = await reindexCommercialKnowledgeFile(fileId);
            const workspace = await hydrateWorkspaceKnowledgeFiles(await readWorkspace());
            return {
                workspace,
                file,
            };
        }
        catch {
            // Fall back to the workspace store when the commercial database layer is
            // not reachable in the current environment.
        }
    }
    const workspace = await readWorkspace();
    const target = workspace.knowledgeFiles.find((item) => item.id === fileId);
    if (!target) {
        throw new Error('知识文件不存在。');
    }
    if (!target.extractedText.trim()) {
        await reprocessStoredKnowledgeFile(target);
    }
    await syncLocalKnowledgeFileVectorIndex(target);
    if (!target.extractedText.trim()) {
        const reason = target.extractionError?.trim() || '当前文件尚未抽取出正文文本。';
        const recoveryHint = target.storageKey?.trim()
            ? '可稍后再次点击“重新处理”重试。'
            : '这是历史版本留下的旧记录，缺少原始文件定位信息，请重新上传同名文件后自动处理。';
        throw new Error(`${reason} ${recoveryHint}`);
    }
    await writeWorkspace(workspace);
    return {
        workspace: await readWorkspace(),
        file: target,
    };
}
export async function recommendKnowledgeCases(payload) {
    const workspace = await hydrateWorkspaceKnowledgeFiles(await readWorkspace());
    return recommendKnowledgeCasesFromWorkspace(workspace, payload);
}
export async function recommendKnowledgeFiles(payload) {
    const workspace = await hydrateWorkspaceKnowledgeFiles(await readWorkspace());
    const caseFolder = payload.caseId ? workspace.cases.find((item) => item.id === payload.caseId) : null;
    const source = [caseFolder?.name, caseFolder?.description, payload.focus, payload.paragraphText].filter(Boolean).join(' ');
    const items = await getKnowledgeFileRagChunks(workspace, source, Math.max(1, payload.limit ?? 6));
    return {
        items,
    };
}
export async function recommendKnowledgeStatutes(payload) {
    const workspace = await hydrateWorkspaceKnowledgeFiles(await readWorkspace());
    return recommendKnowledgeStatutesFromWorkspace(workspace, payload);
}
