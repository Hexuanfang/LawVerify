import type { AppState, CertificateParagraph } from '../types'
import { paragraphElements, statementRanges } from './model.ts'

export function reviewReadiness(workspace: AppState, caseId: string, certificateId?: string) {
  const documents = workspace.certificates.filter(item => item.caseId === caseId && (!certificateId || item.id === certificateId))
  const paragraphs = documents.flatMap(item => item.paragraphs).filter(paragraph => paragraph.text.trim())
  const unreviewed = paragraphs.filter(item => !item.verified).length
  const red = documents.flatMap(doc => doc.paragraphs.flatMap(paragraph => paragraphElements(paragraph, workspace, doc.id)))
    .filter(item => item.verdict === 'fail' || item.verdict === 'miss').length
  const empty = !documents.length || documents.some(doc => !doc.paragraphs.some(paragraph => paragraph.text.trim()))
  const pendingParsing = workspace.evidences.some(item => item.caseId === caseId && item.parsing && item.parsing.status !== 'ready')
  return { total: paragraphs.length, unreviewed, red, ready: !empty && !unreviewed && !red && !pendingParsing }
}

export function reanchorParagraph(original: CertificateParagraph, text: string, richText: string): Partial<CertificateParagraph> {
  if (text === original.text) return { text, richText, verified: original.verified }
  const oldRanges = statementRanges(original.text)
  const nextRanges = statementRanges(text)
  const relocate = <T extends { sentenceIndex?: number; sentenceText?: string }>(source: T): T[] => {
    // 段落级来源无法推断修改后仍适用；重复句也不按猜测重挂。
    if (source.sentenceIndex === undefined) return []
    const previous = oldRanges[source.sentenceIndex]
    if (!previous || oldRanges.filter(item => item.text === previous.text).length !== 1) return []
    const candidates = nextRanges.filter(item => item.text === previous.text)
    return candidates.length === 1 ? [{ ...source, sentenceIndex: candidates[0].sentenceIndex, sentenceText: candidates[0].text }] : []
  }
  const links = (original.links?.length ? original.links : original.link ? [original.link] : []).flatMap(relocate)
  return { text, richText, verified: false, links, link: links[0], references: (original.references ?? []).flatMap(relocate) }
}
