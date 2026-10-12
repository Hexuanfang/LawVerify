import type {
  Certificate,
  Evidence,
  EvidenceLink,
  EvidenceFragment,
  EvidenceFragmentSourceKind,
  EvidenceFragmentType,
  ClaimEvidenceMatch,
  ClaimUnit,
  ClaimUnitStatus,
} from '../domain.js'

const NEGATION_KEYWORDS = ['未', '没有', '并未', '拒绝', '否认', '未予', '不存在', '不能', '无法']
const UNCERTAINTY_KEYWORDS = ['可能', '疑似', '待核实', '尚需', '暂未', '尚未', '建议', '进一步', '核对']
const SUPPORT_KEYWORDS = ['确认', '收到', '支付', '签收', '约定', '承诺', '交付', '履行', '催告', '欠款']

function summarizeText(text: string, limit = 120) {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized) {
    return '待补充摘要'
  }

  return normalized.length > limit ? `${normalized.slice(0, limit)}...` : normalized
}

function tokenizeKeywords(text: string, limit = 12) {
  return Array.from(
    new Set(
      text
        .toLowerCase()
        .split(/[\s,.;:，。；：、()（）【】\[\]\-_/]+/)
        .map((item) => item.trim())
        .filter((item) => item.length >= 2),
    ),
  ).slice(0, limit)
}

function inferFragmentType(evidence: Evidence): EvidenceFragmentType {
  switch (evidence.type) {
    case 'pdf':
      return 'page'
    case 'image':
      return 'ocr_block'
    case 'word':
    case 'text':
      return 'paragraph'
    default:
      return 'document'
  }
}

function inferSourceKind(evidence: Evidence): EvidenceFragmentSourceKind {
  switch (evidence.type) {
    case 'image':
      return 'ocr'
    case 'pdf':
    case 'word':
    case 'text':
      return 'native_text'
    default:
      return 'vision'
  }
}

function buildEvidenceLocator(evidence: Evidence) {
  if (evidence.anchorHint?.trim()) {
    return evidence.anchorHint.trim()
  }

  if (evidence.type === 'pdf') {
    return `第 ${evidence.pages ?? 1} 页`
  }

  return '原件全文'
}

function splitClaimSentences(text: string) {
  const segments = text
    .replace(/\r\n/g, '\n')
    .split(/(?<=[。！？；;])\s*|\n+/)
    .map((item) => item.trim())
    .filter(Boolean)

  return segments.length ? segments : [text.trim()].filter(Boolean)
}

function inferClaimStatus(hasLinks: boolean): ClaimUnitStatus {
  return hasLinks ? 'linked' : 'unmatched'
}

function countKeywordOverlap(left: string[], right: string[]) {
  if (!left.length || !right.length) {
    return 0
  }

  const rightSet = new Set(right)
  return left.reduce((total, item) => total + (rightSet.has(item) ? 1 : 0), 0)
}

function extractNumericTokens(text: string) {
  return Array.from(new Set(text.match(/\d+(?:\.\d+)?/g) ?? []))
}

function containsAny(text: string, keywords: string[]) {
  return keywords.some((keyword) => text.includes(keyword))
}

function countContains(text: string, keywords: string[]) {
  return keywords.reduce((total, keyword) => total + (text.includes(keyword) ? 1 : 0), 0)
}

function splitParagraphBlocks(text: string) {
  const normalized = text.replace(/\r\n/g, '\n').trim()
  if (!normalized) {
    return []
  }

  return normalized
    .split(/\n\s*\n+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function splitSentenceBlocks(text: string, maxLength = 120) {
  const segments = text
    .replace(/\r\n/g, '\n')
    .split(/(?<=[。！？；;])\s*|\n+/)
    .map((item) => item.trim())
    .filter(Boolean)

  if (!segments.length) {
    return text.trim() ? [text.trim()] : []
  }

  const blocks: string[] = []
  let current = ''

  for (const segment of segments) {
    const next = current ? `${current} ${segment}` : segment
    if (current && next.length > maxLength) {
      blocks.push(current)
      current = segment
      continue
    }
    current = next
  }

  if (current) {
    blocks.push(current)
  }

  return blocks
}

function chunkIntoGroups<T>(items: T[], groupCount: number) {
  if (!items.length || groupCount <= 1) {
    return [items]
  }

  const normalizedGroupCount = Math.min(groupCount, items.length)
  const groups: T[][] = []
  let cursor = 0

  for (let index = 0; index < normalizedGroupCount; index += 1) {
    const remainingItems = items.length - cursor
    const remainingGroups = normalizedGroupCount - index
    const size = Math.ceil(remainingItems / remainingGroups)
    groups.push(items.slice(cursor, cursor + size))
    cursor += size
  }

  return groups.filter((group) => group.length > 0)
}

function createFragment(
  evidence: Evidence,
  sequence: number,
  fragmentType: EvidenceFragmentType,
  locator: string,
  text: string,
  overrides: Partial<EvidenceFragment> = {},
): EvidenceFragment {
  return {
    id: `${evidence.id}-fragment-${sequence}`,
    caseId: evidence.caseId,
    evidenceId: evidence.id,
    fragmentType,
    sourceKind: inferSourceKind(evidence),
    sequence,
    locator,
    text,
    summary: summarizeText(text),
    keywords: tokenizeKeywords(`${evidence.number} ${evidence.name} ${locator} ${text}`),
    page: overrides.page,
    timeStartMs: overrides.timeStartMs,
    timeEndMs: overrides.timeEndMs,
    confidence: overrides.confidence ?? (evidence.type === 'image' ? 0.78 : 0.9),
  }
}

function buildPdfFragments(evidence: Evidence) {
  const sourceText = evidence.ocrText?.trim() || evidence.name || evidence.fileName
  const paragraphs = splitParagraphBlocks(sourceText)
  const units = paragraphs.length ? paragraphs : splitSentenceBlocks(sourceText, 180)
  const grouped = chunkIntoGroups(units.length ? units : [sourceText], Math.max(1, evidence.pages ?? 1))

  return grouped.map((group, index) =>
    createFragment(
      evidence,
      index + 1,
      'page',
      `第 ${index + 1} 页`,
      group.join('\n\n'),
      {
        page: index + 1,
      },
    ),
  )
}

function buildWordFragments(evidence: Evidence) {
  const sourceText = evidence.ocrText?.trim() || evidence.name || evidence.fileName
  const paragraphs = splitParagraphBlocks(sourceText)
  const units = paragraphs.length ? paragraphs : splitSentenceBlocks(sourceText, 150)

  return units.map((paragraph, index) =>
    createFragment(
      evidence,
      index + 1,
      'paragraph',
      `第 ${index + 1} 段`,
      paragraph,
    ),
  )
}

function buildImageFragments(evidence: Evidence) {
  const sourceText = evidence.ocrText?.trim() || evidence.name || evidence.fileName
  const blocks = splitSentenceBlocks(sourceText, 90)
  const locatorPrefix = evidence.anchorHint?.trim() || '识别区域'

  return (blocks.length ? blocks : [sourceText]).map((block, index) =>
    createFragment(
      evidence,
      index + 1,
      'ocr_block',
      `${locatorPrefix} ${index + 1}`,
      block,
    ),
  )
}

function buildGenericFragments(evidence: Evidence) {
  const text = evidence.ocrText?.trim() || evidence.name || evidence.fileName
  return [
    createFragment(
      evidence,
      1,
      inferFragmentType(evidence),
      buildEvidenceLocator(evidence),
      text,
    ),
  ]
}

export function buildEvidenceFragments(evidences: Evidence[]): EvidenceFragment[] {
  return evidences.flatMap((evidence) => {
    switch (evidence.type) {
      case 'pdf':
        return buildPdfFragments(evidence)
      case 'word':
      case 'text':
        return buildWordFragments(evidence)
      case 'image':
        return buildImageFragments(evidence)
      default:
        return buildGenericFragments(evidence)
    }
  })
}

export function buildClaimUnits(certificates: Certificate[]): ClaimUnit[] {
  return certificates.flatMap((certificate) =>
    certificate.paragraphs.flatMap((paragraph) => {
      const hasLinks = Boolean(paragraph.links?.length || paragraph.link)
      return splitClaimSentences(paragraph.text).map((sentence, index) => ({
        id: `${paragraph.id}-claim-${index + 1}`,
        caseId: certificate.caseId,
        certificateId: certificate.id,
        paragraphId: paragraph.id,
        sentenceIndex: index,
        text: sentence,
        normalizedText: sentence.replace(/\s+/g, ' ').trim(),
        sourceParagraphText: paragraph.text,
        labels: tokenizeKeywords(sentence, 8),
        status: inferClaimStatus(hasLinks),
      }))
    }),
  )
}

export function buildClaimEvidenceMatches(
  certificates: Certificate[],
  claimUnits: ClaimUnit[],
  evidenceFragments: EvidenceFragment[],
): ClaimEvidenceMatch[] {
  const claimUnitsByParagraph = new Map<string, ClaimUnit[]>()
  for (const claim of claimUnits) {
    const existing = claimUnitsByParagraph.get(claim.paragraphId) ?? []
    existing.push(claim)
    claimUnitsByParagraph.set(claim.paragraphId, existing)
  }

  const fragmentsByEvidenceId = new Map<string, EvidenceFragment[]>()
  const fragmentsByCaseId = new Map<string, EvidenceFragment[]>()
  for (const fragment of evidenceFragments) {
    const existing = fragmentsByEvidenceId.get(fragment.evidenceId) ?? []
    existing.push(fragment)
    fragmentsByEvidenceId.set(fragment.evidenceId, existing)

    const caseFragments = fragmentsByCaseId.get(fragment.caseId) ?? []
    caseFragments.push(fragment)
    fragmentsByCaseId.set(fragment.caseId, caseFragments)
  }

  function scoreFragmentForLink(link: EvidenceLink, fragment: EvidenceFragment) {
    let score = 0
    if (link.locator && fragment.locator.includes(link.locator)) {
      score += 8
    }

    if (link.quote) {
      const quoteKeywords = tokenizeKeywords(link.quote, 10)
      score += quoteKeywords.reduce(
        (total, keyword) => total + (fragment.text.toLowerCase().includes(keyword) ? 2 : 0),
        0,
      )
    }

    if (link.locator && link.locator.includes(String(fragment.page ?? ''))) {
      score += 3
    }

    return score
  }

  function selectBestFragment(link: EvidenceLink) {
    const fragments = fragmentsByEvidenceId.get(link.evidenceId) ?? []
    if (!fragments.length) {
      return null
    }

    return [...fragments]
      .sort((left, right) => scoreFragmentForLink(link, right) - scoreFragmentForLink(link, left))
      [0]
  }

  function buildHeuristicMatches(
    claim: ClaimUnit,
    excludedEvidenceIds: Set<string>,
    existingMatchIds: Set<string>,
  ): ClaimEvidenceMatch[] {
    const caseFragments = fragmentsByCaseId.get(claim.caseId) ?? []
    if (!caseFragments.length) {
      return []
    }

    const claimKeywords = tokenizeKeywords(`${claim.text} ${claim.normalizedText} ${claim.labels.join(' ')}`, 16)
    if (!claimKeywords.length) {
      return []
    }

    const claimText = claim.normalizedText.toLowerCase()
    const claimNumbers = extractNumericTokens(claim.normalizedText)
    const claimHasNegation = containsAny(claim.normalizedText, NEGATION_KEYWORDS)
    const claimHasUncertainty = containsAny(claim.normalizedText, UNCERTAINTY_KEYWORDS)
    const claimSupportSignalCount = countContains(claim.normalizedText, SUPPORT_KEYWORDS)

    return caseFragments
      .filter((fragment) => !excludedEvidenceIds.has(fragment.evidenceId))
      .map((fragment) => {
        const fragmentText = fragment.text.toLowerCase()
        const keywordOverlap = countKeywordOverlap(claimKeywords, fragment.keywords)
        const textCoverage = claimKeywords.reduce(
          (total, keyword) => total + (fragmentText.includes(keyword) ? 1 : 0),
          0,
        )
        const numericOverlap = countKeywordOverlap(claimNumbers, extractNumericTokens(fragment.text))
        const fragmentHasNegation = containsAny(fragment.text, NEGATION_KEYWORDS)
        const fragmentHasUncertainty = containsAny(fragment.text, UNCERTAINTY_KEYWORDS)
        const fragmentSupportSignalCount = countContains(fragment.text, SUPPORT_KEYWORDS)
        const contradictionSignal = keywordOverlap > 0 && claimHasNegation !== fragmentHasNegation
        const rawScore = keywordOverlap * 10
          + textCoverage * 6
          + numericOverlap * 8
          + Math.min(claimSupportSignalCount, fragmentSupportSignalCount) * 3
          + (fragment.confidence ?? 0.7) * 10
          - (fragmentHasUncertainty ? 4 : 0)

        const rerankScore = rawScore
          + (contradictionSignal ? 5 : 0)
          + (fragment.locator.includes('第') ? 2 : 0)

        return {
          fragment,
          fragmentText,
          keywordOverlap,
          textCoverage,
          numericOverlap,
          contradictionSignal,
          uncertaintySignal: claimHasUncertainty || fragmentHasUncertainty,
          supportSignalCount: Math.min(claimSupportSignalCount, fragmentSupportSignalCount),
          normalizedScore: Math.min(0.91, Number((rerankScore / 100).toFixed(2))),
        }
      })
      .filter((item) => item.keywordOverlap > 0 || item.textCoverage >= 2 || item.numericOverlap > 0)
      .sort((left, right) => right.normalizedScore - left.normalizedScore)
      .slice(0, 3)
      .flatMap(({ fragment, fragmentText, keywordOverlap, textCoverage, numericOverlap, contradictionSignal, uncertaintySignal, supportSignalCount, normalizedScore }) => {
        const matchId = `${claim.id}-heuristic-match-${fragment.id}`
        if (existingMatchIds.has(matchId)) {
          return []
        }

        existingMatchIds.add(matchId)
        const relation =
          contradictionSignal
            ? 'contradict'
            : uncertaintySignal || normalizedScore < 0.72
              ? 'partial'
              : 'support'
        const overlapKeywords = claimKeywords
          .filter((keyword) => fragmentText.includes(keyword))
          .slice(0, 4)
        const reasonSegments = [
          `系统先按主张关键词召回，再结合数字锚点与否定信号进行规则精排。`,
          `命中 ${keywordOverlap} 个关键词`,
          textCoverage ? `${textCoverage} 处文本覆盖` : '',
          numericOverlap ? `${numericOverlap} 处数字锚点` : '',
          supportSignalCount ? `${supportSignalCount} 处事实动词` : '',
          contradictionSignal ? '检测到相反否定信号' : '',
          uncertaintySignal ? '存在待核实表达' : '',
        ].filter(Boolean)

        return {
          id: matchId,
          caseId: claim.caseId,
          claimUnitId: claim.id,
          evidenceId: fragment.evidenceId,
          evidenceFragmentId: fragment.id,
          relation,
          score: normalizedScore,
          reason: reasonSegments.join('，'),
          quote: overlapKeywords.join(' / ') || summarizeText(fragment.text, 42),
          locator: fragment.locator,
          source: 'heuristic' as const,
          verified: false,
        }
      })
  }

  return certificates.flatMap((certificate) =>
    certificate.paragraphs.flatMap((paragraph) => {
      const links = paragraph.links?.length ? paragraph.links : paragraph.link ? [paragraph.link] : []
      const claimUnitsForParagraph = claimUnitsByParagraph.get(paragraph.id) ?? []
      const linkedEvidenceIds = new Set(links.map((link) => link.evidenceId))
      const existingMatchIds = new Set<string>()

      return claimUnitsForParagraph.flatMap((claim) => {
        const manualMatches = links.flatMap((link, index) => {
          const fragment = selectBestFragment(link)
          if (!fragment) {
            return []
          }

          const matchId = `${claim.id}-match-${index + 1}`
          existingMatchIds.add(matchId)

          return {
            id: matchId,
            caseId: certificate.caseId,
            claimUnitId: claim.id,
            evidenceId: link.evidenceId,
            evidenceFragmentId: fragment.id,
            relation: 'support' as const,
            score: paragraph.verified ? 0.98 : 0.88,
            reason: paragraph.verified ? '当前段落已人工核验并绑定证据。' : '当前段落已人工绑定证据，待进一步核验。',
            quote: link.quote,
            locator: link.locator || fragment.locator,
            source: 'manual' as const,
            verified: paragraph.verified,
          }
        })

        const heuristicMatches = buildHeuristicMatches(claim, linkedEvidenceIds, existingMatchIds)
        return [...manualMatches, ...heuristicMatches]
      })
    }),
  )
}
