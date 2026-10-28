import { AsyncLocalStorage } from 'node:async_hooks'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { CertificateParagraph, EvidenceLink, ParagraphReference, WorkspaceState } from './domain.js'
import { isDatabaseEnabled } from './infrastructure/postgres.js'
import { listKnowledgeFilesForWorkspace } from './commercial/knowledge-file-service.js'
import { getWorkspaceDataDir } from './config/paths.js'
import { shouldUseCommercialKnowledgeStore } from './knowledge-mode.js'
import { inheritWorkspaceSnapshot, WorkspaceSqliteStore } from './infrastructure/workspace-sqlite.js'
import {
  buildClaimEvidenceMatches,
  buildClaimUnits,
  buildEvidenceFragments,
} from './intelligence/evidence-matching.js'
import { buildInitialState } from './seed.js'

const dataDir = getWorkspaceDataDir()
const stateFile = path.join(dataDir, 'workspace.json')
const workspaceContextStorage = new AsyncLocalStorage<{ account: string | null }>()
const STATUTE_PLACEHOLDER_SNIPPETS = [
  '官方原文已定位',
  '当前官方接口未直接返回结构化正文',
] as const

interface WorkspacePaths {
  account: string | null
  dataDir: string
  stateFile: string
  stateFileBackup: string
}

function normalizeWorkspaceAccount(account?: string | null) {
  const trimmed = account?.trim().toLowerCase() ?? ''
  return trimmed || null
}

function createWorkspaceAccountSlug(account: string) {
  return account
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'workspace'
}

function createWorkspaceUserId(account: string) {
  return `user-${createWorkspaceAccountSlug(account)}`
}

export function getCurrentWorkspaceAccount() {
  return workspaceContextStorage.getStore()?.account ?? null
}

function resolveWorkspacePaths(account = getCurrentWorkspaceAccount()): WorkspacePaths {
  if (!account) {
    return {
      account: null,
      dataDir,
      stateFile,
      stateFileBackup: path.join(dataDir, 'workspace.backup.json'),
    }
  }

  const workspaceDir = path.join(dataDir, 'workspaces', createWorkspaceAccountSlug(account))
  return {
    account,
    dataDir: workspaceDir,
    stateFile: path.join(workspaceDir, 'workspace.json'),
    stateFileBackup: path.join(workspaceDir, 'workspace.backup.json'),
  }
}

function createSeededWorkspaceForAccount(account: string) {
  const seeded = buildInitialState()
  return normalizeWorkspace({
    ...seeded,
    user: {
      ...seeded.user,
      id: createWorkspaceUserId(account),
      email: account,
    },
  })
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function buildParagraphRichText(text: string) {
  const lines = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)

  if (!lines.length) {
    return '<p></p>'
  }

  return lines.map((line) => `<p>${escapeHtml(line)}</p>`).join('')
}

function normalizeParagraphLinks(paragraph: CertificateParagraph): CertificateParagraph {
  const baseLinks = paragraph.links?.length
    ? paragraph.links
    : paragraph.link
      ? [paragraph.link]
      : []

  const links: EvidenceLink[] = baseLinks.map((link, index) => ({
    ...link,
    id: link.id ?? `${paragraph.id}-link-${index + 1}`,
    evidenceId: link.evidenceId,
    locator: link.locator,
    quote: link.quote,
    note: link.note,
  }))

  return {
    ...paragraph,
    richText: paragraph.richText ?? buildParagraphRichText(paragraph.text),
    links,
    link: links[0],
    references: normalizeParagraphReferences(paragraph.references),
  }
}

function normalizeParagraphReferences(references: CertificateParagraph['references']): ParagraphReference[] {
  return (references ?? []).map((reference, index) => ({
    ...reference,
    id: reference.id ?? `${reference.type}-${reference.targetId}-${index + 1}`,
  }))
}

function isPlaceholderStatuteContent(content: string | undefined) {
  if (!content?.trim()) {
    return true
  }

  return STATUTE_PLACEHOLDER_SNIPPETS.some((snippet) => content.includes(snippet))
}

function normalizeStatuteContentForComparison(content: string | undefined) {
  return (content ?? '')
    .replace(/\s+/g, '')
    .replace(/[（）()【】\[\]《》“”"'`]/g, '')
    .replace(/[，。,；：、？！]/g, '')
    .replace(/[一二三四五六七八九十百千万两0-9]+/g, '')
    .replace(/等$/u, '')
    .trim()
}

function shouldUseSeededStatuteContent(currentContent: string | undefined, seededContent: string) {
  if (isPlaceholderStatuteContent(currentContent)) {
    return true
  }

  const normalizedCurrent = normalizeStatuteContentForComparison(currentContent)
  const normalizedSeeded = normalizeStatuteContentForComparison(seededContent)
  if (!normalizedCurrent || normalizedCurrent === normalizedSeeded) {
    return false
  }

  return normalizedCurrent.length < normalizedSeeded.length
    && normalizedSeeded.includes(normalizedCurrent)
}

function repairKnowledgeStatutes(state: WorkspaceState) {
  const seededKnowledgeStatutes = buildInitialState().knowledgeStatutes
  const repairedDocuments = (state.knowledgeStatutes ?? []).map((document) => {
    const seededDocument = seededKnowledgeStatutes.find((item) => item.title === document.title)
    if (!seededDocument) {
      return document
    }

    const repairedArticles = document.articles.map((article) => {
      const seededArticle = seededDocument.articles.find((item) => item.articleNumber === article.articleNumber)
      if (!seededArticle) {
        return article
      }

      if (!shouldUseSeededStatuteContent(article.content, seededArticle.content)) {
        return {
          ...article,
          aliases: Array.from(new Set([...seededArticle.aliases, ...article.aliases])),
          topicTags: Array.from(new Set([...seededArticle.topicTags, ...article.topicTags])),
        }
      }

      return {
        ...article,
        content: seededArticle.content,
        plainText: seededArticle.plainText,
        aliases: Array.from(new Set([...seededArticle.aliases, ...article.aliases])),
        topicTags: Array.from(new Set([...seededArticle.topicTags, ...article.topicTags])),
      }
    })

    const existingArticleNumbers = new Set(repairedArticles.map((item) => item.articleNumber))
    const missingSeededArticles = seededDocument.articles.filter((item) => !existingArticleNumbers.has(item.articleNumber))

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
      sourceUrl:
        !document.sourceUrl || document.sourceUrl === 'https://flk.npc.gov.cn/'
          ? seededDocument.sourceUrl
          : document.sourceUrl,
      sourceTextUrl:
        !document.sourceTextUrl || document.sourceTextUrl === 'https://flk.npc.gov.cn/'
          ? seededDocument.sourceTextUrl
          : document.sourceTextUrl,
      keywords: Array.from(new Set([...seededDocument.keywords, ...document.keywords])),
      articles: [...repairedArticles, ...missingSeededArticles],
    }
  })

  const existingTitles = new Set(repairedDocuments.map((item) => item.title))
  const missingSeededDocuments = seededKnowledgeStatutes.filter((item) => !existingTitles.has(item.title))

  return [...repairedDocuments, ...missingSeededDocuments]
}

function removeLegacyDemoWorkspace(state: WorkspaceState): WorkspaceState {
  const demoCase = (state.cases ?? []).find((item) =>
    item.name === '王某买卖合同纠纷'
    && item.description === '演示案件，用于验证证据锚定与左右分屏核验流程。',
  )

  if (!demoCase) {
    return state
  }

  const demoEvidences = (state.evidences ?? []).filter((item) => item.caseId === demoCase.id)
  const demoEvidenceSignatures = new Set(demoEvidences.map((item) => `${item.number}|${item.name}|${item.fileName}`))
  const expectedDemoSignatures = new Set([
    'E01|微信聊天记录截图|微信截图_付款催告.png',
    'E02|买卖合同|买卖合同.docx',
  ])

  const matchesLegacyDemoEvidenceSet =
    demoEvidenceSignatures.size === expectedDemoSignatures.size
    && [...demoEvidenceSignatures].every((item) => expectedDemoSignatures.has(item))

  const demoCertificates = (state.certificates ?? []).filter((item) => item.caseId === demoCase.id)
  const matchesLegacyDemoCertificateSet =
    demoCertificates.length === 1
    && demoCertificates[0].title === '王某买卖合同纠纷原告质证书'
    && demoCertificates[0].paragraphs.length === 2
    && demoCertificates[0].paragraphs.every((paragraph) => paragraph.text.startsWith('原告质证意见：针对证据 E0'))

  if (!matchesLegacyDemoEvidenceSet || !matchesLegacyDemoCertificateSet) {
    return state
  }

  const removedEvidenceIds = new Set(demoEvidences.map((item) => item.id))
  const removedCertificateIds = new Set(demoCertificates.map((item) => item.id))

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
  }
}

function normalizeWorkspace(state: WorkspaceState): WorkspaceState {
  const normalizedState = removeLegacyDemoWorkspace(state)
  const evidences = (normalizedState.evidences ?? []).map((evidence) => ({
    ...evidence,
    relativePath: evidence.relativePath ?? evidence.fileName,
    sourceDataUrl: evidence.sourceDataUrl ?? (evidence.storageKey ? undefined : evidence.previewDataUrl),
    pageImageDataUrls: evidence.pageImageDataUrls ?? [],
    sourceMimeType:
      evidence.sourceMimeType ??
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
  }))

  const certificates = (normalizedState.certificates ?? []).map((certificate) => ({
    ...certificate,
    paragraphs: (certificate.paragraphs ?? []).map((paragraph) => normalizeParagraphLinks(paragraph)),
  }))

  const evidenceFragments = buildEvidenceFragments(evidences)
  const claimUnits = buildClaimUnits(certificates)
  const derivedMatches = buildClaimEvidenceMatches(certificates, claimUnits, evidenceFragments)
  const validClaimIds = new Set(claimUnits.map((item) => item.id))
  const validFragmentIds = new Set(evidenceFragments.map((item) => item.id))
  const persistedModelMatches = (normalizedState.claimEvidenceMatches ?? []).filter((match) =>
    match.source === 'model'
    && validClaimIds.has(match.claimUnitId)
    && validFragmentIds.has(match.evidenceFragmentId),
  )
  const claimEvidenceMatches = [...derivedMatches, ...persistedModelMatches]

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
  }
}

export async function readWorkspace(): Promise<WorkspaceState> {
  const paths = resolveWorkspacePaths()
  const store = new WorkspaceSqliteStore(paths.dataDir)

  const hydrateWorkspace = async (normalized: WorkspaceState) => {
    if (!shouldUseCommercialKnowledgeStore() || !isDatabaseEnabled()) {
      return normalized
    }

    try {
      const hydrated = {
        ...normalized,
        knowledgeFiles: await listKnowledgeFilesForWorkspace(),
      }
      const { hydrateBillingWorkspace } = await import('./billing-service.js')
      return await hydrateBillingWorkspace(hydrated)
    } catch {
      return normalized
    }
  }

  const readLegacyWorkspace = (filePath: string) => {
    const raw = readFileSync(filePath, 'utf8')
    const normalized = normalizeWorkspace(JSON.parse(raw) as WorkspaceState)

    if (!paths.account) {
      return normalized
    }

    return normalizeWorkspace({
      ...normalized,
      user: {
        ...normalized.user,
        email: paths.account,
        id: normalized.user.id || createWorkspaceUserId(paths.account),
      },
    })
  }

  let migrationSource: string | undefined
  const persisted = store.read(() => {
    let hasLegacyData = false
    let lastError: unknown
    for (const file of [paths.stateFile, paths.stateFileBackup]) {
      try {
        const migrated = readLegacyWorkspace(file)
        migrationSource = file
        return migrated
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          hasLegacyData = true
          lastError = error
        }
      }
    }
    if (hasLegacyData) {
      throw new Error('旧工作区数据无法迁移，已阻止自动重置。请保留 workspace.json 及备份并检查数据完整性。', { cause: lastError })
    }
    if (paths.account) {
      // Preserve the pre-account-isolation workspace only for its original owner.
      let legacyError: unknown
      for (const file of [stateFile, path.join(dataDir, 'workspace.backup.json')]) {
        try {
          const legacy = normalizeWorkspace(JSON.parse(readFileSync(file, 'utf8')) as WorkspaceState)
          if (normalizeWorkspaceAccount(legacy.user.email) === paths.account) {
            migrationSource = file
            return legacy
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            legacyError = error
          }
        }
      }
      if (legacyError) {
        throw new Error('旧工作区数据无法读取，已阻止自动创建空工作区。请检查 workspace.json 及备份。', { cause: legacyError })
      }
    }
    return paths.account ? createSeededWorkspaceForAccount(paths.account) : normalizeWorkspace(buildInitialState())
  }, () => migrationSource)
  const normalized = inheritWorkspaceSnapshot(persisted, normalizeWorkspace(persisted))
  return inheritWorkspaceSnapshot(normalized, await hydrateWorkspace(normalized))
}

export async function writeWorkspace(state: WorkspaceState) {
  const paths = resolveWorkspacePaths()
  const normalized = inheritWorkspaceSnapshot(state, normalizeWorkspace(paths.account
    ? {
      ...state,
      user: {
        ...state.user,
        email: paths.account,
        id: state.user.id || createWorkspaceUserId(paths.account),
      },
    }
    : state))
  new WorkspaceSqliteStore(paths.dataDir).save(normalized)
  Object.assign(state, normalized)
  inheritWorkspaceSnapshot(normalized, state)
}

export function runWithWorkspaceAccount<T>(account: string | null | undefined, callback: () => T) {
  return workspaceContextStorage.run({ account: normalizeWorkspaceAccount(account) }, callback)
}
