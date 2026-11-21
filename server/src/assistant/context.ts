import { z } from 'zod'
import type { Certificate, WorkspaceState } from '../domain.js'
import { linkageMaterialFingerprint } from '../intelligence/case-agent.js'
import { declarationReviewIsCurrent, verificationAuthorityKey } from '../intelligence/verification/review-state.js'
import type { DeclarationSource } from '../intelligence/verification/protocol.js'
import { profile } from '../intelligence/verification/profile.js'
import { reviewedVerdict } from '../intelligence/verification/review-status.js'

export const assistantContextSchema = z.object({
  certificateId: z.string().min(1).max(200).optional(),
  selectionText: z.string().max(6000).optional(),
  declarationIds: z.array(z.string().min(1).max(650)).max(12).optional(),
})
export type AssistantDocumentContext = z.infer<typeof assistantContextSchema>

export function buildAssistantDocumentContext(workspace: WorkspaceState, caseId: string, context?: AssistantDocumentContext, target?: Certificate) {
  const document = target ?? workspace.certificates.find(item => item.caseId === caseId && item.id === context?.certificateId)
  const selection = context?.selectionText?.trim() || undefined
  if (!document || document.caseId !== caseId) return selection ? { selection } : undefined
  const verification = document.verification
  const paragraphs = new Map(document.paragraphs.map(paragraph => [paragraph.id, paragraph]))
  const requestedIds = new Set(context?.declarationIds)
  const materials = new Map(workspace.evidences.filter(item => item.caseId === caseId).map(item => [item.id, item]))
  const stale = Boolean(document.linkageStale || (verification && requestedIds.size > 0 && (
    verification.inputKey !== linkageMaterialFingerprint([...materials.values()], workspace.evidenceInsights.filter(item => item.caseId === caseId))
    || (verification.authorityKey && verification.authorityKey !== verificationAuthorityKey(workspace, verification.declarations)))))
  const declarations = verification ? verification.declarations.flatMap(item => {
    const paragraph = paragraphs.get(item.location.paragraphId)
    if (!requestedIds.has(item.id) || !paragraph || !declarationReviewIsCurrent(paragraph, item)) return []
    const dirty = stale || verification.dirty?.declarationIds.includes(item.id)
      || verification.dirty?.paragraphIds.includes(paragraph.id)
    const current = (id?: string) => Boolean(id && verification.manualReferences?.[id] === item.id)
    const links = paragraph.links?.length ? paragraph.links : paragraph.link ? [paragraph.link] : []
    const sources = new Map<string, { tier: DeclarationSource['tier']; name: string; location?: string; excerpt?: string; url?: string }>()
    const add = (tier: DeclarationSource['tier'], name: string, location?: string, excerpt?: string, url?: string) => {
      const key = JSON.stringify([tier, name, location, excerpt])
      if (!sources.has(key)) sources.set(key, { tier, name, location, excerpt: excerpt?.slice(0, 1000), url })
    }
    for (const source of dirty ? [] : item.sources) add(source.tier, source.name, source.locator, source.quote, source.url)
    for (const reference of paragraph.references ?? []) if (current(reference.id)) {
      add(reference.type === 'statute' ? 'l2' : 'l3', reference.sourceTitle, reference.locator, reference.quote, reference.sourceUrl)
    }
    for (const link of links) if (current(link.id)) {
      const material = materials.get(link.evidenceId)
      if (material) add('l1', material.name, link.locator, link.quote)
    }
    return [{ text: item.quote.slice(0, 2000), type: profile.elementTypes[item.type], status: dirty ? 'pending' : reviewedVerdict(item),
      sources: [...sources.values()].slice(0, 6) }]
  }) : []
  return { document: { title: document.title, type: document.docKey && profile.profiles[document.docKey]?.name }, selection, declarations }
}
