import type { AppState, CertificateParagraph } from '../types'
import type { CaseVerification, Declaration } from '../../../server/src/intelligence/verification/protocol'
import { mayConfirmDeclaration, reviewedVerdict } from '../../../server/src/intelligence/verification/review-status.ts'
import profile from '../../../server/src/intelligence/verification/doc-element-profile.json' with { type: 'json' }

export const DOCUMENT_TYPES = [
  '起诉状',
  '答辩状',
  '证据清单',
  '质证意见',
  '代理词',
  '上诉状',
]
export const STATUS_NAMES = {
  pass: '绿·存在支持',
  warn: '黄·待核对',
  fail: '红·不通过',
  miss: '红·缺源',
  note: '绿·已标注',
  pending: '待核验',
}
export type Verdict = keyof typeof STATUS_NAMES
export type Source = {
  st: 'l1' | 'l2' | 'l3'
  targetId: string
  name: string
  loc: string
  quote: string
  url?: string
  caseDetails?: NonNullable<CertificateParagraph['references']>[number]['caseDetails']
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
  caseVerification?: CaseVerification
  declaration?: Declaration
  verificationRevision?: string | null
  domainReviewable?: boolean
  ignored?: boolean
  original: CertificateParagraph
}

export function needsVerification(workspace: AppState, certificateId: string) {
  const certificate = workspace.certificates.find(item => item.id === certificateId)
  return !certificate?.linkageInputKey || Boolean(certificate.linkageStale)
    || Boolean(certificate.verification && (certificate.verification.inputKey !== certificate.linkageInputKey || certificate.verification.dirty))
}

function indexDocumentReview(workspace: AppState, certificateId: string) {
  const certificate = workspace.certificates.find(item => item.id === certificateId)
  const pendingVerification = needsVerification(workspace, certificateId)
  const materials = new Map(workspace.evidences.filter(item => item.caseId === certificate?.caseId).map(item => [item.id, item]))
  const verification = certificate?.verification
  const current = verification && (!pendingVerification || verification.dirty) && verification.inputKey === certificate?.linkageInputKey
    ? verification : undefined
  const claims = (workspace.claimUnits ?? []).filter(item => item.certificateId === certificateId)
  const claimIds = new Set(claims.map(item => item.id))
  return {
    pendingVerification, materials, verification: current,
    dirty: new Set(current?.dirty?.declarationIds), dirtyParagraphs: new Set(current?.dirty?.paragraphIds),
    declarationsByParagraph: groupBy(current?.declarations ?? [], item => item.location.paragraphId),
    claimsByParagraph: groupBy(claims, item => item.paragraphId),
    matchesByClaim: groupBy(claimIds.size ? (workspace.claimEvidenceMatches ?? []).filter(item => claimIds.has(item.claimUnitId)) : [], item => item.claimUnitId),
  }
}

export function createParagraphReviewer(workspace: AppState, certificateId: string) {
  const context = indexDocumentReview(workspace, certificateId)
  return (paragraph: CertificateParagraph) => reviewParagraph(paragraph, certificateId, context)
}

export function paragraphElements(paragraph: CertificateParagraph, workspace: AppState, certificateId: string): ReviewElement[] {
  return paragraph.text.trim() ? createParagraphReviewer(workspace, certificateId)(paragraph) : []
}

// 兼容早期只有 paragraph.link 的文书，证据匹配分不作为声明核验置信度。
function reviewParagraph(paragraph: CertificateParagraph, certificateId: string, context: ReturnType<typeof indexDocumentReview>): ReviewElement[] {
  if (!paragraph.text.trim()) return []
  const { pendingVerification, materials, verification, dirty, dirtyParagraphs,
    declarationsByParagraph, claimsByParagraph, matchesByClaim } = context
  if (verification) {
    const saved = declarationsByParagraph.get(paragraph.id) ?? []
    const declarations = saved.filter(item => !dirty.has(item.id) || paragraph.text.slice(item.location.start, item.location.end) === item.quote)
    if (declarations.length) {
      const rows: ReviewElement[] = declarations.map(item => {
      const { start, end, sentenceIndex } = item.location
      const sources: Source[] = item.sources.filter(source => {
        if (source.tier !== 'l1') return true
        const material = materials.get(source.id)
        return material && source.version === (material.contentHash ?? material.sourceFingerprint) && (!material.parsing || material.parsing.status === 'ready')
      }).map(source => ({
        st: source.tier, targetId: source.id, name: source.name, loc: source.locator ?? '', quote: source.quote ?? '', url: source.url,
      }))
      const stale = paragraph.text.slice(start, end) !== item.quote || sources.length !== item.sources.length
      const invalidated = dirty.has(item.id)
      const isManual = (id: string | undefined) => !!id && verification.manualReferences?.[id] === item.id
      const manual: Source[] = [
        ...(paragraph.links ?? []).flatMap(link => {
          const material = materials.get(link.evidenceId)
          return material && isManual(link.id) ? [{ st: 'l1' as const, targetId: material.id, name: material.name,
            loc: link.locator, quote: link.quote, reason: '人工挂靠出处' }] : []
        }),
        ...(paragraph.references ?? []).flatMap(reference => isManual(reference.id) ? [{ st: reference.type === 'statute' ? 'l2' as const : 'l3' as const,
          targetId: reference.targetId, name: reference.sourceTitle, loc: reference.locator, quote: reference.quote, url: reference.sourceUrl,
          caseDetails: reference.caseDetails, reason: reference.reason ?? '人工挂靠出处' }] : []),
      ]
      const visibleSources = stale ? [] : [...manual, ...(invalidated ? [] : sources.filter(source =>
        !manual.some(other => other.st === source.st && other.targetId === source.targetId && other.loc === source.loc && other.quote === source.quote)))]
      const canConfirm = paragraph.verified && !verification.revision && !item.review && item.type !== 'E-LAW' && item.type !== 'E-CASE' && sources.length > 0
        && item.verdict === 'pending' && !Object.values(item.checks).some(check => ['pending', 'miss', 'fail'].includes(check.outcome))
      const verdict = stale || invalidated && !['fail', 'miss'].includes(item.verdict) ? 'pending'
        : canConfirm ? item.checks.A3?.outcome === 'warn' ? 'warn' : paragraph.note?.trim() ? 'note' : 'pass' : reviewedVerdict(item)
      const conf = !stale && !invalidated && item.review?.decision !== 'rejected' && item.confidenceCalibration
        && typeof item.conf === 'number' && item.conf >= 0 && item.conf <= 100 ? item.conf : null
      return { id: item.id, paragraphId: paragraph.id, certificateId, start, end, sentenceIndex, quote: item.quote, src: visibleSources[0]?.st ?? 'l0',
        type: item.type, verdict, conf, reason: stale || invalidated ? '原文、来源或上游声明已变化，请重新核验。'
          : item.review?.decision === 'rejected' && verdict === 'pending' ? '律师已驳回，待重新核验。' : item.reason,
        sources: visibleSources, ...(item.caseVerification && !stale && !invalidated && { caseVerification: item.caseVerification }),
        ...(stale ? {} : { declaration: item, verificationRevision: verification.revision ?? null }),
        domainReviewable: !stale && !invalidated && mayConfirmDeclaration(item), ignored: !invalidated && verdict === 'warn' && item.review?.ignored,
        note: !stale && !invalidated ? item.review?.note ?? (!verification.revision ? paragraph.note ?? '' : '') : '',
        verified: !stale && !invalidated && (item.review?.decision === 'confirmed' || !verification.revision && paragraph.verified && !item.review?.decision)
          && ['pass', 'note', 'warn'].includes(verdict), original: paragraph }
      })
      const dropped = saved.length > declarations.length
      const uncovered = dirtyParagraphs.has(paragraph.id) && statementRanges(paragraph.text).some(range =>
        !declarations.some(item => item.location.start >= range.start && item.location.end <= range.end))
      if ((dropped || uncovered) && !rows.some(item => item.verdict === 'pending')) rows.push({
        id: `${certificateId}:${paragraph.id}:dirty`, paragraphId: paragraph.id, certificateId, start: 0, end: paragraph.text.length,
        quote: paragraph.text, src: 'l0', type: '待重核正文', verdict: 'pending', conf: null, reason: '本段新增或修改的内容待重新核验。',
        sources: [], note: '', verified: false, original: paragraph,
      })
      return rows
    }
  }
  const links = paragraph.links?.length
    ? paragraph.links
    : paragraph.link
      ? [paragraph.link]
      : []
  const references = paragraph.references ?? []
  const claimsInParagraph = (claimsByParagraph.get(paragraph.id) ?? []).filter(
    (claim) => !claim.sourceParagraphText || claim.sourceParagraphText === paragraph.text,
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
        ...matchingLinks.filter(link => materials.has(link.evidenceId)).map((link) => ({
          st: 'l1' as const,
          targetId: link.evidenceId,
          name:
            materials.get(link.evidenceId)?.name ?? '',
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
          url: reference.sourceUrl,
          caseDetails: reference.caseDetails,
        })),
      ]
      const claims = claimsInParagraph.filter(
        (claim) => sentenceIndex === undefined || claim.sentenceIndex === sentenceIndex,
      )
      const matches = claims.flatMap(claim => matchesByClaim.get(claim.id) ?? []).filter((match) =>
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
          !materials.has(link.evidenceId),
      )
      let verdict: Verdict = sources.length ? 'warn' : 'miss'
      const supported = matchingLinks.some(link => link.relation === 'support' && link.reason !== '人工维护引用关系，请重新审阅。') ||
        matches.some(match => match.relation === 'support')
      if (supported) verdict = paragraph.verified ? paragraph.note?.trim() ? 'note' : 'pass' : 'pending'
      if (conflict || invalidLaw || missingSource) verdict = 'fail'
      if (pendingVerification && verdict !== 'fail') verdict = 'pending'
      const reason = verdict === 'pending'
        ? pendingVerification ? '当前正文或材料未完成核验，请先运行 AI 核验。' : '已找到支持材料，待人工核验。'
        : conflict
        ? '声明与关联材料存在冲突，请人工处理。'
        : invalidLaw
          ? '引用法条存在效力或内容风险，请复核。'
          : missingSource
            ? '关联材料已不存在，请重新关联。'
            : sources.length
              ? matchingLinks[0]?.reason ||
                matchingReferences[0]?.reason ||
                (supported ? '关联材料存在支持关系，请律师核对。' : '已找到关联出处，支持程度待律师核对。')
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
        conf: null,
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

const verdictOrder: Record<Verdict, number> = { fail: 0, miss: 1, pending: 2, warn: 3, note: 4, pass: 5 }

function groupBy<T>(items: T[], keyOf: (item: T) => string) {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const key = keyOf(item)
    const group = groups.get(key)
    if (group) group.push(item)
    else groups.set(key, [item])
  }
  return groups
}

export function buildProjects(workspace: AppState) {
  if (!workspace.cases.length) return []
  // 首页逐段生成待办时，只读当前案件的材料和当前文书的主张及匹配记录。
  const documentsByCase = groupBy(workspace.certificates, item => item.caseId)
  const evidencesByCase = groupBy(workspace.evidences, item => item.caseId)
  const claimsByDocument = groupBy(workspace.claimUnits ?? [], item => item.certificateId)
  const matchesByClaim = groupBy(workspace.claimEvidenceMatches ?? [], item => item.claimUnitId)
  return workspace.cases.map((item) => {
    const certificates = documentsByCase.get(item.id) ?? []
    const evidences = evidencesByCase.get(item.id) ?? []
    return {
      id: item.id,
      name: item.name,
      court: item.description || '未填写案件说明',
      date: item.createdAt?.slice(0, 10) ?? '',
      mats: evidences.map((evidence) => ({
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
        certificates.map((certificate) => {
          const alias = certificate.docKey as keyof typeof profile.docKeyAlias | undefined
          const docKey = alias ? profile.docKeyAlias[alias] as keyof typeof profile.profiles : undefined
          const identities = new Set<string>(docKey ? profile.profiles[docKey]?.identityElements : [])
          const claimUnits = claimsByDocument.get(certificate.id) ?? []
          const claimIds = new Set(claimUnits.map(claim => claim.id))
          const documentWorkspace = {
            ...workspace, certificates: [certificate], evidences, claimUnits,
            claimEvidenceMatches: [...claimIds].flatMap(id => matchesByClaim.get(id) ?? []),
          }
          const elements = certificate.paragraphs.flatMap(createParagraphReviewer(documentWorkspace, certificate.id))
          elements.sort((left, right) => verdictOrder[left.verdict] - verdictOrder[right.verdict]
            || Number(!identities.has(left.type)) - Number(!identities.has(right.type)))
          return [certificate.id, elements]
        }),
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
    pending: elements.filter((element) => element.verdict === 'pending').length,
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
