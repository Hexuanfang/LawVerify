import type {
  KnowledgeStatuteArticle,
  KnowledgeStatuteDocument,
  ParagraphReference,
  ParagraphReferenceWarning,
} from '../domain.js'

// 自动挂接的法条引用与自动证据链接一样，重跑时按 note 整体替换。
export const AUTO_STATUTE_REFERENCE_NOTE = 'system:auto-statute-detected'

// 官方接口只回传法条元信息时的占位说明，不是条文原文。
const STATUTE_PLACEHOLDER_SNIPPETS = [
  '官方原文已定位',
  '当前官方接口未直接返回结构化正文',
] as const

export function isPlaceholderStatuteContent(content: string | undefined) {
  if (!content?.trim()) {
    return true
  }

  return STATUTE_PLACEHOLDER_SNIPPETS.some((snippet) => content.includes(snippet))
}

export type StatuteVersionStatus = {
  effectiveStatus: 'effective' | 'amended' | 'repealed'
  effectiveDate?: string
  revisionDate?: string
}

export function formatStatuteDate(value?: string) {
  const normalized = value?.trim()
  if (!normalized) {
    return ''
  }

  const matched = normalized.match(/^(\d{4})-(\d{2})-(\d{2})/)
  return matched ? `${matched[1]}年${Number(matched[2])}月${Number(matched[3])}日` : normalized
}

// 同一部法律的多个版本按可用性排序：现行有效 > 已修订 > 已废止。
export const STATUTE_STATUS_PRIORITY: Record<StatuteVersionStatus['effectiveStatus'], number> = {
  effective: 0,
  amended: 1,
  repealed: 2,
}

// 法条版本状态决定这条引用能不能直接当作依据：
// 废止版本不能引用，已修订版本需要人工核对适用时点。
export function describeStatuteVersionStatus(document: StatuteVersionStatus) {
  if (document.effectiveStatus === 'repealed') {
    const repealedAt = formatStatuteDate(document.revisionDate ?? document.effectiveDate)
    return {
      warning: 'statute-repealed' as ParagraphReferenceWarning,
      reason: `该版本已废止${repealedAt ? `（${repealedAt}）` : ''}，不能作为现行依据，请核对案件事实发生时间并改用现行有效版本。`,
    }
  }

  if (document.effectiveStatus === 'amended') {
    const effectiveAt = formatStatuteDate(document.effectiveDate)
    const revisedAt = formatStatuteDate(document.revisionDate)
    return {
      warning: 'statute-amended' as ParagraphReferenceWarning,
      reason: `该版本已修订${revisedAt ? `（${revisedAt}）` : ''}${effectiveAt ? `，现行文本施行日期 ${effectiveAt}` : ''}，引用内容与适用时点需人工核对。`,
    }
  }

  return { warning: undefined as ParagraphReferenceWarning | undefined, reason: undefined as string | undefined }
}

// 同一部法律可能有多个版本：现行有效优先，其次已修订，最后才是已废止。
export function pickPreferredStatuteBinding<T extends {
  document: { effectiveStatus: StatuteVersionStatus['effectiveStatus'] }
  article: { content?: string }
}>(candidates: T[]): T | null {
  if (!candidates.length) {
    return null
  }

  return [...candidates].sort((left, right) => {
    const statusDiff = STATUTE_STATUS_PRIORITY[left.document.effectiveStatus]
      - STATUTE_STATUS_PRIORITY[right.document.effectiveStatus]
    if (statusDiff) {
      return statusDiff
    }

    const contentDiff = Number(isPlaceholderStatuteContent(left.article.content))
      - Number(isPlaceholderStatuteContent(right.article.content))
    if (contentDiff) {
      return contentDiff
    }

    return (right.article.content?.length ?? 0) - (left.article.content?.length ?? 0)
  })[0] ?? null
}

// 生成法条引用：废止/已修订版本带警示，占位正文不当作引文。
export function buildStatuteReference(
  document: KnowledgeStatuteDocument,
  article: KnowledgeStatuteArticle,
  sentenceAnchor?: Pick<ParagraphReference, 'sentenceIndex' | 'sentenceText'>,
): ParagraphReference {
  const version = describeStatuteVersionStatus(document)
  const contentMissing = isPlaceholderStatuteContent(article.content)
  const warning = version.warning ?? (contentMissing ? 'statute-content-missing' : undefined)
  const reasons = [
    version.reason,
    contentMissing ? '本地权威库暂无该条正文，条文正文待补，不能把占位说明当作引文。' : '',
  ].filter(Boolean)

  return {
    id: `statute-${article.id}`,
    type: 'statute',
    targetId: article.id,
    sourceTitle: document.title,
    label: `${document.title} ${article.articleNumber}`,
    locator: article.articleNumber,
    quote: contentMissing ? '' : article.content,
    ...sentenceAnchor,
    note: AUTO_STATUTE_REFERENCE_NOTE,
    warning,
    reason: reasons.length ? reasons.join('') : undefined,
  }
}
