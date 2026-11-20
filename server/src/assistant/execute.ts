import { randomUUID } from 'node:crypto'
import { AppError } from '../core/app-error.js'
import type { Certificate, CertificateParagraph, WorkspaceState } from '../domain.js'
import { runExclusiveWorkspaceMutation } from '../infrastructure/workspace-lock.js'
import { createVerificationSources } from '../integrations/verification-sources.js'
import { extractDeclarations } from '../intelligence/verification/extract.js'
import { profile } from '../intelligence/verification/profile.js'
import { invalidateVerification, verificationAuthorityKey } from '../intelligence/verification/review-state.js'
import { getCurrentWorkspaceAccount, readWorkspace, writeWorkspace } from '../store.js'
import { isAnalysisSkill, runAnalysisSkill } from './analysis.js'
import { rememberAssistantCandidate, type AssistantCandidateTarget } from './candidates.js'
import { assistantMaterialVersion, assistantSnapshot } from './draft.js'
import { isRetrievalSkill, runRetrievalSkill, type RetrievalCard } from './retrieval.js'
import { validateSkillOutput } from './skill-contract.js'

type SkillInput = AssistantCandidateTarget & { query?: string; factDate?: string }
type VerifiedCard = Extract<RetrievalCard, { status: 'verified' }>

function sourceSnapshot(workspace: WorkspaceState, caseId: string, card: VerifiedCard) {
  if (card.evidenceLink) {
    const id = card.evidenceLink.evidenceId
    const source = workspace.evidences.find(item => item.caseId === caseId && item.id === id)
    return assistantSnapshot([source?.ocrText, source?.contentHash, source?.sourceFingerprint, source?.parsing, source?.name, source?.anchorHint,
      workspace.evidenceFragments.filter(item => item.caseId === caseId && item.evidenceId === id)])
  }
  return assistantSnapshot(card.source.tier === 'l2' ? workspace.knowledgeStatutes : workspace.knowledgeCases)
}

function stageCitation(target: Certificate, workspace: WorkspaceState, card: RetrievalCard) {
  if (card.status !== 'verified') return undefined
  const verifiedLegalSource = (card.source.tier === 'l2' || card.source.tier === 'l3')
    && card.source.url && card.source.locator && card.source.quote
  if (!card.evidenceLink && !card.reference && !verifiedLegalSource) return undefined
  const { caseId, id: certificateId } = target
  const documentVersion = assistantSnapshot(target)
  const materialVersion = assistantMaterialVersion(workspace, caseId)
  const sourceVersion = sourceSnapshot(workspace, caseId, card)
  return rememberAssistantCandidate({ caseId, certificateId }, () => runExclusiveWorkspaceMutation(async () => {
    const latest = await readWorkspace()
    const document = latest.certificates.find(item => item.id === certificateId && item.caseId === caseId)
    const folder = latest.cases.find(item => item.id === caseId)
    if (!folder || !document || assistantSnapshot(document) !== documentVersion || assistantMaterialVersion(latest, caseId) !== materialVersion
      || sourceSnapshot(latest, caseId, card) !== sourceVersion) {
      throw new AppError('文书或来源已变化，请重新检索后采纳。', 409, 'CITATION_TARGET_CHANGED')
    }
    const paragraph: CertificateParagraph = {
      id: randomUUID(), text: card.citationText, verified: false, aiOrigin: 'citation',
      ...(card.evidenceLink && { links: [{ ...card.evidenceLink, relation: 'context', note: '律师采纳卷内摘录，待核验' }] }),
      ...(card.reference && { references: [{ ...card.reference, note: '律师采纳检索引文，待核验' }] }),
    }
    const previous = document.verification
    const baseline = previous && !document.linkageStale && document.linkageInputKey === materialVersion
      && previous.inputKey === materialVersion && (!previous.authorityKey || previous.authorityKey === verificationAuthorityKey(latest, previous.declarations))
      ? previous : undefined
    const paragraphs = [...document.paragraphs, paragraph]
    const invalidated = invalidateVerification(document, { ...document, paragraphs })
    document.paragraphs = paragraphs
    document.paragraphIds.push(paragraph.id)
    const extracted = extractDeclarations(document)
    const reason = '已采纳可回查引文，待重新核验。'
    const newDeclarations = extracted.declarations.filter(item => item.location.paragraphId === paragraph.id)
      .map(item => ({ ...item, reason, sources: [card.source] }))
    const declarations = [...(baseline?.declarations ?? extracted.declarations.filter(item => item.location.paragraphId !== paragraph.id)), ...newDeclarations]
    const affected = newDeclarations.map(item => item.id)
    document.verification = {
      ...invalidated,
      version: 1, profileVersion: profile.version, inputKey: materialVersion, docKey: extracted.docKey,
      classificationRequired: extracted.classificationRequired, documentDiagnostics: baseline?.documentDiagnostics,
      revision: randomUUID(), authorityKey: verificationAuthorityKey(latest, declarations), declarations,
      dirty: { paragraphIds: [...new Set([...(invalidated?.dirty?.paragraphIds ?? []), paragraph.id])],
        declarationIds: [...new Set([...(invalidated?.dirty?.declarationIds ?? []), ...affected])] },
      audit: [...(previous?.audit ?? []), { id: randomUUID(), action: 'adopt', at: new Date().toISOString(),
        actor: getCurrentWorkspaceAccount() ?? latest.user.email, paragraphId: paragraph.id, declarationId: affected[0],
        quote: paragraph.text, note: '律师采纳检索引文，待核验', sources: [card.source], affected }],
    }
    if (!baseline || !newDeclarations.length) document.linkageStale = true
    if (folder.status === 'ready') folder.status = 'in_review'
    await writeWorkspace(latest)
    return { certificateId, paragraphId: paragraph.id, elementId: newDeclarations[0]?.id }
  }))
}

export async function executeAssistantSkill(id: string, input: SkillInput, signal?: AbortSignal) {
  const workspace = await readWorkspace()
  const folder = workspace.cases.find(item => item.id === input.caseId)
  if (!folder) throw new AppError('案件不存在。', 404, 'ASSISTANT_CASE_NOT_FOUND')
  const certificate = input.certificateId ? workspace.certificates.find(item => item.id === input.certificateId && item.caseId === input.caseId) : undefined
  if (input.certificateId && !certificate) throw new AppError('文书不在当前案件。', 404, 'ASSISTANT_DOCUMENT_NOT_FOUND')
  if (isAnalysisSkill(id)) return runAnalysisSkill(id, { workspace, caseId: input.caseId, certificate, position: folder.agent?.position })
  if (!isRetrievalSkill(id)) throw new AppError('此技能需要从相应的预览入口执行。', 400, 'ASSISTANT_SKILL_UNAVAILABLE')
  const query = input.query?.trim()
  if (!query) throw new AppError('请输入检索关键词。', 400, 'ASSISTANT_QUERY_REQUIRED')

  const snapshot = certificate?.verification && !certificate.linkageStale
    && certificate.verification.inputKey === certificate.linkageInputKey
    && certificate.linkageInputKey === assistantMaterialVersion(workspace, input.caseId)
    && (!certificate.verification.authorityKey || certificate.verification.authorityKey === verificationAuthorityKey(workspace, certificate.verification.declarations))
    ? certificate.verification : undefined
  const dirty = new Set(snapshot?.dirty?.declarationIds)
  const sources = id !== 'inbox-search' ? createVerificationSources(workspace) : undefined
  const result = await runRetrievalSkill(id, { ...input, query, workspace, declarations: snapshot?.declarations.filter(item => !dirty.has(item.id)
    && !snapshot.dirty?.paragraphIds.includes(item.location.paragraphId)),
    docKey: certificate?.docKey, ...sources, signal })
  signal?.throwIfAborted()
  return { ...result, cards: result.cards.map(card => ({ ...card, candidateId: certificate ? stageCitation(certificate, workspace, card) : undefined })) }
}

export async function checkAssistantCaseReport(input: AssistantCandidateTarget & { version?: string; confirmed: boolean; report: unknown }) {
  if (input.confirmed !== true) throw new AppError('请确认导出案例报告。', 400, 'ASSISTANT_CONFIRMATION_REQUIRED')
  const workspace = await readWorkspace()
  if (!workspace.cases.some(item => item.id === input.caseId)) throw new AppError('案件已不存在。', 404, 'ASSISTANT_CASE_NOT_FOUND')
  if (input.certificateId) {
    const document = workspace.certificates.find(item => item.id === input.certificateId && item.caseId === input.caseId)
    if (!document || assistantSnapshot([document.docKey, document.officeFile?.version, document.verification,
      document.paragraphs.map(item => [item.id, item.text, item.richText])]) !== input.version) {
      throw new AppError('文书或核验结果已更新，请重新预览案例报告。', 409, 'ASSISTANT_REPORT_TARGET_CHANGED')
    }
  }
  validateSkillOutput('case-report', input.report)
  return { ok: true }
}
