import { isDeepStrictEqual } from 'node:util'
import { AppError } from '../core/app-error.js'
import type { Certificate, CertificateParagraph, WorkspaceState } from '../domain.js'
import { createWorkspaceCaseAdapter } from '../integrations/workspace-case.js'
import { normalizeCaseNumber } from '../intelligence/legal-verification.js'
import { getLinkageSentences } from '../intelligence/linkage-policy.js'
import { verifyCaseDeclarations } from '../intelligence/verification/case.js'
import { applyDeclarationDependencies } from '../intelligence/verification/dependencies.js'
import { verifyEvidence } from '../intelligence/verification/evidence.js'
import { extractDeclarations } from '../intelligence/verification/extract.js'
import { normalizeDocKey, profile } from '../intelligence/verification/profile.js'
import { invalidateVerification } from '../intelligence/verification/review-state.js'
import type { CheckCode, Declaration, DeclarationLocation, VerificationResult } from '../intelligence/verification/protocol.js'
import { verifyLegalDeclarations } from '../intelligence/verification/legal.js'

type RecheckWorkspace = Pick<WorkspaceState, 'evidences' | 'evidenceFragments' | 'evidenceInsights' | 'knowledgeStatutes' | 'knowledgeCases'>
type RecheckOptions = {
  signal?: AbortSignal
  statuteAdapter?: Parameters<typeof verifyLegalDeclarations>[3]
  officialStatuteAdapter?: Parameters<typeof verifyLegalDeclarations>[5]
  caseAdapter?: Parameters<typeof verifyCaseDeclarations>[2]
}

export type AssistantPendingVerification = {
  verification: VerificationResult; dirtyIds: string[]; hasCurrentBaseline: boolean; editedParagraphIds?: string[]
}

const rewriteReason = '助手修改了原文，待局部重核。'
const dependencyReason = '关联声明已变化，待局部重核。'
const failedDetails = new Set(['timeout', 'forbidden', 'unavailable', 'empty-response'])
const anchorKey = (type: Declaration['type'], location: DeclarationLocation) => JSON.stringify([type, location.paragraphId, location.start, location.end])
const sourceLinks = (paragraph: CertificateParagraph) => paragraph.links?.length ? paragraph.links : paragraph.link ? [paragraph.link] : []

export function resumeAssistantVerification(certificate: Certificate, inputKey: string): AssistantPendingVerification {
  const verification = certificate.verification
  if (!verification || verification.inputKey !== inputKey || verification.profileVersion !== profile.version) {
    throw new AppError('材料或核验版本已更新，请重新核验整份文书。', 409, 'ASSISTANT_RECHECK_TARGET_CHANGED')
  }
  const hasReason = (item: Declaration, reason: string) => item.reason === reason || Object.values(item.checks).some(check => check.reason === reason)
  return { verification, hasCurrentBaseline: !certificate.linkageStale,
    dirtyIds: verification.declarations.filter(item => hasReason(item, rewriteReason) || hasReason(item, dependencyReason)).map(item => item.id),
    editedParagraphIds: verification.declarations.filter(item => hasReason(item, rewriteReason)).map(item => item.location.paragraphId) }
}

function sentenceSpans(paragraph: CertificateParagraph) {
  let cursor = 0
  return getLinkageSentences(paragraph.text).flatMap(sentence => {
    const start = paragraph.text.indexOf(sentence.sentenceText, cursor)
    if (start < 0) return []
    cursor = start + sentence.sentenceText.length
    return [{ ...sentence, start, end: cursor }]
  })
}

function sourcesForSentence(paragraph: CertificateParagraph, index: number, text: string) {
  const scoped = <T extends { sentenceIndex?: number; sentenceText?: string }>(sources: T[]) => sources.flatMap(source => {
    const { sentenceIndex, sentenceText } = source
    if (sentenceIndex !== undefined ? sentenceIndex !== index : sentenceText && sentenceText !== text) return []
    return [{ ...source, sentenceIndex: undefined, sentenceText: undefined }]
  })
  return [scoped(sourceLinks(paragraph)), scoped(paragraph.references ?? [])]
}

function reanchor(item: Declaration, before: CertificateParagraph, after: CertificateParagraph, paragraphIndex: number): DeclarationLocation | undefined {
  const { start, end } = item.location
  if (before.text.slice(start, end) !== item.quote || before.note !== after.note) return undefined
  if (before === after) return { ...item.location, paragraphIndex }
  if (before.text === after.text && isDeepStrictEqual(sourceLinks(before), sourceLinks(after))
    && isDeepStrictEqual(before.references, after.references) && isDeepStrictEqual(before.evidenceCell, after.evidenceCell)) {
    return { ...item.location, paragraphIndex }
  }
  // 法条时点、案例上下文和表格定位可能依赖同段其他内容。
  if (item.type === 'E-LAW' || item.type === 'E-CASE' || item.location.row !== undefined) return undefined
  const oldSentences = sentenceSpans(before)
  const original = oldSentences.find(sentence => start >= sentence.start && end <= sentence.end)
  if (!original || oldSentences.filter(sentence => sentence.sentenceText === original.sentenceText).length !== 1) return undefined
  const matches = sentenceSpans(after).filter(sentence => sentence.sentenceText === original.sentenceText)
  if (matches.length !== 1) return undefined
  const [current] = matches
  if (!isDeepStrictEqual(sourcesForSentence(before, original.sentenceIndex, original.sentenceText),
    sourcesForSentence(after, current.sentenceIndex, current.sentenceText))) return undefined
  const delta = current.start - original.start
  return { ...item.location, paragraphIndex, sentenceIndex: current.sentenceIndex, start: start + delta, end: end + delta }
}

function markDependency(item: Declaration, checksToReopen: Set<CheckCode>): Declaration {
  const checks = { ...item.checks }
  for (const code of checksToReopen) checks[code] = { outcome: 'pending', reason: dependencyReason }
  const blocking = (['fail', 'miss'] as const).flatMap(verdict => Object.values(checks).filter(check => check.outcome === verdict))[0]
  const verdict = blocking?.outcome === 'fail' || blocking?.outcome === 'miss' ? blocking.outcome : 'pending'
  const state = item.caseVerification
  return { ...item, checks, verdict, reason: blocking?.reason ?? dependencyReason, verifiedText: undefined, verifiedSources: undefined,
    ...(state && { caseVerification: { ...state, allowCitation: false, counted: false,
      match: state.match === 'strict' && (checksToReopen.has('C4') || checksToReopen.has('C6')) ? 'analogous' : state.match } }),
  }
}

export function markAssistantVerificationPending(certificate: Certificate, paragraphId: string, inputKey: string, previous?: Certificate): AssistantPendingVerification {
  const baseline = previous ?? certificate
  const baselineVerification = baseline.verification
  const sameDocument = baseline.id === certificate.id && baseline.caseId === certificate.caseId
  const docKey = normalizeDocKey(certificate.docKey)
  const hasCurrentBaseline = sameDocument && !!baselineVerification && baselineVerification.version === 1
    && baselineVerification.profileVersion === profile.version && baselineVerification.docKey === docKey
    && baselineVerification.inputKey === inputKey && baseline.linkageInputKey === inputKey && !baseline.linkageStale
  const target = certificate.paragraphs.find(item => item.id === paragraphId)
  if (!target) throw new AppError('找不到要重核的文书段落。', 409, 'ASSISTANT_RECHECK_TARGET_CHANGED')

  const current = new Map(certificate.paragraphs.map((paragraph, index) => [paragraph.id, { paragraph, index }]))
  const prior = new Map(baseline.paragraphs.map(paragraph => [paragraph.id, paragraph]))
  const previousDeclarations = sameDocument ? baselineVerification?.declarations ?? [] : []
  const retained = new Map<string, Declaration>()
  for (const item of previousDeclarations) {
    const id = item.location.paragraphId
    if ((!previous || !sameDocument) && id === paragraphId) continue
    const before = prior.get(id)
    const after = current.get(id)
    const location = before && after && reanchor(item, before, after.paragraph, after.index)
    if (!location) continue
    retained.set(anchorKey(item.type, location), { ...item, location })
  }
  const model = [...retained.values()].map(item => ({ type: item.type, paragraphId: item.location.paragraphId,
    quote: item.quote, start: item.location.start, factKinds: item.factKinds }))
  const extracted = extractDeclarations(certificate, model)
  const dirty = new Set<string>()
  const oldToNew = new Map<string, string>()
  const merged = extracted.declarations.map(item => {
    const old = retained.get(anchorKey(item.type, item.location))
    if (hasCurrentBaseline && old?.quote === item.quote) {
      oldToNew.set(old.id, item.id)
      return { ...old, id: item.id }
    }
    const targeted = item.location.paragraphId === paragraphId
    if (targeted || hasCurrentBaseline) dirty.add(item.id)
    if (!targeted) return item
    return { ...item, reason: rewriteReason, checks: Object.fromEntries(Object.keys(item.checks).map(code => [code, { outcome: 'pending', reason: rewriteReason }])) }
  })
  const resolved = new Map(merged.map(item => [item.id, item]))
  if (hasCurrentBaseline) {
    const staleSource = (id: string) => !oldToNew.has(id) || dirty.has(oldToNew.get(id)!)
    const caseGroups = new Map(previousDeclarations.flatMap(item => item.type === 'E-CASE' && item.caseVerification?.groupId
      ? [[normalizeCaseNumber(item.quote), item.caseVerification.groupId] as const] : []))
    const groupOf = (item: Declaration) => item.type === 'E-CASE' ? caseGroups.get(normalizeCaseNumber(item.quote)) : undefined
    const impacted = new Set<string>()
    const impactedGroups = new Set<string>()
    for (let grew = true; grew;) {
      grew = false
      for (const item of merged) {
        const group = groupOf(item)
        if (group && dirty.has(item.id)) impactedGroups.add(group)
      }
      for (const item of merged) {
        if (dirty.has(item.id)) continue
        const group = groupOf(item)
        if (!(group && impactedGroups.has(group)) && !item.dependencies?.some(edge => staleSource(edge.id))) continue
        dirty.add(item.id)
        impacted.add(item.id)
        grew = true
      }
    }
    for (const item of merged) {
      if (!item.dependencies?.length && !impacted.has(item.id)) continue
      const checks = new Set(item.dependencies?.filter(edge => staleSource(edge.id)).map(edge => edge.check))
      const group = groupOf(item)
      if (group && impactedGroups.has(group)) {
        checks.add('C6')
        checks.add('C7')
      }
      const updated = impacted.has(item.id) ? markDependency(item, checks) : item
      const dependencies = item.dependencies?.flatMap(edge => {
        const id = oldToNew.get(edge.id) ?? (resolved.has(edge.id) ? edge.id : undefined)
        return id ? [{ ...edge, id }] : []
      })
      resolved.set(item.id, { ...updated, dependencies })
    }
  }
  const declarations = merged.map(item => resolved.get(item.id)!)
  const review = sameDocument && previous ? invalidateVerification(previous, certificate) : baselineVerification
  const dirtyState = { paragraphIds: [...new Set([...(review?.dirty?.paragraphIds ?? []), paragraphId])],
    declarationIds: [...new Set([...(review?.dirty?.declarationIds ?? []).filter(id => resolved.has(id)), ...dirty])] }
  return { hasCurrentBaseline, dirtyIds: [...dirty], editedParagraphIds: [paragraphId], verification: {
    ...review, dirty: dirtyState,
    version: 1, profileVersion: profile.version, inputKey, docKey: extracted.docKey,
    classificationRequired: extracted.classificationRequired, declarations,
  } }
}

export async function recheckAssistantDeclarations(certificate: Certificate, marked: AssistantPendingVerification, workspace: RecheckWorkspace,
  { signal, statuteAdapter, officialStatuteAdapter, caseAdapter }: RecheckOptions = {}): Promise<VerificationResult> {
  signal?.throwIfAborted()
  const { verification, dirtyIds } = marked
  if (!dirtyIds.length) return verification
  const dirty = new Set(dirtyIds)
  const doc = { ...certificate, docKey: verification.docKey }
  const evidence = verifyEvidence(doc, verification.declarations, workspace, dirty)
  let declarations = evidence.declarations

  const lawParagraphs = new Set(declarations.filter(item => dirty.has(item.id) && item.type === 'E-LAW').map(item => item.location.paragraphId))
  const lawContext = declarations.filter(item => item.type !== 'E-CASE'
    && (item.type !== 'E-LAW' || dirty.has(item.id) || !lawParagraphs.has(item.location.paragraphId)))
  const laws = await verifyLegalDeclarations({ docKey: doc.docKey, paragraphs: doc.paragraphs.filter(item => lawParagraphs.has(item.id)) },
    lawContext, workspace, statuteAdapter, signal, officialStatuteAdapter)
  const byLaw = new Map(laws.map(item => [item.id, item]))
  declarations = declarations.map(item => dirty.has(item.id) ? byLaw.get(item.id) ?? item : item)

  if (declarations.some(item => dirty.has(item.id) && item.type === 'E-CASE')) {
    const retainedCaseParagraphs = new Set(declarations.filter(item => item.type === 'E-CASE' && !dirty.has(item.id)).map(item => item.location.paragraphId))
    const caseContext = declarations.filter(item => dirty.has(item.id) || (item.type !== 'E-CASE' && !retainedCaseParagraphs.has(item.location.paragraphId)))
    const cases = await verifyCaseDeclarations(doc, caseContext, caseAdapter ?? createWorkspaceCaseAdapter(workspace.knowledgeCases), signal)
    const byCase = new Map(cases.filter(item => item.type === 'E-CASE').map(item => [item.id, item]))
    declarations = declarations.map(item => dirty.has(item.id) ? byCase.get(item.id) ?? item : item)
  }
  const failed = declarations.some(item => dirty.has(item.id) && ((item.checks.B1?.outcome === 'pending'
    && [item.statuteVerification?.provider?.outcome, item.statuteVerification?.official?.outcome].some(outcome => !!outcome && failedDetails.has(outcome)))
    || (item.caseVerification && failedDetails.has(item.caseVerification.detailOutcome))))
  if (failed) throw new AppError('局部重核暂未取得法源详情，请重试。', 503, 'ASSISTANT_RECHECK_SOURCE_UNAVAILABLE')
  signal?.throwIfAborted()
  const checked = applyDeclarationDependencies(declarations).map((item, index) => dirty.has(item.id) ? item : declarations[index])
  return { ...verification, declarations: checked, documentDiagnostics: evidence.documentDiagnostics.length ? evidence.documentDiagnostics : undefined }
}
