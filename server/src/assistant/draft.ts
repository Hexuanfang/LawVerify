import { createHash } from 'node:crypto'
import type { Certificate, WorkspaceState } from '../domain.js'
import { AppError } from '../core/app-error.js'
import { linkageMaterialFingerprint } from '../intelligence/case-agent.js'
import { isGroundedLinkageQuote } from '../intelligence/linkage-policy.js'
import { extractDeclarations } from '../intelligence/verification/extract.js'
import { profile } from '../intelligence/verification/profile.js'
import { verificationAuthorityKey } from '../intelligence/verification/review-state.js'
import type { Declaration, DeclarationSource, VerificationResult } from '../intelligence/verification/protocol.js'

export function assistantSnapshot(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value ?? null)).digest('base64url')
}

export function assistantMaterialVersion(workspace: WorkspaceState, caseId: string) {
  return linkageMaterialFingerprint(workspace.evidences.filter(item => item.caseId === caseId),
    workspace.evidenceInsights.filter(item => item.caseId === caseId))
}

export function verifiedDraftAuthorities(workspace: WorkspaceState, certificate: Certificate | undefined) {
  if (!certificate || certificate.linkageStale || certificate.linkageInputKey !== assistantMaterialVersion(workspace, certificate.caseId)) return []
  const verification = certificate.verification
  if (!verification || verification.inputKey !== certificate.linkageInputKey || (verification.authorityKey
    && verification.authorityKey !== verificationAuthorityKey(workspace, verification.declarations))) return []
  const dirty = new Set(verification.dirty?.declarationIds)
  return verification.declarations.filter(item => {
    if (dirty.has(item.id) || verification.dirty?.paragraphIds.includes(item.location.paragraphId)) return false
    if (item.verdict !== 'pass' && item.verdict !== 'warn') return false
    if (item.type === 'E-LAW' && (item.checks.B1?.outcome !== 'pass' || item.checks.B3?.outcome !== 'pass'
      || item.statuteVerification?.applicability !== 'applicable')) return false
    if (item.type === 'E-CASE' && !item.caseVerification?.allowCitation) return false
    if (item.type !== 'E-LAW' && item.type !== 'E-CASE') return false
    return item.sources.some(source => source.tier === (item.type === 'E-LAW' ? 'l2' : 'l3') && source.url && source.quote)
  })
}

export function prepareAssistantDraft(workspace: WorkspaceState, raw: Certificate, authorities: Declaration[], inputKey: string) {
  const materials = new Map(workspace.evidences.filter(item => item.caseId === raw.caseId && (!item.parsing || item.parsing.status === 'ready'))
    .map(item => [item.id, item]))
  const paragraphs = raw.paragraphs.map(paragraph => {
    const links = (paragraph.links?.length ? paragraph.links : paragraph.link ? [paragraph.link] : []).filter(link => {
      const evidence = materials.get(link.evidenceId)
      return Boolean(evidence && link.locator && isGroundedLinkageQuote(link.quote, [evidence.ocrText ?? '']))
    })
    return { ...paragraph, links, link: links[0], verified: false, aiOrigin: 'draft' as const }
  })
  const certificate = { ...raw, paragraphs }
  const extracted = extractDeclarations(certificate)
  const authoritySources = new Map<string, DeclarationSource[]>()
  const literal = (value: string) => value.replace(/\s/gu, '')
  for (const item of [...extracted.declarations, ...extracted.offCandidates]) {
    if (item.type !== 'E-LAW' && item.type !== 'E-CASE') continue
    const tail = paragraphs[item.location.paragraphIndex].text.slice(item.location.end)
    const quote = /^([\s：:,，]*(?:(?:规定|载明|指出|本院认为|裁判理由|判决如下|裁定如下|判项)[\s：:,，]*)*)[“‘「"]([^”’」"]+)[”’」"]/u.exec(tail)
    const operative = /判决如下|裁定如下|判项/u.test(quote?.[1] ?? '')
    const tier = item.type === 'E-LAW' ? 'l2' : 'l3'
    const sources = quote && /^[ \t]*(?:[。；！？\r\n]|$)/u.test(tail.slice(quote[0].length)) ? authorities
      .filter(known => known.type === item.type && known.quote === item.quote && (tier === 'l2'
        || known.caseVerification?.citationKind === (operative ? 'operative' : 'reasoning')))
      .flatMap(known => known.sources.filter(source => source.tier === tier && source.url && source.quote
        && literal(source.quote) === literal(quote[2]))) : []
    if (!sources.length) throw new AppError('草稿含有未经核验的法条或案例引文，请核对来源后重新起草。', 422, 'DRAFT_UNVERIFIED_CITATION')
    authoritySources.set(item.id, sources)
  }
  const declarations = extracted.declarations.map(item => {
    const paragraph = paragraphs[item.location.paragraphIndex]
    const knownSources = authoritySources.get(item.id)
    if (knownSources) {
      const references = paragraph.references ??= []
      for (const source of knownSources) references.push({ type: item.type === 'E-LAW' ? 'statute' : 'case', targetId: source.id,
        sourceTitle: source.name, label: source.locator || source.name, locator: source.locator ?? '', quote: source.quote!,
        sentenceIndex: item.location.sentenceIndex, note: '已核出处，起草引文待复核' })
      return { ...item, sources: knownSources }
    }
    const sources = paragraph.links.filter(link => (link.sentenceIndex === undefined && item.quote.includes(link.quote))
      || (link.sentenceIndex !== undefined && link.sentenceIndex === item.location.sentenceIndex)).map<DeclarationSource>(link => ({
      tier: 'l1', id: link.evidenceId, name: materials.get(link.evidenceId)!.name, locator: link.locator, quote: link.quote,
      version: materials.get(link.evidenceId)!.contentHash ?? materials.get(link.evidenceId)!.sourceFingerprint,
    }))
    return { ...item, sources }
  })
  const verification: VerificationResult = { version: 1, profileVersion: profile.version, inputKey,
    docKey: extracted.docKey, classificationRequired: extracted.classificationRequired, declarations }
  return {
    certificate: { ...certificate, linkageInputKey: inputKey, linkageStale: !declarations.length || extracted.classificationRequired, verification },
    draft: { type: 'draft-doc' as const, docType: extracted.docKey ?? '待确认', items: declarations.map(item => ({
      type: item.type, quote: item.quote, loc: item.location, sources: item.sources, verdict: item.verdict, aiOrigin: item.aiOrigin,
    })) },
  }
}
