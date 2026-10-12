import { AsyncLocalStorage } from 'node:async_hooks';
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isDatabaseEnabled } from './infrastructure/postgres.js';
import { listKnowledgeFilesForWorkspace } from './commercial/knowledge-file-service.js';
import { getWorkspaceDataDir } from './config/paths.js';
import { shouldUseCommercialKnowledgeStore } from './knowledge-mode.js';
import { buildClaimEvidenceMatches, buildClaimUnits, buildEvidenceFragments, } from './intelligence/evidence-matching.js';
import { buildInitialState } from './seed.js';
const dataDir = getWorkspaceDataDir();
const stateFile = path.join(dataDir, 'workspace.json');
const stateFileBackup = path.join(dataDir, 'workspace.backup.json');
const stateFileTemp = path.join(dataDir, 'workspace.json.tmp');
const workspaceContextStorage = new AsyncLocalStorage();
const STATUTE_PLACEHOLDER_SNIPPETS = [
    '官方原文已定位',
    '当前官方接口未直接返回结构化正文',
];
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function normalizeWorkspaceAccount(account) {
    const trimmed = account?.trim().toLowerCase() ?? '';
    return trimmed || null;
}
function createWorkspaceAccountSlug(account) {
    return account
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80) || 'workspace';
}
function createWorkspaceUserId(account) {
    return `user-${createWorkspaceAccountSlug(account)}`;
}
function getCurrentWorkspaceAccount() {
    return workspaceContextStorage.getStore()?.account ?? null;
}
function resolveWorkspacePaths(account = getCurrentWorkspaceAccount()) {
    if (!account) {
        return {
            account: null,
            dataDir,
            stateFile,
            stateFileBackup,
            stateFileTemp,
        };
    }
    const workspaceDir = path.join(dataDir, 'workspaces', createWorkspaceAccountSlug(account));
    return {
        account,
        dataDir: workspaceDir,
        stateFile: path.join(workspaceDir, 'workspace.json'),
        stateFileBackup: path.join(workspaceDir, 'workspace.backup.json'),
        stateFileTemp: path.join(workspaceDir, 'workspace.json.tmp'),
    };
}
function createSeededWorkspaceForAccount(account) {
    const seeded = buildInitialState();
    return normalizeWorkspace({
        ...seeded,
        user: {
            ...seeded.user,
            id: createWorkspaceUserId(account),
            email: account,
        },
    });
}
async function tryMigrateLegacyWorkspaceForAccount(account, paths) {
    try {
        const raw = await readFile(stateFile, 'utf8');
        const legacyWorkspace = normalizeWorkspace(JSON.parse(raw));
        const legacyEmail = normalizeWorkspaceAccount(legacyWorkspace.user.email);
        if (legacyEmail !== account) {
            return null;
        }
        await mkdir(paths.dataDir, { recursive: true });
        const serialized = JSON.stringify(legacyWorkspace, null, 2);
        await writeFile(paths.stateFile, serialized, 'utf8');
        await writeFile(paths.stateFileBackup, serialized, 'utf8');
        return legacyWorkspace;
    }
    catch {
        return null;
    }
}
async function replaceStateFileWithRetry(serialized, paths) {
    const retryableCodes = new Set(['EPERM', 'EACCES', 'EBUSY']);
    let lastError;
    for (let attempt = 0; attempt < 4; attempt += 1) {
        try {
            await rename(paths.stateFileTemp, paths.stateFile);
            return;
        }
        catch (error) {
            const errorCode = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
            if (!retryableCodes.has(errorCode) || attempt === 3) {
                lastError = error;
                break;
            }
            await delay(80 * (attempt + 1));
        }
    }
    try {
        await writeFile(paths.stateFile, serialized, 'utf8');
        await rm(paths.stateFileTemp, { force: true });
        return;
    }
    catch {
        throw lastError instanceof Error ? lastError : new Error('工作区写入失败。');
    }
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
function normalizeParagraphLinks(paragraph) {
    const baseLinks = paragraph.links?.length
        ? paragraph.links
        : paragraph.link
            ? [paragraph.link]
            : [];
    const links = baseLinks.map((link, index) => ({
        id: link.id ?? `${paragraph.id}-link-${index + 1}`,
        evidenceId: link.evidenceId,
        locator: link.locator,
        quote: link.quote,
        note: link.note,
    }));
    return {
        ...paragraph,
        richText: paragraph.richText ?? buildParagraphRichText(paragraph.text),
        links,
        link: links[0],
        references: normalizeParagraphReferences(paragraph.references),
    };
}
function normalizeParagraphReferences(references) {
    return (references ?? []).map((reference, index) => ({
        ...reference,
        id: reference.id ?? `${reference.type}-${reference.targetId}-${index + 1}`,
    }));
}
function isPlaceholderStatuteContent(content) {
    if (!content?.trim()) {
        return true;
    }
    return STATUTE_PLACEHOLDER_SNIPPETS.some((snippet) => content.includes(snippet));
}
function normalizeStatuteContentForComparison(content) {
    return (content ?? '')
        .replace(/\s+/g, '')
        .replace(/[（）()【】\[\]《》“”"'`]/g, '')
        .replace(/[，。,；：、？！]/g, '')
        .replace(/[一二三四五六七八九十百千万两0-9]+/g, '')
        .replace(/等$/u, '')
        .trim();
}
function shouldUseSeededStatuteContent(currentContent, seededContent) {
    if (isPlaceholderStatuteContent(currentContent)) {
        return true;
    }
    const normalizedCurrent = normalizeStatuteContentForComparison(currentContent);
    const normalizedSeeded = normalizeStatuteContentForComparison(seededContent);
    if (!normalizedCurrent || normalizedCurrent === normalizedSeeded) {
        return false;
    }
    return normalizedCurrent.length < normalizedSeeded.length
        && normalizedSeeded.includes(normalizedCurrent);
}
function repairKnowledgeStatutes(state) {
    const seededKnowledgeStatutes = buildInitialState().knowledgeStatutes;
    const repairedDocuments = (state.knowledgeStatutes ?? []).map((document) => {
        const seededDocument = seededKnowledgeStatutes.find((item) => item.title === document.title);
        if (!seededDocument) {
            return document;
        }
        const repairedArticles = document.articles.map((article) => {
            const seededArticle = seededDocument.articles.find((item) => item.articleNumber === article.articleNumber);
            if (!seededArticle) {
                return article;
            }
            if (!shouldUseSeededStatuteContent(article.content, seededArticle.content)) {
                return {
                    ...article,
                    aliases: Array.from(new Set([...seededArticle.aliases, ...article.aliases])),
                    topicTags: Array.from(new Set([...seededArticle.topicTags, ...article.topicTags])),
                };
            }
            return {
                ...article,
                content: seededArticle.content,
                plainText: seededArticle.plainText,
                aliases: Array.from(new Set([...seededArticle.aliases, ...article.aliases])),
                topicTags: Array.from(new Set([...seededArticle.topicTags, ...article.topicTags])),
            };
        });
        const existingArticleNumbers = new Set(repairedArticles.map((item) => item.articleNumber));
        const missingSeededArticles = seededDocument.articles.filter((item) => !existingArticleNumbers.has(item.articleNumber));
        return {
            ...document,
            docType: document.docType || seededDocument.docType,
            issuer: document.issuer || seededDocument.issuer,
            effectiveStatus: document.effectiveStatus || seededDocument.effectiveStatus,
            effectiveDate: document.effectiveDate || seededDocument.effectiveDate,
            publishDate: document.publishDate || seededDocument.publishDate,
            revisionDate: document.revisionDate || seededDocument.revisionDate,
            version: document.version || seededDocument.version,
            sourceProvider: document.sourceProvider || seededDocument.sourceProvider,
            sourceAuthority: document.sourceAuthority || seededDocument.sourceAuthority,
            sourceVerifiedAt: document.sourceVerifiedAt || seededDocument.sourceVerifiedAt,
            sourceUrl: !document.sourceUrl || document.sourceUrl === 'https://flk.npc.gov.cn/'
                ? seededDocument.sourceUrl
                : document.sourceUrl,
            sourceTextUrl: !document.sourceTextUrl || document.sourceTextUrl === 'https://flk.npc.gov.cn/'
                ? seededDocument.sourceTextUrl
                : document.sourceTextUrl,
            keywords: Array.from(new Set([...seededDocument.keywords, ...document.keywords])),
            articles: [...repairedArticles, ...missingSeededArticles],
        };
    });
    const existingTitles = new Set(repairedDocuments.map((item) => item.title));
    const missingSeededDocuments = seededKnowledgeStatutes.filter((item) => !existingTitles.has(item.title));
    return [...repairedDocuments, ...missingSeededDocuments];
}
function removeLegacyDemoWorkspace(state) {
    const demoCase = (state.cases ?? []).find((item) => item.name === '王某买卖合同纠纷'
        && item.description === '演示案件，用于验证证据锚定与左右分屏核验流程。');
    if (!demoCase) {
        return state;
    }
    const demoEvidences = (state.evidences ?? []).filter((item) => item.caseId === demoCase.id);
    const demoEvidenceSignatures = new Set(demoEvidences.map((item) => `${item.number}|${item.name}|${item.fileName}`));
    const expectedDemoSignatures = new Set([
        'E01|微信聊天记录截图|微信截图_付款催告.png',
        'E02|买卖合同|买卖合同.docx',
    ]);
    const matchesLegacyDemoEvidenceSet = demoEvidenceSignatures.size === expectedDemoSignatures.size
        && [...demoEvidenceSignatures].every((item) => expectedDemoSignatures.has(item));
    const demoCertificates = (state.certificates ?? []).filter((item) => item.caseId === demoCase.id);
    const matchesLegacyDemoCertificateSet = demoCertificates.length === 1
        && demoCertificates[0].title === '王某买卖合同纠纷原告质证书'
        && demoCertificates[0].paragraphs.length === 2
        && demoCertificates[0].paragraphs.every((paragraph) => paragraph.text.startsWith('原告质证意见：针对证据 E0'));
    if (!matchesLegacyDemoEvidenceSet || !matchesLegacyDemoCertificateSet) {
        return state;
    }
    const removedEvidenceIds = new Set(demoEvidences.map((item) => item.id));
    const removedCertificateIds = new Set(demoCertificates.map((item) => item.id));
    return {
        ...state,
        cases: (state.cases ?? []).filter((item) => item.id !== demoCase.id),
        evidences: (state.evidences ?? []).filter((item) => item.caseId !== demoCase.id),
        evidenceInsights: (state.evidenceInsights ?? []).filter((item) => item.caseId !== demoCase.id),
        caseContextMemories: (state.caseContextMemories ?? []).filter((item) => item.caseId !== demoCase.id),
        draftMemories: (state.draftMemories ?? []).filter((item) => !removedCertificateIds.has(item.certificateId)),
        certificates: (state.certificates ?? []).filter((item) => item.caseId !== demoCase.id),
        claimUnits: (state.claimUnits ?? []).filter((item) => item.caseId !== demoCase.id && !removedCertificateIds.has(item.certificateId)),
        claimEvidenceMatches: (state.claimEvidenceMatches ?? []).filter((item) => !removedEvidenceIds.has(item.evidenceId)),
    };
}
function normalizeWorkspace(state) {
    const normalizedState = removeLegacyDemoWorkspace(state);
    const evidences = (normalizedState.evidences ?? []).map((evidence) => ({
        ...evidence,
        relativePath: evidence.relativePath ?? evidence.fileName,
        sourceDataUrl: evidence.sourceDataUrl ?? evidence.previewDataUrl,
        pageImageDataUrls: evidence.pageImageDataUrls ?? [],
        sourceMimeType: evidence.sourceMimeType ??
            (evidence.type === 'image'
                ? 'image/*'
                : evidence.type === 'pdf'
                    ? 'application/pdf'
                    : evidence.type === 'ppt'
                        ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
                        : evidence.type === 'word'
                            ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
                            : evidence.type === 'text'
                                ? 'text/plain'
                                : undefined),
    }));
    const certificates = (normalizedState.certificates ?? []).map((certificate) => ({
        ...certificate,
        paragraphs: (certificate.paragraphs ?? []).map((paragraph) => normalizeParagraphLinks(paragraph)),
    }));
    const evidenceFragments = buildEvidenceFragments(evidences);
    const claimUnits = buildClaimUnits(certificates);
    const derivedMatches = buildClaimEvidenceMatches(certificates, claimUnits, evidenceFragments);
    const validClaimIds = new Set(claimUnits.map((item) => item.id));
    const validFragmentIds = new Set(evidenceFragments.map((item) => item.id));
    const persistedModelMatches = (normalizedState.claimEvidenceMatches ?? []).filter((match) => match.source === 'model'
        && validClaimIds.has(match.claimUnitId)
        && validFragmentIds.has(match.evidenceFragmentId));
    const claimEvidenceMatches = [...derivedMatches, ...persistedModelMatches];
    return {
        ...normalizedState,
        evidences,
        evidenceFragments,
        evidenceInsights: normalizedState.evidenceInsights ?? [],
        caseContextMemories: normalizedState.caseContextMemories ?? [],
        draftMemories: normalizedState.draftMemories ?? [],
        certificates,
        claimUnits,
        claimEvidenceMatches,
        knowledgeCases: normalizedState.knowledgeCases ?? [],
        knowledgeFiles: normalizedState.knowledgeFiles ?? [],
        knowledgeStatutes: repairKnowledgeStatutes(normalizedState),
        paymentOrders: normalizedState.paymentOrders ?? [],
    };
}
export async function readWorkspace() {
    const paths = resolveWorkspacePaths();
    await mkdir(paths.dataDir, { recursive: true });
    const hydrateWorkspace = async (normalized) => {
        if (!shouldUseCommercialKnowledgeStore() || !isDatabaseEnabled()) {
            return normalized;
        }
        try {
            const hydrated = {
                ...normalized,
                knowledgeFiles: await listKnowledgeFilesForWorkspace(),
            };
            const { hydrateBillingWorkspace } = await import('./billing-service.js');
            return await hydrateBillingWorkspace(hydrated);
        }
        catch {
            return normalized;
        }
    };
    const readPersistedWorkspace = async (filePath) => {
        const raw = await readFile(filePath, 'utf8');
        const normalized = normalizeWorkspace(JSON.parse(raw));
        if (!paths.account) {
            return normalized;
        }
        return normalizeWorkspace({
            ...normalized,
            user: {
                ...normalized.user,
                email: paths.account,
                id: normalized.user.id || createWorkspaceUserId(paths.account),
            },
        });
    };
    try {
        return await hydrateWorkspace(await readPersistedWorkspace(paths.stateFile));
    }
    catch (error) {
        const errorCode = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
        if (errorCode === 'ENOENT') {
            if (paths.account) {
                const migrated = await tryMigrateLegacyWorkspaceForAccount(paths.account, paths);
                if (migrated) {
                    return await hydrateWorkspace(migrated);
                }
            }
            const seeded = paths.account ? createSeededWorkspaceForAccount(paths.account) : buildInitialState();
            await writeWorkspace(seeded);
            return await hydrateWorkspace(seeded);
        }
        try {
            const recovered = await readPersistedWorkspace(paths.stateFileBackup);
            await writeWorkspace(recovered);
            return await hydrateWorkspace(recovered);
        }
        catch {
            try {
                await rm(paths.stateFileTemp, { force: true });
            }
            catch {
                // no-op
            }
            throw new Error('本地工作区数据读取失败，已阻止自动重置。请检查数据目录中的 workspace.json 是否损坏。');
        }
    }
}
export async function writeWorkspace(state) {
    const paths = resolveWorkspacePaths();
    await mkdir(paths.dataDir, { recursive: true });
    const normalized = normalizeWorkspace(paths.account
        ? {
            ...state,
            user: {
                ...state.user,
                email: paths.account,
                id: state.user.id || createWorkspaceUserId(paths.account),
            },
        }
        : state);
    const serialized = JSON.stringify(normalized, null, 2);
    try {
        await copyFile(paths.stateFile, paths.stateFileBackup);
    }
    catch (error) {
        const errorCode = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
        if (errorCode !== 'ENOENT') {
            throw error;
        }
    }
    await writeFile(paths.stateFileTemp, serialized, 'utf8');
    await replaceStateFileWithRetry(serialized, paths);
    try {
        await writeFile(paths.stateFileBackup, serialized, 'utf8');
    }
    catch {
        // 备份写入失败不影响主文件保存，但保留主写入成功。
    }
}
export function runWithWorkspaceAccount(account, callback) {
    return workspaceContextStorage.run({ account: normalizeWorkspaceAccount(account) }, callback);
}
