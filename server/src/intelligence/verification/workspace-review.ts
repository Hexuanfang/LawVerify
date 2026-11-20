import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { recheckAssistantDeclarations } from '../../assistant/recheck.js'
import { env } from '../../config/env.js'
import { AppError } from '../../core/app-error.js'
import type { Certificate, CertificateParagraph, WorkspaceState } from '../../domain.js'
import { runExclusiveWorkspaceMutation } from '../../infrastructure/workspace-lock.js'
import { createVerificationSources } from '../../integrations/verification-sources.js'
import { getCurrentWorkspaceAccount, readWorkspace, writeWorkspace } from '../../store.js'
import { linkageMaterialFingerprint } from '../case-agent.js'
import { applyConfidenceCalibration, readConfidenceCalibration } from './confidence.js'
import { normalizeDocKey, profile } from './profile.js'
import type { DeclarationEditAction, DeclarationReferenceEdit, DeclarationSource, VerificationAudit, VerificationResult } from './protocol.js'
import { applyReviewAction, declarationReviewIsCurrent, prepareDirtyVerification, reviewActionSchema, verificationAuthorityKey } from './review-state.js'
import { declarationEditRange, reviewedVerdict } from './review-status.js'

export function documentMaterialKey(workspace: WorkspaceState, caseId: string) {
  return linkageMaterialFingerprint(workspace.evidences.filter(item => item.caseId === caseId),
    workspace.evidenceInsights.filter(item => item.caseId === caseId))
}

export function verificationMaterialVersion(workspace: WorkspaceState, caseId: string) {
  const hash = createHash('sha256')
  const materials = workspace.evidences.filter(item => item.caseId === caseId)
  const ids = new Set(materials.map(item => item.id))
  for (const item of materials) hash.update(JSON.stringify([item.id, item.type, item.name, item.fileName, item.contentHash,
    item.sourceFingerprint, item.parsing?.status, item.parsing?.updatedAt, item.ocrText]))
  for (const item of workspace.evidenceFragments) if (ids.has(item.evidenceId)) {
    hash.update(JSON.stringify([item.evidenceId, item.locator, item.text]))
  }
  return hash.digest('hex')
}

function hasCurrentMaterial(workspace: WorkspaceState, caseId: string, result: VerificationResult) {
  return result.inputKey === documentMaterialKey(workspace, caseId)
    && (!result.materialVersion || result.materialVersion === verificationMaterialVersion(workspace, caseId))
}

export function sameVerificationDocument(left: Certificate, right: Certificate) {
  const content = (item: Certificate) => [item.caseId, item.docKey, item.officeFile?.version, item.paragraphs.map(paragraph => [
    paragraph.id, paragraph.text, paragraph.richText, paragraph.evidenceCell, paragraph.aiOrigin,
    paragraph.links?.length ? paragraph.links : paragraph.link ? [paragraph.link] : [], paragraph.references ?? [],
  ])]
  return isDeepStrictEqual(content(left), content(right))
}

function reviewActor(workspace: WorkspaceState) {
  return getCurrentWorkspaceAccount() || workspace.user.email || workspace.user.name
}

export function validateDeclarationEdit(workspace: WorkspaceState, document: Certificate, paragraphId: string,
  action: DeclarationEditAction, replacementText: string | undefined) {
  const result = document.verification
  const prior = result?.audit?.find(item => item.id === action.id)
  if (prior) {
    if (prior.actor === reviewActor(workspace) && prior.action === action.type && prior.declarationId === action.declarationId && prior.paragraphId === paragraphId) return null
    throw new AppError('该操作标识已使用，请刷新后重试。', 409, 'REVIEW_CONFLICT')
  }
  const paragraph = document.paragraphs.find(item => item.id === paragraphId)
  const item = result?.declarations.find(item => item.id === action.declarationId && item.location.paragraphId === paragraphId)
  if (!result || !paragraph || !item || result.dirty?.declarationIds.includes(item.id) || (!result.dirty && document.linkageStale)
    || action.revision !== (result.revision ?? null) || action.reviewRevision !== (item.review?.revision ?? null)
    || result.inputKey !== document.linkageInputKey || !hasCurrentMaterial(workspace, document.caseId, result)
    || (result.authorityKey && result.authorityKey !== verificationAuthorityKey(workspace, result.declarations))) {
    throw new AppError('原文、核验结果或来源已更新，请重新打开声明后再处理。', 409, 'REVIEW_CONFLICT')
  }
  const range = declarationEditRange(paragraph.text, item, action.type)
  if (!range || replacementText !== paragraph.text.slice(0, range.start) + range.replacement + paragraph.text.slice(range.end)) {
    throw new AppError('声明原文无法精确定位，或修改范围与已核建议不一致。', 409, 'DECLARATION_EDIT_CONFLICT')
  }
  return { id: action.id, at: new Date().toISOString(), actor: reviewActor(workspace), action: action.type,
    paragraphId, declarationId: item.id, quote: paragraph.text.slice(range.start, range.end), previousVerdict: reviewedVerdict(item),
    sources: item.sources, note: range.replacement || undefined }
}

export function validateDeclarationReferences(workspace: WorkspaceState, document: Certificate, paragraph: CertificateParagraph,
  action: DeclarationReferenceEdit, patch: Partial<CertificateParagraph>) {
  const verification = document.verification
  const prior = verification?.audit?.find(item => item.id === action.id)
  if (prior) {
    if (prior.action === 'source' && prior.actor === reviewActor(workspace) && prior.paragraphId === paragraph.id && prior.declarationId === action.declarationId) return null
    throw new AppError('该操作标识已使用，请刷新后重试。', 409, 'REVIEW_CONFLICT')
  }
  const item = verification?.declarations.find(declaration => declaration.id === action.declarationId)
  if (!verification || !item || !declarationReviewIsCurrent(paragraph, item) || action.revision !== (verification.revision ?? null)
    || action.reviewRevision !== (item.review?.revision ?? null) || patch.text !== undefined
    || !hasCurrentMaterial(workspace, document.caseId, verification)
    || (verification.authorityKey && verification.authorityKey !== verificationAuthorityKey(workspace, verification.declarations))) {
    throw new AppError('声明或当前引用已更新，请重新打开后保存。', 409, 'REVIEW_CONFLICT')
  }
  const bindings = { ...verification.manualReferences }
  const links = patch.links ?? []
  const references = patch.references ?? []
  const sources = new Array<DeclarationSource>()
  for (const id of action.sourceIds) {
    const link = links.find(entry => entry.id === id)
    const reference = references.find(entry => entry.id === id)
    const selected = link ?? reference
    const material = link && workspace.evidences.find(entry => entry.id === link.evidenceId && entry.caseId === document.caseId)
    const knownReference = reference?.type === 'statute' ? workspace.knowledgeStatutes.some(law =>
      law.id === reference.targetId || law.articles.some(article => article.id === reference.targetId)) : reference && workspace.knowledgeCases.some(entry =>
      entry.id === reference.targetId || entry.excerpts?.some(excerpt => excerpt.id === reference.targetId))
    if ((!material && !knownReference) || !selected?.quote?.trim() || !selected.locator?.trim()
      || selected.sentenceIndex !== item.location.sentenceIndex || (bindings[id] && bindings[id] !== item.id)) {
      throw new AppError('引用无法关联到当前声明，请确认原文、出处和定位。', 409, 'REVIEW_SOURCE_CONFLICT')
    }
    bindings[id] = item.id
    sources.push({ tier: material ? 'l1' : reference?.type === 'statute' ? 'l2' : 'l3', id: material?.id ?? reference!.targetId,
      name: material?.name ?? reference!.sourceTitle, locator: selected.locator, quote: selected.quote })
  }
  const audit: VerificationAudit = { id: action.id, at: new Date().toISOString(), actor: reviewActor(workspace), action: 'source',
    paragraphId: paragraph.id, declarationId: item.id, quote: item.quote, previousVerdict: reviewedVerdict(item), sources: sources.length ? sources : item.sources }
  return { bindings, audit }
}

export function recordVerification(workspace: WorkspaceState, previous: VerificationResult | undefined, result: VerificationResult,
  affected?: string[], caseId?: string) {
  const at = new Date().toISOString()
  const calibration = readConfidenceCalibration(env.VERIFICATION_CALIBRATION_FILE, result.profileVersion)
  return { ...result, revision: randomUUID(), verifiedAt: at, dirty: undefined,
    declarations: applyConfidenceCalibration(result.declarations, calibration),
    manualReferences: result.manualReferences ?? previous?.manualReferences,
    authorityKey: verificationAuthorityKey(workspace, result.declarations),
    materialVersion: caseId ? verificationMaterialVersion(workspace, caseId) : previous?.materialVersion,
    audit: [...(previous?.audit ?? []), { id: randomUUID(), at, actor: reviewActor(workspace), action: 'verify' as const, affected,
      note: affected ? '局部重核' : '全文核验' }],
  } satisfies VerificationResult
}

export function saveDeclarationReview(certificateId: string, paragraphId: string, input: unknown) {
  const action = reviewActionSchema.parse(input)
  return runExclusiveWorkspaceMutation(async () => {
    const workspace = await readWorkspace()
    const document = workspace.certificates.find(item => item.id === certificateId)
    const result = document?.verification
    if (!document || !result) throw new AppError('当前文书需要先完成结构化核验。', 409, 'REVIEW_CONFLICT')
    const actor = reviewActor(workspace)
    if (result.audit?.some(item => item.id === action.id && item.paragraphId === paragraphId)) {
      applyReviewAction(result, action.declarationId, action, actor)
      return { workspace }
    }
    const paragraph = document.paragraphs.find(item => item.id === paragraphId)
    const declaration = result.declarations.find(item => item.id === action.declarationId)
    if (!paragraph || !declaration || !declarationReviewIsCurrent(paragraph, declaration)
      || (!result.dirty && document.linkageStale) || result.inputKey !== document.linkageInputKey
      || !hasCurrentMaterial(workspace, document.caseId, result)
      || (result.authorityKey && result.authorityKey !== verificationAuthorityKey(workspace, result.declarations))) {
      throw new AppError('正文或来源已更新，请重新核验后再复核。', 409, 'REVIEW_CONFLICT')
    }
    document.verification = applyReviewAction(result, action.declarationId, action, actor)
    const folder = workspace.cases.find(item => item.id === document.caseId)
    if (folder?.status === 'ready' && (action.type === 'reject' || document.verification.dirty)) folder.status = 'in_review'
    await writeWorkspace(workspace)
    return { workspace: await readWorkspace() }
  })
}

export async function recheckDirtyDeclarations(certificateId: string, signal?: AbortSignal) {
  const snapshot = await readWorkspace()
  const document = snapshot.certificates.find(item => item.id === certificateId)
  const previous = document?.verification
  if (!document || !previous?.dirty || previous.inputKey !== document.linkageInputKey
    || (document.docKey && previous.docKey !== normalizeDocKey(document.docKey))
    || previous.profileVersion !== profile.version || !hasCurrentMaterial(snapshot, document.caseId, previous)
    || (previous.authorityKey && previous.authorityKey !== verificationAuthorityKey(snapshot, previous.declarations))) {
    throw new AppError('没有适用的待重核声明，或材料、法源已更新，请核验整份文书。', 409, 'LOCAL_RECHECK_UNAVAILABLE')
  }
  const marked = prepareDirtyVerification(document, previous)
  const materialVersion = verificationMaterialVersion(snapshot, document.caseId)
  if (marked.verification.docKey !== previous.docKey) throw new AppError('文书类型已变化，请核验整份文书。', 409, 'LOCAL_RECHECK_UNAVAILABLE')
  const caseDeadline = AbortSignal.timeout(12_000)
  const evaluated = await recheckAssistantDeclarations(document, marked, snapshot, { signal, ...createVerificationSources(snapshot, caseDeadline) })
  return runExclusiveWorkspaceMutation(async () => {
    signal?.throwIfAborted()
    const latest = await readWorkspace()
    const current = latest.certificates.find(item => item.id === certificateId)
    if (!current || !sameVerificationDocument(document, current) || !isDeepStrictEqual(current.verification, previous)
      || !hasCurrentMaterial(latest, document.caseId, previous) || materialVersion !== verificationMaterialVersion(latest, document.caseId)
      || verificationAuthorityKey(snapshot, evaluated.declarations) !== verificationAuthorityKey(latest, evaluated.declarations)) {
      throw new AppError('正文、人工复核或来源在重核期间已更新，请重试。', 409, 'WORKSPACE_CONFLICT')
    }
    current.verification = recordVerification(latest, previous, evaluated, marked.dirtyIds, document.caseId)
    current.linkageInputKey = previous.inputKey
    current.linkageStale = false
    signal?.throwIfAborted()
    await writeWorkspace(latest)
    return { workspace: await readWorkspace(), certificate: current }
  })
}
