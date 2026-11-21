import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { AppError } from '../../core/app-error.js'
import type { Certificate, CertificateParagraph, WorkspaceState } from '../../domain.js'
import { getLinkageSentences } from '../linkage-policy.js'
import { dependentDeclarationIds } from './dependencies.js'
import { extractDeclarations } from './extract.js'
import { profile } from './profile.js'
import type { CheckCode, Declaration, DeclarationReviewAction, DocKey, VerificationResult } from './protocol.js'
import { mayConfirmDeclaration, reviewedVerdict } from './review-status.js'

export const reviewActionSchema = z.object({
  id: z.string().min(1).max(200), declarationId: z.string().min(1).max(600),
  revision: z.string().max(200).nullable(), reviewRevision: z.string().max(200).nullable(),
  type: z.enum(['confirm', 'reject', 'note', 'ignore', 'restore-warning', 'decline']),
  checks: z.array(z.string().regex(/^(?:A[1-5]|B[1-6]|C[1-7])$/u) as z.ZodType<CheckCode>).max(18).optional(),
  note: z.string().max(20_000).optional(),
})

export const declarationEditSchema = reviewActionSchema.pick({ id: true, declarationId: true, revision: true, reviewRevision: true })
  .extend({ type: z.enum(['adopt', 'delete']) })
export const declarationReferenceSchema = declarationEditSchema.omit({ type: true })
  .extend({ sourceIds: z.array(z.string().uuid()).max(500) })

export function verificationAuthorityKey(workspace: Pick<WorkspaceState, 'knowledgeStatutes' | 'knowledgeCases'>, declarations: Declaration[]) {
  const statutes = declarations.some(item => item.type === 'E-LAW') ? workspace.knowledgeStatutes : []
  const cases = declarations.some(item => item.type === 'E-CASE') ? workspace.knowledgeCases : []
  return createHash('sha256').update(JSON.stringify([statutes, cases])).digest('hex')
}

export function declarationReviewIsCurrent(paragraph: CertificateParagraph, declaration: Declaration) {
  const { paragraphId, start, end } = declaration.location
  return paragraph.id === paragraphId && paragraph.text.slice(start, end) === declaration.quote
}

export function confirmedDeclarationsForFullRecheck(certificate: Certificate, workspace: Pick<WorkspaceState, 'knowledgeCases' | 'knowledgeStatutes'>,
  profileVersion: string, inputKey: string, materialVersion: string) {
  const previous = certificate.verification
  if (!previous || previous.profileVersion !== profileVersion || previous.docKey !== certificate.docKey
    || previous.inputKey !== inputKey || certificate.linkageInputKey !== inputKey
    || previous.materialVersion !== materialVersion || previous.authorityKey !== verificationAuthorityKey(workspace, previous.declarations)
    || (certificate.linkageStale && !previous.dirty)) return new Map<string, Declaration>()

  const paragraphs = new Map(certificate.paragraphs.map((item, index) => [item.id, { item, index }]))
  const dirtyParagraphs = new Set(previous.dirty?.paragraphIds)
  const dirty = new Set(previous.dirty?.declarationIds)
  const known = new Set(previous.declarations.map(item => item.id))
  for (const declaration of previous.declarations) {
    const paragraph = paragraphs.get(declaration.location.paragraphId)
    if (!paragraph || dirtyParagraphs.has(paragraph.item.id) || !declarationReviewIsCurrent(paragraph.item, declaration)
      || declaration.dependencies?.some(edge => !known.has(edge.id))) dirty.add(declaration.id)
  }
  const affected = dependentDeclarationIds(previous.declarations, dirty)
  return new Map(previous.declarations.flatMap(item => {
    if (item.review?.decision !== 'confirmed' || item.verdict === 'pending' || affected.has(item.id) || !mayConfirmDeclaration(item)) return []
    const index = paragraphs.get(item.location.paragraphId)!.index
    return [[item.id, item.location.paragraphIndex === index ? item : { ...item, location: { ...item.location, paragraphIndex: index } }] as const]
  }))
}

export function mergeConfirmedDeclarations(declarations: Declaration[], confirmed: ReadonlyMap<string, Declaration>, docKey?: DocKey) {
  if (!confirmed.size) return declarations
  const indexed = new Map<string, Declaration[]>()
  for (const item of confirmed.values()) {
    const key = `${item.location.paragraphId}:${item.type}`
    indexed.set(key, [...(indexed.get(key) ?? []), item])
  }
  const merged = declarations.filter(item => !indexed.get(`${item.location.paragraphId}:${item.type}`)?.some(known =>
    known.location.start < item.location.end && item.location.start < known.location.end))
  merged.push(...confirmed.values())
  const identity = docKey ? profile.profiles[docKey].identityElements : []
  return merged.sort((left, right) => Number(!identity.includes(left.type)) - Number(!identity.includes(right.type))
    || left.location.paragraphIndex - right.location.paragraphIndex || left.location.start - right.location.start)
}

export function applyReviewAction(result: VerificationResult, declarationId: string, action: DeclarationReviewAction, actor: string) {
  const existing = result.audit?.find(item => item.id === action.id)
  if (existing) {
    if (existing.declarationId === declarationId && existing.actor === actor && existing.action === action.type
      && existing.note === action.note?.trim() && isDeepStrictEqual(existing.checks, action.checks)) return result
    throw new AppError('该操作标识已使用，请刷新后重试。', 409, 'REVIEW_CONFLICT')
  }
  const target = result.declarations.find(item => item.id === declarationId)
  if (!target || action.revision !== (result.revision ?? null) || action.reviewRevision !== (target.review?.revision ?? null)) {
    throw new AppError('声明或人工复核记录已有更新，请重新打开声明后重试。', 409, 'REVIEW_CONFLICT')
  }
  const dirty = new Set(result.dirty?.declarationIds)
  if (dirty.has(declarationId) && action.type !== 'note') {
    throw new AppError('声明或所依依据已变更，请先重新核验。', 409, 'REVIEW_CONFLICT')
  }
  const review = { ...target.review, revision: action.id }
  if (action.type === 'confirm') {
    if (!mayConfirmDeclaration(target)) throw new AppError('当前声明不通过、缺源或缺少可定位的原文，无法确认。', 409, 'REVIEW_BLOCKED')
    if (target.dependencies?.some(edge => {
      if (edge.check === 'B6') return false
      const source = result.declarations.find(item => item.id === edge.id)
      return !source || dirty.has(source.id) || (edge.check === 'C6' ? source.checks.B2?.outcome !== 'pass'
        : ['fail', 'miss', 'pending'].includes(reviewedVerdict(source)))
    })) throw new AppError('依赖声明仍有阻断或待重核，请先处理上游。', 409, 'REVIEW_BLOCKED')
    const required = Object.entries(target.checks).filter(([, value]) => value.outcome !== 'not-applicable').map(([code]) => code as CheckCode)
    if (!required.every(code => action.checks?.includes(code))) throw new AppError('请逐项核对并勾选适用检查项。', 400, 'REVIEW_CHECKS_REQUIRED')
    review.decision = 'confirmed'
  } else if (action.type === 'reject') {
    review.decision = 'rejected'
    review.ignored = false
  } else if (action.type === 'note') {
    review.note = action.note?.trim() ?? ''
  } else if (action.type !== 'decline') {
    if (reviewedVerdict(target) !== 'warn') throw new AppError('当前声明不是有效的黄灯预警。', 409, 'REVIEW_BLOCKED')
    review.ignored = action.type === 'ignore'
  }
  const updated = { ...target, review }
  if (action.type === 'reject' && reviewedVerdict(updated) === 'pending') dirty.add(declarationId)
  if (reviewedVerdict(updated) !== reviewedVerdict(target)) {
    const affected = dependentDeclarationIds(result.declarations, [declarationId])
    affected.delete(declarationId)
    for (const id of affected) dirty.add(id)
  }
  const dirtyState = { paragraphIds: result.dirty?.paragraphIds ?? [], declarationIds: [...dirty] }
  return {
    ...result, dirty: dirty.size || dirtyState.paragraphIds.length ? dirtyState : undefined,
    declarations: result.declarations.map(item => item.id === declarationId ? updated : item),
    audit: [...(result.audit ?? []), { id: action.id, at: new Date().toISOString(), actor, action: action.type,
      paragraphId: target.location.paragraphId, declarationId, quote: target.quote, note: action.note?.trim(), checks: action.checks,
      previousVerdict: reviewedVerdict(target), affected: [...dirty].filter(id => !result.dirty?.declarationIds.includes(id)) }],
  } satisfies VerificationResult
}

function comparableBasis(item: Declaration) {
  const { paragraphId, start, end, row, column } = item.location
  const outcomes = Object.entries(item.checks).map(([code, check]) => [code, check.outcome]).sort()
  return [item.type, item.quote, paragraphId, start, end, row, column, item.sources, item.dependencies,
    item.statuteVerification?.applicability, item.caseVerification?.effect, item.caseVerification?.match, item.verdict, outcomes]
}

export function carryDeclarationReviews(previous: VerificationResult | undefined, next: Declaration[]) {
  if (!previous) return next
  const prior = new Map(previous.declarations.map(item => [item.id, item]))
  const fresh = new Map(next.map(item => [item.id, item]))
  const changed = previous.declarations.filter(item => {
    const latest = fresh.get(item.id)
    return !latest || !isDeepStrictEqual(comparableBasis(item), comparableBasis(latest))
  }).map(item => item.id)
  const invalid = dependentDeclarationIds([...previous.declarations, ...next], [...changed, ...(previous.dirty?.declarationIds ?? [])])
  return next.map(item => {
    const review = prior.get(item.id)?.review
    if (!review || invalid.has(item.id)) return item
    const decision = review.decision === 'confirmed' && !mayConfirmDeclaration(item) ? undefined : review.decision
    return { ...item, review: { ...review, decision, ignored: Boolean(review.ignored && item.verdict === 'warn') } }
  })
}

function relevantSources(paragraph: CertificateParagraph, sentenceIndex?: number, bindings?: Record<string, string>, declarationId?: string) {
  const links = paragraph.links?.length ? paragraph.links : paragraph.link ? [paragraph.link] : []
  return [...links, ...(paragraph.references ?? [])]
    .filter(source => sentenceIndex === undefined || source.sentenceIndex === undefined || source.sentenceIndex === sentenceIndex)
    .filter(source => !declarationId || !source.id || !bindings?.[source.id] || bindings[source.id] === declarationId)
    .map(({ sentenceIndex: _index, sentenceText: _text, ...source }) => source)
}

function reanchor(item: Declaration, before: CertificateParagraph, after: CertificateParagraph, paragraphIndex: number, certificateId: string) {
  const { start, end, sentenceIndex, row, column } = item.location
  if (!declarationReviewIsCurrent(before, item) || ((row !== undefined || column !== undefined) && before.richText !== after.richText)) return undefined
  if (before.text === after.text) return { ...item, location: { ...item.location, paragraphIndex } }
  if (sentenceIndex === undefined) return undefined
  const old = getLinkageSentences(before.text)
  const sentence = old[sentenceIndex]?.sentenceText
  const newSentences = getLinkageSentences(after.text)
  if (!sentence || old.filter(entry => entry.sentenceText === sentence).length !== 1) return undefined
  const matches = newSentences.filter(entry => entry.sentenceText === sentence)
  if (matches.length !== 1) return undefined
  const oldStart = before.text.indexOf(sentence)
  const nextStart = after.text.indexOf(sentence)
  if (oldStart < 0 || nextStart < 0 || start < oldStart || end > oldStart + sentence.length
    || before.text.indexOf(sentence, oldStart + 1) >= 0 || after.text.indexOf(sentence, nextStart + 1) >= 0) return undefined
  const shift = nextStart - oldStart
  return { ...item, id: shift ? `${certificateId}:${after.id}:${start + shift}:${end + shift}:${item.type}` : item.id,
    location: { ...item.location, paragraphIndex, sentenceIndex: matches[0].sentenceIndex, start: start + shift, end: end + shift } }
}

function nearbyUnchangedDeclarations(items: Declaration[], before: string, after: string) {
  let prefix = 0
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++
  let suffix = 0
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - suffix - 1] === after[after.length - suffix - 1]) suffix++
  let cursor = 0
  const spans = getLinkageSentences(after).flatMap(sentence => {
    const start = after.indexOf(sentence.sentenceText, cursor)
    if (start < 0) return []
    cursor = start + sentence.sentenceText.length
    return [{ ...sentence, start, end: cursor }]
  })
  return items.flatMap(item => {
    const { start, end } = item.location
    const shift = end <= prefix ? 0 : start >= before.length - suffix ? after.length - before.length : undefined
    if (shift === undefined || before.slice(start, end) !== item.quote || after.slice(start + shift, end + shift) !== item.quote) return []
    if (before.indexOf(item.quote) !== start || before.indexOf(item.quote, start + 1) !== -1
      || after.indexOf(item.quote) !== start + shift || after.indexOf(item.quote, start + shift + 1) !== -1) return []
    const sentence = spans.find(span => span.start <= start + shift && span.end >= end + shift)
    return sentence ? [{ item, start: start + shift, end: end + shift, sentence }] : []
  })
}

export function preserveScopedReferences(before: Certificate, next: Certificate) {
  const verification = next.verification
  const bindings = { ...verification?.manualReferences }
  if (!verification || !Object.keys(bindings).length) return next
  const paragraphs = new Map(before.paragraphs.map(item => [item.id, item]))
  const updated = next.paragraphs.map(paragraph => {
    const original = paragraphs.get(paragraph.id)
    if (!original || original.text === paragraph.text) return paragraph
    const anchors = new Map(nearbyUnchangedDeclarations(verification.declarations.filter(item => item.location.paragraphId === paragraph.id),
      original.text, paragraph.text).map(item => [item.item.id, item]))
    const retain = <T extends { id?: string; sentenceIndex?: number; sentenceText?: string }>(old: T[], current: T[]) => {
      const retained = [...current]
      for (const source of old) {
        const id = source.id && bindings[source.id]
        const anchor = id && anchors.get(id)
        if (!source.id || !anchor) continue
        const located = { ...source, sentenceIndex: anchor.sentence.sentenceIndex, sentenceText: anchor.sentence.sentenceText }
        const currentIndex = retained.findIndex(item => item.id === source.id)
        if (currentIndex < 0) retained.push(located)
        else retained[currentIndex] = located
        bindings[source.id] = anchor.start === anchor.item.location.start ? anchor.item.id
          : `${next.id}:${paragraph.id}:${anchor.start}:${anchor.end}:${anchor.item.type}`
      }
      return retained
    }
    const links = retain(original.links?.length ? original.links : original.link ? [original.link] : [],
      paragraph.links?.length ? paragraph.links : paragraph.link ? [paragraph.link] : [])
    const references = retain(original.references ?? [], paragraph.references ?? [])
    return { ...paragraph, links, link: links[0], references }
  })
  return { ...next, paragraphs: updated, verification: { ...verification, manualReferences: bindings } }
}

export function invalidateVerification(before: Certificate, after: Certificate, actor?: string) {
  const result = before.verification
  if (!result) return undefined
  const oldParagraphs = new Map(before.paragraphs.map(item => [item.id, item]))
  const nextParagraphs = new Map(after.paragraphs.map((item, index) => [item.id, { item, index }]))
  const byParagraph = new Map<string, Declaration[]>()
  for (const item of result.declarations) {
    const key = item.location.paragraphId
    const items = byParagraph.get(key) ?? []
    items.push(item)
    byParagraph.set(key, items)
  }
  const matched = new Map<string, ReturnType<typeof nearbyUnchangedDeclarations>[number]>()
  const paragraphIds = new Set(result.dirty?.paragraphIds)
  for (const { item, index } of nextParagraphs.values()) {
    const old = oldParagraphs.get(item.id)
    if (!old || old.text !== item.text || before.paragraphs[index]?.id !== item.id || !isDeepStrictEqual(relevantSources(old), relevantSources(item))) paragraphIds.add(item.id)
    if (old && old.text !== item.text) for (const anchor of nearbyUnchangedDeclarations(byParagraph.get(item.id) ?? [], old.text, item.text)) matched.set(anchor.item.id, anchor)
  }
  const idMap = new Map<string, string>()
  const bindings = after.verification?.manualReferences ?? result.manualReferences
  const changed = new Set(result.dirty?.declarationIds)
  const declarations = result.declarations.map(item => {
    const old = oldParagraphs.get(item.location.paragraphId)
    const entry = nextParagraphs.get(item.location.paragraphId)
    if (!old || !entry) { changed.add(item.id); return item }
    let anchored = reanchor(item, old, entry.item, entry.index, before.id)
    if (!anchored) {
      changed.add(item.id)
      const match = matched.get(item.id)
      if (!match) return item
      const { start, end, sentence } = match
      const id = item.location.start === start ? item.id : `${before.id}:${entry.item.id}:${start}:${end}:${item.type}`
      anchored = { ...item, id, location: { ...item.location, start, end, paragraphIndex: entry.index, sentenceIndex: sentence.sentenceIndex } }
    }
    idMap.set(item.id, anchored.id)
    if ((old.text !== entry.item.text && (item.type === 'E-LAW' || item.type === 'E-CASE'))
      || !isDeepStrictEqual(relevantSources(old, item.location.sentenceIndex, result.manualReferences, item.id),
      relevantSources(entry.item, anchored.location.sentenceIndex, bindings, item.id))) changed.add(item.id)
    return anchored
  })
  reopenAuthorityContext(result.declarations, result.declarations.filter(item => changed.has(item.id)), changed)
  const affected = dependentDeclarationIds(result.declarations, changed)
  const declarationIds = [...affected].map(id => idMap.get(id) ?? id)
  const newlyAffected = result.declarations.filter(item => affected.has(item.id) && !result.dirty?.declarationIds.includes(item.id))
  if (!paragraphIds.size && !affected.size) return result
  const at = new Date().toISOString()
  const audit = actor ? [...(result.audit ?? []), ...newlyAffected.map(item => ({ id: randomUUID(), at, actor,
    action: 'edit' as const, paragraphId: item.location.paragraphId, declarationId: item.id, quote: item.quote,
    note: item.review?.note, previousVerdict: reviewedVerdict(item), sources: item.sources, affected: declarationIds }))] : result.audit
  const manualReferences = Object.fromEntries(Object.entries(bindings ?? {}).map(([source, declaration]) => [source, idMap.get(declaration) ?? declaration]))
  return { ...result, revision: randomUUID(), audit, manualReferences,
    dirty: { paragraphIds: [...paragraphIds], declarationIds },
    declarations: declarations.map(item => ({ ...item, dependencies: item.dependencies?.map(edge => ({ ...edge, id: idMap.get(edge.id) ?? edge.id })) })),
  } satisfies VerificationResult
}

export function reopenAuthorityContext(declarations: Declaration[], changed: Declaration[], dirty: Set<string>) {
  const legalBasisChanged = changed.some(item => ['E-FACT', 'E-LAW', 'E-CLAIM'].includes(item.type))
  const caseContextChanged = changed.filter(item => ['E-FACT', 'E-LAW', 'E-CLAIM', 'E-FOCUS', 'E-PROC'].includes(item.type))
  for (const item of declarations) {
    if (legalBasisChanged && (item.type === 'E-LAW' || item.type === 'E-CLAIM')) dirty.add(item.id)
    if (item.type === 'E-CASE' && caseContextChanged.some(source => source.location.paragraphIndex <= item.location.paragraphIndex)) dirty.add(item.id)
  }
}

export function prepareDirtyVerification(certificate: Certificate, verification: VerificationResult) {
  const dirty = new Set(verification.dirty?.declarationIds)
  const paragraphs = new Map(certificate.paragraphs.map(item => [item.id, item]))
  const anchored = verification.declarations.filter(item => {
    const paragraph = paragraphs.get(item.location.paragraphId)
    return paragraph && declarationReviewIsCurrent(paragraph, item)
  })
  const retained = new Map(anchored.map(item => [item.id, item]))
  const draft = extractDeclarations(certificate, anchored.map(item => ({
    paragraphId: item.location.paragraphId, quote: item.quote, start: item.location.start, type: item.type, factKinds: item.factKinds,
  })))
  reopenAuthorityContext(draft.declarations, draft.declarations.filter(item => !retained.has(item.id)), dirty)
  const affected = dependentDeclarationIds(verification.declarations, dirty)
  const declarations = draft.declarations.map(item => {
    const existing = retained.get(item.id)
    if (existing && !affected.has(item.id)) return existing
    affected.add(item.id)
    return item
  })
  const extractedIds = new Set(declarations.map(item => item.id))
  if (anchored.some(item => !extractedIds.has(item.id))) {
    throw new AppError('局部重核无法保留既有声明定位，请核验整份文书。', 409, 'LOCAL_RECHECK_UNAVAILABLE')
  }
  return { hasCurrentBaseline: true, dirtyIds: declarations.filter(item => affected.has(item.id)).map(item => item.id),
    verification: { ...verification, declarations, docKey: draft.docKey, classificationRequired: draft.classificationRequired } }
}
