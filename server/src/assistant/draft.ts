import { createHash, randomUUID } from 'node:crypto'
import type { CaseContextMemory, Certificate, CertificateParagraph, WorkspaceState } from '../domain.js'
import { AppError } from '../core/app-error.js'
import { createVerificationSources } from '../integrations/verification-sources.js'
import { linkageMaterialFingerprint } from '../intelligence/case-agent.js'
import { getLinkageSentences, isGroundedLinkageQuote } from '../intelligence/linkage-policy.js'
import { dependentDeclarationIds } from '../intelligence/verification/dependencies.js'
import { extractDeclarations } from '../intelligence/verification/extract.js'
import { profile } from '../intelligence/verification/profile.js'
import { declarationReviewIsCurrent, invalidateVerification, reopenAuthorityContext, verificationAuthorityKey } from '../intelligence/verification/review-state.js'
import { locateRewriteSelection, type RewriteSelection } from '../intelligence/verification/rewrite-selection.js'
import type { Declaration, DeclarationSource, VerificationResult } from '../intelligence/verification/protocol.js'
import { runRetrievalSkill, type RetrievalSkillId } from './retrieval.js'
import { insertRichText, rewriteRichText } from './rewrite-rich-text.js'

type DraftAuthority = Pick<Declaration, 'type' | 'quote' | 'sources' | 'caseVerification'>

export async function researchDraftAuthorities(workspace: WorkspaceState, caseId: string, topic: string, focus: string,
  docKey: Certificate['docKey'], declarations: Declaration[], memory: CaseContextMemory | null, signal?: AbortSignal) {
  const input = { workspace, caseId, docKey, ...createVerificationSources(workspace) }
  const query = [topic, ...(memory?.disputeFocuses.slice(0, 2) ?? []), focus].filter(Boolean).join(' ').slice(0, 400)
  const contextEntry = (type: Declaration['type'], quote: string, index: number): Declaration => ({
    id: `draft-context-${index}`, type, quote, location: { paragraphId: `draft-context-${index}`, paragraphIndex: index, start: 0, end: quote.length },
    verdict: 'pending', checks: {}, sources: [], reason: '起草检索上下文，待核验。', conf: null,
  })
  const context = declarations.length ? declarations : [
    ...(memory?.supportMatrix.filter(item => item.evidenceIds.length).slice(0, 8).map((item, index) => contextEntry('E-FACT', item.fact, index)) ?? []),
    ...[topic, ...(memory?.disputeFocuses.slice(0, 4) ?? [])].filter(Boolean).map((item, index) => contextEntry('E-FOCUS', item, 10 + index)),
  ]
  const search = async (skill: RetrievalSkillId, context: Declaration[]) => {
    const deadline = AbortSignal.timeout(skill === 'statute-mcp' ? 6000 : 8000)
    const searchSignal = signal ? AbortSignal.any([signal, deadline]) : deadline
    try {
      const result = await runRetrievalSkill(skill, { ...input, query, declarations: context, signal: searchSignal })
      const fallback = topic.replace(/纠纷$/u, '').trim()
      if (result.status !== 'empty' || !fallback || fallback === query) return result
      return await runRetrievalSkill(skill, { ...input, query: fallback, declarations: context, signal: searchSignal })
    } catch {
      signal?.throwIfAborted()
      return undefined
    }
  }
  const law = await search('statute-mcp', context)
  const lawContext = (law?.cards ?? []).flatMap((card, index) => {
    if (card.status !== 'verified' || !('law_name' in card.output)) return []
    return [{ ...contextEntry('E-LAW', `《${card.output.law_name}》${card.output.article_number}`, 20 + index),
      checks: card.output.validity === 'VALID' && !card.reason ? { B2: { outcome: 'pass' as const, reason: '起草前已核对条文效力。' } } : {},
      sources: [card.source], statuteVerification: card.statuteVerification }]
  })
  const confirmedLawQuotes = new Set(lawContext.filter(item => item.checks.B2?.outcome === 'pass').map(item => item.quote.normalize('NFKC')))
  const cases = await search('case-mcp', [...context.filter(item => item.type !== 'E-LAW' || !confirmedLawQuotes.has(item.quote.normalize('NFKC'))), ...lawContext])
  signal?.throwIfAborted()
  const caseAuthorities: DraftAuthority[] = (cases?.cards ?? []).flatMap(card => card.status === 'verified' && 'case_number' in card.output
    ? [{ type: 'E-CASE', quote: card.output.case_number, sources: [card.source], caseVerification: card.caseVerification }] : [])
  const describe = (label: string, result: typeof law, count: number) => !result ? `${label}检索暂不可用`
    : count ? `${label}可回查 ${count} 条` : result.message
  return { authorities: [...lawContext, ...caseAuthorities], notice: [describe('法条', law, lawContext.length),
    describe('类案', cases, caseAuthorities.length)].join(' · ') }
}

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

export function prepareAssistantDraft(workspace: WorkspaceState, raw: Certificate, authorities: DraftAuthority[], inputKey: string) {
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
  const manualReferences: Record<string, string> = {}
  const literal = (value: string) => value.replace(/\s/gu, '')
  for (const item of [...extracted.declarations, ...extracted.offCandidates]) {
    if (item.type !== 'E-LAW' && item.type !== 'E-CASE') continue
    const tail = paragraphs[item.location.paragraphIndex].text.slice(item.location.end)
    const quote = /^([\s：:,，]*(?:(?:规定|载明|指出|本院认为|裁判理由|判决如下|裁定如下|判项)[\s：:,，]*)*)[“‘「"]([^”’」"]+)[”’」"]/u.exec(tail)
    const operative = /判决如下|裁定如下|判项/u.test(quote?.[1] ?? '')
    const tier = item.type === 'E-LAW' ? 'l2' : 'l3'
    const sources = quote && /^[ \t]*(?:[。；！？\r\n]|$)/u.test(tail.slice(quote[0].length)) ? authorities
      .filter(known => known.type === item.type && literal(known.quote.normalize('NFKC')) === literal(item.quote.normalize('NFKC')) && (tier === 'l2'
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
      for (const source of knownSources) {
        const id = randomUUID()
        const state = authorities.find(authority => authority.type === 'E-CASE' && authority.sources.includes(source))?.caseVerification
        const caseDetails = state && { caseNumber: state.caseNumber, court: state.court, judgmentDate: state.judgmentDate }
        references.push({ id, type: item.type === 'E-LAW' ? 'statute' : 'case', targetId: source.id, sourceTitle: source.name,
          label: source.locator || source.name, locator: source.locator ?? '', quote: source.quote!, caseDetails,
          sentenceIndex: item.location.sentenceIndex, sourceUrl: source.url, reason: '起草检索出处', note: '已核出处，起草引文待复核' })
        manualReferences[id] = item.id
      }
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
    docKey: extracted.docKey, classificationRequired: extracted.classificationRequired, declarations, manualReferences }
  return {
    certificate: { ...certificate, linkageInputKey: inputKey, linkageStale: !declarations.length || extracted.classificationRequired, verification },
    draft: { type: 'draft-doc' as const, docType: extracted.docKey ?? '待确认', items: declarations.map(item => ({
      type: item.type, quote: item.quote, loc: item.location, sources: item.sources, verdict: item.verdict, aiOrigin: item.aiOrigin,
    })) },
  }
}

export function locateSupplement(document: Certificate, selection: RewriteSelection) {
  const paragraph = locateRewriteSelection(document.paragraphs, selection)
  const selectedEnd = selection.start + selection.quote.length
  const lastTextEnd = selectedEnd - (selection.quote.match(/[”’」』】）)\]]+$/u)?.[0].length ?? 0) || selectedEnd
  const afterClosingMarks = (offset: number) => offset + (paragraph.text.slice(offset).match(/^[”’」』】）)\]]+/u)?.[0].length ?? 0)
  if (paragraph.evidenceCell || /<(?:table|ul|ol)\b/iu.test(paragraph.richText ?? '')) {
    const separators = /[。！？!?；;\n\t]/u
    const last = paragraph.text[lastTextEnd - 1]
    const boundary = paragraph.text.slice(selectedEnd).search(separators)
    const end = separators.test(last) ? selectedEnd : boundary < 0 ? paragraph.text.length
      : selectedEnd + boundary + (/[\n\t]/u.test(paragraph.text[selectedEnd + boundary]) ? 0 : 1)
    return { paragraph, before: paragraph, after: undefined, inside: afterClosingMarks(end) }
  }
  const sentences = Array.from(paragraph.text.matchAll(/[^。！？!?；;\n]+[。！？!?；;]?/gu)).filter(item => item[0].trim())
  const index = sentences.findIndex(item => item.index < lastTextEnd && item.index + item[0].length >= lastTextEnd)
  const sentence = sentences[index]
  if (!sentence) throw new AppError('无法定位选区的结束位置，请重新选择。', 409, 'DRAFT_SELECTION_UNAVAILABLE')
  const end = afterClosingMarks(sentence.index + sentence[0].length)
  const before = paragraph.text.slice(0, end)
  const after = paragraph.text.slice(end).trimStart()
  if (!after.trim()) return { paragraph, before: paragraph, after: undefined }
  const suffixId = randomUUID()
  const scope = <T extends { id?: string; sentenceIndex?: number }>(items: T[], suffix: boolean) => items.flatMap<T>(item => {
    if (item.sentenceIndex === undefined) return [{ ...item, ...(suffix && { id: randomUUID() }) }]
    if ((item.sentenceIndex > index) !== suffix) return []
    return [{ ...item, sentenceIndex: suffix ? item.sentenceIndex - index - 1 : item.sentenceIndex }]
  })
  const split = (text: string, suffix: boolean): CertificateParagraph => {
    const links = scope(paragraph.links?.length ? paragraph.links : paragraph.link ? [paragraph.link] : [], suffix)
    return { ...paragraph, id: suffix ? suffixId : paragraph.id, text, richText: rewriteRichText(paragraph.richText, paragraph.text, text),
      references: scope(paragraph.references ?? [], suffix), links, link: links[0], verified: false,
      note: suffix ? undefined : paragraph.note, linkageFocus: undefined }
  }
  return { paragraph, before: split(before, false), after: split(after, true) }
}

function sentenceSpans(text: string) {
  let cursor = 0
  return getLinkageSentences(text).flatMap(sentence => {
    const start = text.indexOf(sentence.sentenceText, cursor)
    if (start < 0) return []
    cursor = start + sentence.sentenceText.length
    return [{ ...sentence, start, end: cursor }]
  })
}

function insertIntoStructuredParagraph(paragraph: CertificateParagraph, offset: number, additions: CertificateParagraph[]) {
  const insertion = `\n${additions.map(item => item.text).join('\n')}\n`
  const text = paragraph.text.slice(0, offset) + insertion + paragraph.text.slice(offset)
  const richText = paragraph.richText ? insertRichText(paragraph.richText, paragraph.text, offset, insertion) : undefined
  const spans = sentenceSpans(text)
  const original = sentenceSpans(paragraph.text)
  const relocate = <T extends { sentenceIndex?: number; sentenceText?: string }>(sources: T[], from: ReturnType<typeof sentenceSpans>, move: (start: number) => number, keepUnscoped: boolean) =>
    sources.map(source => {
      if (source.sentenceIndex === undefined && keepUnscoped) return source
      const span = from[source.sentenceIndex ?? 0]
      const position = move(span?.start ?? 0)
      const target = spans.find(item => item.start <= position && position < item.end)
      if (!target) return source
      return { ...source, sentenceIndex: target.sentenceIndex, sentenceText: target.sentenceText }
    })
  const moveOriginal = (start: number) => start < offset ? start : start + insertion.length
  const links = relocate(paragraph.links?.length ? paragraph.links : paragraph.link ? [paragraph.link] : [], original, moveOriginal, true)
  const references = relocate(paragraph.references ?? [], original, moveOriginal, true)
  const locations = new Map<string, { paragraphId: string; start: number; end: number }>()
  let start = offset + 1
  for (const addition of additions) {
    const range = { paragraphId: paragraph.id, start, end: start + addition.text.length }
    locations.set(addition.id, range)
    const original = sentenceSpans(addition.text)
    const move = (position: number) => range.start + position
    links.push(...relocate(addition.links ?? [], original, move, false))
    references.push(...relocate(addition.references ?? [], original, move, false))
    start = range.end + 1
  }
  return { paragraph: { ...paragraph, text, richText, links, link: links[0], references, linkageFocus: undefined, verified: false }, locations }
}

export function applyDraftSupplement(workspace: WorkspaceState, document: Certificate, draft: ReturnType<typeof prepareAssistantDraft>['certificate'],
  anchor: ReturnType<typeof locateSupplement>, inputKey: string, actor: string): Certificate {
  const structured = anchor.inside === undefined ? undefined : insertIntoStructuredParagraph(anchor.paragraph, anchor.inside, draft.paragraphs)
  const locations = structured?.locations ?? new Map(draft.paragraphs.map(item => [item.id, { paragraphId: item.id, start: 0, end: item.text.length }]))
  const paragraphs = document.paragraphs.flatMap(item => item.id === anchor.paragraph.id
    ? structured ? [structured.paragraph] : [anchor.before, ...draft.paragraphs, ...(anchor.after ? [anchor.after] : [])] : [item])
  const next = { ...document, paragraphs, paragraphIds: paragraphs.map(item => item.id) }
  const invalidated = invalidateVerification(document, next, actor)
  const paragraphsById = new Map(paragraphs.map(item => [item.id, item]))
  const anchored = (invalidated?.declarations ?? []).filter(item => {
    const paragraph = paragraphsById.get(item.location.paragraphId)
    return paragraph && declarationReviewIsCurrent(paragraph, item)
  })
  const mapped = draft.verification.declarations.flatMap(item => {
    const target = locations.get(item.location.paragraphId)
    if (!target) return []
    return [{ ...item, location: { ...item.location, paragraphId: target.paragraphId,
      start: target.start + item.location.start, end: target.start + item.location.end } }]
  })
  const extracted = extractDeclarations({ ...next, verification: invalidated }, [...anchored, ...mapped].map(item => ({ paragraphId: item.location.paragraphId,
    quote: item.quote, start: item.location.start, type: item.type, factKinds: item.factKinds })))
  const previous = document.verification
  const currentBaseline = previous && previous.inputKey === inputKey && document.linkageInputKey === inputKey
    && (!document.linkageStale || previous.dirty)
    && (!previous.authorityKey || previous.authorityKey === verificationAuthorityKey(workspace, previous.declarations))
  const old = new Map((currentBaseline ? anchored : []).map(item => [item.id, item]))
  const declarationKey = ({ location: { paragraphId, start, end }, type }: Declaration) => `${paragraphId}:${start}:${end}:${type}`
  const cited = new Map(mapped.map(item => [declarationKey(item), item]))
  const insertedRanges = [...locations.values()]
  const wasInserted = (item: Declaration) => insertedRanges.some(range => range.paragraphId === item.location.paragraphId
    && range.start < item.location.end && range.end > item.location.start)
  const draftIds = new Map<string, string>()
  const declarations = extracted.declarations.map(item => {
    if (!wasInserted(item)) return old.get(item.id) ?? item
    const match = cited.get(declarationKey(item))
    if (match) draftIds.set(match.id, item.id)
    return { ...item, aiOrigin: 'draft' as const, sources: match?.sources ?? [] }
  })
  const inserted = declarations.filter(wasInserted)
  const affected = inserted.map(item => item.id)
  const dirtyParagraphs = new Set([...(invalidated?.dirty?.paragraphIds ?? []), ...insertedRanges.map(item => item.paragraphId), ...(anchor.after ? [anchor.after.id] : [])])
  const dirtyDeclarations = new Set([...(invalidated?.dirty?.declarationIds ?? []), ...affected])
  if (!currentBaseline) for (const item of declarations) dirtyDeclarations.add(item.id)
  reopenAuthorityContext(declarations, inserted, dirtyDeclarations)
  const manualReferences: Record<string, string> = { ...invalidated?.manualReferences }
  for (const [id, candidateId] of Object.entries(draft.verification.manualReferences ?? {})) {
    const saved = draftIds.get(candidateId)
    if (saved) manualReferences[id] = saved
  }
  if (anchor.after) {
    const suffix = anchor.after
    const offset = anchor.paragraph.text.length - suffix.text.length
    const oldIds = new Map((document.verification?.declarations ?? []).map(item => [item.id, item]))
    for (const source of [...(suffix.references ?? []), ...(suffix.links ?? [])]) {
      const previousId = source.id && manualReferences[source.id]
      const previous = previousId ? oldIds.get(previousId) : undefined
      const moved = previous && declarations.find(item => item.location.paragraphId === suffix.id && item.type === previous.type
        && item.location.start === previous.location.start - offset && item.quote === previous.quote)
      if (source.id && moved) manualReferences[source.id] = moved.id
    }
  }
  const declarationIds = new Set(declarations.map(item => item.id))
  return { ...next, linkageStale: true, linkageInputKey: inputKey, verification: {
    ...invalidated, version: 1, profileVersion: profile.version, inputKey, revision: randomUUID(), declarations,
    docKey: extracted.docKey, classificationRequired: extracted.classificationRequired, authorityKey: verificationAuthorityKey(workspace, declarations),
    materialVersion: currentBaseline ? invalidated?.materialVersion : undefined,
    manualReferences: Object.fromEntries(Object.entries(manualReferences).filter(([, id]) => declarationIds.has(id))),
    dirty: { paragraphIds: [...dirtyParagraphs], declarationIds: [...dependentDeclarationIds(declarations, dirtyDeclarations)].filter(id => declarationIds.has(id)) },
    audit: [...(invalidated?.audit ?? []), { id: randomUUID(), action: 'adopt', at: new Date().toISOString(), actor,
      paragraphId: insertedRanges[0]?.paragraphId, declarationId: affected[0], note: '律师采纳选区补写，新增声明待核验', affected }],
  } satisfies VerificationResult }
}
