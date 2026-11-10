import type { WorkspaceState } from '../domain.js'
import { tokenize } from './tokenize.js'

export type SearchScope = 'evidence' | 'paragraph' | 'statute' | 'case'

export interface SearchResult {
  id: string
  scope: SearchScope
  title: string
  snippet: string
  score: number
  target: {
    caseId?: string
    evidenceId?: string
    certificateId?: string
    paragraphId?: string
    statuteId?: string
    knowledgeCaseId?: string
  }
}

export interface WorkspaceSearchOptions {
  caseId?: string
  scopes?: SearchScope[]
  limit?: number
}

export interface WorkspaceSearchResult {
  results: SearchResult[]
  truncated: boolean
  externalCaseSearch: { query: string; available: boolean }
}

// 单份材料正文的扫描上限：OCR 文本可能有几十万字，全量扫描会拖慢响应。
export const MAX_EVIDENCE_SCAN_CHARS = 20000
// 单部法律的条文扫描上限同上，避免整部法律典藏被一次性读完。
export const MAX_STATUTE_SCAN_CHARS = 20000
export const DEFAULT_SEARCH_LIMIT = 50
// 命中处前后截取的字数
const SNIPPET_RADIUS = 60

const SCOPE_LABELS: Record<SearchScope, string> = {
  evidence: '材料',
  paragraph: '文书段落',
  statute: '法条',
  case: '案例',
}

export function getSearchScopeLabel(scope: SearchScope) {
  return SCOPE_LABELS[scope] ?? scope
}

function matchWeight(queryTokens: string[], text: string, weight: number) {
  if (!text) {
    return 0
  }
  const tokens = new Set(tokenize(text))
  let hits = 0
  for (const token of queryTokens) {
    if (tokens.has(token)) {
      hits += 1
    }
  }
  return hits * weight
}

function buildSnippet(text: string, queryTokens: string[], radius = SNIPPET_RADIUS) {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized) {
    return ''
  }
  const lower = normalized.toLowerCase()
  let index = -1
  for (const token of queryTokens) {
    const found = lower.indexOf(token)
    if (found >= 0 && (index < 0 || found < index)) {
      index = found
    }
  }
  if (index < 0) {
    return normalized.length > radius * 2 ? `${normalized.slice(0, radius * 2)}…` : normalized
  }
  const start = Math.max(0, index - radius)
  const end = Math.min(normalized.length, index + radius)
  return `${start > 0 ? '…' : ''}${normalized.slice(start, end)}${end < normalized.length ? '…' : ''}`
}

/**
 * 本地全语料检索：材料 / 文书段落 / 法条 / 本地案例。
 * 外部案例库不在这里调用——付费接口由用户显式触发。
 */
export function searchWorkspace(
  state: WorkspaceState,
  query: string,
  options: WorkspaceSearchOptions = {},
): { results: SearchResult[]; truncated: boolean } {
  const trimmed = query.trim()
  if (!trimmed) {
    return { results: [], truncated: false }
  }

  const queryTokens = [...new Set(tokenize(trimmed))]
  if (!queryTokens.length) {
    return { results: [], truncated: false }
  }

  const scopes = options.scopes?.length ? options.scopes : (['evidence', 'paragraph', 'statute', 'case'] as SearchScope[])
  const limit = Math.max(1, options.limit ?? DEFAULT_SEARCH_LIMIT)
  const results: SearchResult[] = []
  let truncated = false

  const evidences = state.evidences.filter(item => !options.caseId || item.caseId === options.caseId)
  const certificates = state.certificates.filter(item => !options.caseId || item.caseId === options.caseId)

  if (scopes.includes('evidence')) {
    for (const evidence of evidences) {
      const body = evidence.ocrText ?? ''
      const bodyScanned = body.slice(0, MAX_EVIDENCE_SCAN_CHARS)
      const bodyTruncated = body.length > MAX_EVIDENCE_SCAN_CHARS
      const score = matchWeight(queryTokens, evidence.name, 3)
        + matchWeight(queryTokens, evidence.fileName ?? '', 3)
        + matchWeight(queryTokens, evidence.relativePath ?? '', 3)
        + matchWeight(queryTokens, bodyScanned, 1)
      if (score <= 0) {
        continue
      }
      if (bodyTruncated) {
        truncated = true
      }
      const snippet = buildSnippet(bodyScanned || evidence.name, queryTokens)
      results.push({
        id: `evidence:${evidence.id}`,
        scope: 'evidence',
        title: `${evidence.number} ${evidence.name}`,
        snippet: bodyTruncated ? `${snippet}（正文仅检索前 2 万字）` : snippet,
        score,
        target: { caseId: evidence.caseId, evidenceId: evidence.id },
      })
    }
  }

  if (scopes.includes('paragraph')) {
    for (const certificate of certificates) {
      for (const paragraph of certificate.paragraphs ?? []) {
        const score = matchWeight(queryTokens, paragraph.text, 2)
        if (score <= 0) {
          continue
        }
        results.push({
          id: `paragraph:${paragraph.id}`,
          scope: 'paragraph',
          title: `${certificate.title} · 第 ${(certificate.paragraphs ?? []).indexOf(paragraph) + 1} 段`,
          snippet: buildSnippet(paragraph.text, queryTokens),
          score,
          target: {
            caseId: certificate.caseId,
            certificateId: certificate.id,
            paragraphId: paragraph.id,
          },
        })
      }
    }
  }

  if (scopes.includes('statute')) {
    for (const document of state.knowledgeStatutes ?? []) {
      const articlesText = (document.articles ?? [])
        .map(article => `${article.articleNumber}${article.content}`)
        .join('\n')
      const bodyScanned = articlesText.slice(0, MAX_STATUTE_SCAN_CHARS)
      const titleScore = matchWeight(queryTokens, document.title, 3)
      const bodyScore = matchWeight(queryTokens, bodyScanned, 1.5)
      const score = titleScore + bodyScore
      if (score <= 0) {
        continue
      }
      results.push({
        id: `statute:${document.id}`,
        scope: 'statute',
        title: document.title,
        snippet: buildSnippet(bodyScanned, queryTokens),
        score,
        target: { statuteId: document.id },
      })
    }
  }

  if (scopes.includes('case')) {
    for (const entry of state.knowledgeCases ?? []) {
      const titleScore = matchWeight(queryTokens, entry.title, 3)
      const summaryScore = matchWeight(queryTokens, [
        entry.caseNumber,
        entry.courtName,
        entry.issueSummary,
        entry.holdingSummary,
      ].filter(Boolean).join(' '), 1)
      const score = titleScore + summaryScore
      if (score <= 0) {
        continue
      }
      results.push({
        id: `case:${entry.id}`,
        scope: 'case',
        title: entry.title,
        snippet: buildSnippet(entry.holdingSummary || entry.issueSummary || entry.caseNumber, queryTokens),
        score,
        target: { knowledgeCaseId: entry.id },
      })
    }
  }

  results.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
  return { results: results.slice(0, limit), truncated }
}
