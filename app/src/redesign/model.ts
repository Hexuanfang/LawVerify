import type { AppState, CertificateParagraph } from '../types'

export const DOCUMENT_TYPES = [
  '起诉状',
  '答辩状',
  '证据清单',
  '质证意见',
  '代理词',
  '上诉状',
]
export const STATUS_NAMES = {
  pass: '绿·通过',
  warn: '黄·预警',
  fail: '红·不通过',
  miss: '红·缺源',
  note: '绿·已标注',
}
export type Verdict = keyof typeof STATUS_NAMES
export type Source = {
  st: 'l1' | 'l2' | 'l3'
  targetId: string
  name: string
  loc: string
  quote: string
  reason?: string
  relation?: string
  main?: boolean
}
export type ReviewElement = {
  id: string
  paragraphId: string
  certificateId: string
  quote: string
  start: number
  end: number
  src: 'l0' | Source['st']
  type: string
  verdict: Verdict
  conf: number | null
  reason: string
  sources: Source[]
  note: string
  verified: boolean
  sentenceIndex?: number
  original: CertificateParagraph
}

// 兼容早期只有 paragraph.link 的文书，缺失评分时保持未知。
export function paragraphElements(
  paragraph: CertificateParagraph,
  workspace: AppState,
  certificateId: string,
): ReviewElement[] {
  const links = paragraph.links?.length
    ? paragraph.links
    : paragraph.link
      ? [paragraph.link]
      : []
  const references = paragraph.references ?? []
  const claimsInParagraph = (workspace.claimUnits ?? []).filter(
    (claim) =>
      claim.certificateId === certificateId &&
      claim.paragraphId === paragraph.id && (!claim.sourceParagraphText || claim.sourceParagraphText === paragraph.text),
  )
  const indexed =
    [...links, ...references].some(
      (item) => item.sentenceIndex !== undefined,
    ) ||
    claimsInParagraph.length ||
    paragraph.linkageFocus?.length
  const ranges = indexed
    ? statementRanges(paragraph.text)
    : [
        {
          start: 0,
          end: paragraph.text.length,
          text: paragraph.text,
          sentenceIndex: undefined,
        },
      ]
  if (
    !links.length &&
    !references.length &&
    /^\s*<h[1-6][ >]/i.test(paragraph.richText || '') &&
    !/<(?:p|table|ul|ol|blockquote)[ >]/i.test(paragraph.richText || '')
  )
    return []
  return ranges
    .filter((range) => {
      const focus = paragraph.linkageFocus?.find(
        (item) => item.sentenceIndex === range.sentenceIndex,
      )
      const hasSource = [...links, ...references].some(
        (item) => item.sentenceIndex === range.sentenceIndex,
      )
      return hasSource || !focus || focus.priority !== 'skip'
    })
    .map(({ sentenceIndex, start, end, text: quote }) => {
      const matchingLinks = links.filter(
        (link) =>
          link.sentenceIndex === sentenceIndex ||
          link.sentenceIndex === undefined,
      )
      const matchingReferences = references.filter(
        (reference) =>
          reference.sentenceIndex === sentenceIndex ||
          reference.sentenceIndex === undefined,
      )
      const sources: Source[] = [
        ...matchingLinks.map((link) => ({
          st: 'l1' as const,
          targetId: link.evidenceId,
          name:
            workspace.evidences.find((item) => item.id === link.evidenceId)
              ?.name ?? '材料已不存在',
          loc: link.locator ?? '',
          quote: link.quote ?? '',
          relation: link.relation,
          reason: link.reason,
        })),
        ...matchingReferences.map((reference) => ({
          st: reference.type === 'statute' ? ('l2' as const) : ('l3' as const),
          targetId: reference.targetId,
          name: reference.sourceTitle,
          loc: reference.locator ?? '',
          quote: reference.quote ?? '',
          reason: reference.reason,
        })),
      ]
      const claims = (workspace.claimUnits ?? []).filter(
        (claim) =>
          claim.certificateId === certificateId &&
          claim.paragraphId === paragraph.id &&
          (!claim.sourceParagraphText || claim.sourceParagraphText === paragraph.text) &&
          (sentenceIndex === undefined ||
            claim.sentenceIndex === sentenceIndex),
      )
      const matches = (workspace.claimEvidenceMatches ?? []).filter((match) =>
        claims.some((claim) => claim.id === match.claimUnitId) &&
        matchingLinks.some(link => link.evidenceId === match.evidenceId && !(link.relation === 'support' && link.reason === '人工维护引用关系，请重新审阅。')),
      )
      const conflict =
        matchingLinks.some((link) => link.relation === 'contradict') ||
        matches.some((match) => match.relation === 'contradict')
      const invalidLaw = matchingReferences.some(
        (reference) => reference.warning,
      )
      const missingSource = matchingLinks.some(
        (link) =>
          !workspace.evidences.some((item) => item.id === link.evidenceId),
      )
      let verdict: Verdict = sources.length ? 'warn' : 'miss'
      if (paragraph.verified && sources.length) verdict = 'pass'
      if (conflict || invalidLaw || missingSource) verdict = 'fail'
      const scores = matches
        .map((match) => match.score)
        .filter((score) => Number.isFinite(score))
      const conf = scores.length
        ? Math.round(Math.max(0, Math.min(1, Math.max(...scores))) * 100)
        : null
      const reason = conflict
        ? '声明与关联材料存在冲突，请人工处理。'
        : invalidLaw
          ? '引用法条存在效力或内容风险，请复核。'
          : missingSource
            ? '关联材料已不存在，请重新关联。'
            : sources.length
              ? matchingLinks[0]?.reason ||
                matchingReferences[0]?.reason ||
                (paragraph.verified
                  ? '律师已确认本段核验。'
                  : '已找到关联出处，待律师复核。')
              : '未找到关联出处，请补充材料或重新关联。'
      return {
        id: `${certificateId}:${paragraph.id}:${sentenceIndex ?? 'paragraph'}`,
        paragraphId: paragraph.id,
        certificateId,
        sentenceIndex,
        quote,
        start,
        end,
        src: sources[0]?.st ?? 'l0',
        type: sources.some((source) => source.st === 'l2')
          ? 'E-LAW'
          : sources.some((source) => source.st === 'l3')
            ? 'E-CASE'
            : '事实声明',
        verdict,
        conf,
        reason,
        sources,
        note: paragraph.note ?? '',
        verified: paragraph.verified,
        original: paragraph,
      }
    })
}

// 与服务端 linkage-policy.getLinkageSentences 保持同一断句规则。
export function statementRanges(text: string) {
  return Array.from(text.matchAll(/[^。！？!?；;\n]+[。！？!?；;]?/gu))
    .filter((match) => match[0].trim())
    .map((match, sentenceIndex) => {
      const leading = match[0].length - match[0].trimStart().length
      const start = match.index! + leading
      return {
        start,
        end: start + match[0].trim().length,
        text: match[0].trim(),
        sentenceIndex,
      }
    })
}

export function buildProjects(workspace: AppState) {
  return workspace.cases.map((item) => {
    const certificates = workspace.certificates.filter(
      (certificate) => certificate.caseId === item.id,
    )
    return {
      id: item.id,
      name: item.name,
      court: item.description || '未填写案件说明',
      date: item.createdAt?.slice(0, 10) ?? '',
      mats: workspace.evidences
        .filter((evidence) => evidence.caseId === item.id)
        .map((evidence) => ({
          id: evidence.id,
          n: evidence.name,
          sub: evidence.fileName,
          parsingStatus: evidence.parsing?.status,
          t: 'material',
          g:
            evidence.relativePath?.split('/').slice(0, -1).join('/') ||
            '案件原材料',
        })),
      docs: certificates.map((certificate) => certificate.id),
      docNames: Object.fromEntries(
        certificates.map((certificate) => [certificate.id, certificate.title]),
      ),
      els: Object.fromEntries(
        certificates.map((certificate) => [
          certificate.id,
          certificate.paragraphs.flatMap((paragraph) =>
            paragraphElements(paragraph, workspace, certificate.id),
          ),
        ]),
      ),
    }
  })
}

export function counts(elements: ReviewElement[]) {
  return {
    all: elements.length,
    pass: elements.filter(
      (element) => element.verdict === 'pass' || element.verdict === 'note',
    ).length,
    warn: elements.filter((element) => element.verdict === 'warn').length,
    fail: elements.filter(
      (element) => element.verdict === 'fail' || element.verdict === 'miss',
    ).length,
  }
}

export function matchesFilter(verdict: Verdict, filter: string) {
  if (filter === 'all') return true
  if (filter === 'fail') return verdict === 'fail' || verdict === 'miss'
  if (filter === 'pass') return verdict === 'pass' || verdict === 'note'
  return verdict === filter
}
