import type { AppState, CertificateParagraph } from '../types'
import { createParagraphReviewer, needsVerification, statementRanges, type Verdict } from './model.ts'
import { hasDocumentDraft } from '../draft-store.ts'

export function blocksWordExport(verdict: Verdict) {
  return verdict === 'fail' || verdict === 'miss' || verdict === 'pending'
}

export function wordExportReadiness(workspace: AppState, certificateId: string) {
  const certificate = workspace.certificates.find(item => item.id === certificateId)
  const elements = certificate?.paragraphs.flatMap(createParagraphReviewer(workspace, certificateId)) ?? []
  const blocking = elements.filter(item => blocksWordExport(item.verdict)).length
  const reason = !certificate?.paragraphs.some(paragraph => paragraph.text.trim()) ? '没有可导出的正文。'
    : needsVerification(workspace, certificateId) ? '当前正文或材料尚未完成核验，请先返回文书运行 AI 核验。'
      : !elements.length ? '当前文书没有可用的核验结果。'
        : blocking ? `还有 ${blocking} 项不通过、缺源或待核验，请处理后再导出。` : ''
  return { certificate, elements, blocking, allowed: !reason, reason }
}

export async function requireWordExportSnapshot(workspace: AppState, certificateId: string) {
  const { certificate, elements, allowed, reason } = wordExportReadiness(workspace, certificateId)
  if (!certificate || !allowed) throw new Error(reason)
  const account = sessionStorage.getItem('lawverify-login-account') || workspace.user.email
  if (await hasDocumentDraft(account, certificateId, certificate.paragraphs)) {
    throw new Error('文书有尚未保存的草稿，请返回工作台保存并重新核验。')
  }
  return { certificate, elements }
}

export function reviewReadiness(workspace: AppState, caseId: string, certificateId?: string) {
  const documents = workspace.certificates.filter(item => item.caseId === caseId && (!certificateId || item.id === certificateId))
  const paragraphs = documents.flatMap(doc => {
    const review = createParagraphReviewer(workspace, doc.id)
    return doc.paragraphs.filter(paragraph => paragraph.text.trim()).map(paragraph => {
      const elements = review(paragraph)
      const reviewed = doc.verification?.revision && elements.some(item => item.declaration)
        ? elements.every(item => item.verified || item.ignored) : paragraph.verified
      return { elements, reviewed }
    })
  })
  const unreviewed = paragraphs.filter(item => !item.reviewed).length
  const elements = paragraphs.flatMap(item => item.elements)
  const red = elements.filter(item => item.verdict === 'fail' || item.verdict === 'miss').length
  const empty = !documents.length || documents.some(doc => !doc.paragraphs.some(paragraph => paragraph.text.trim()))
  const pendingParsing = workspace.evidences.some(item => item.caseId === caseId && item.parsing && item.parsing.status !== 'ready')
  return { total: paragraphs.length, unreviewed, red, ready: !empty && !unreviewed && !elements.some(item => blocksWordExport(item.verdict))
    && !pendingParsing && !documents.some(item => item.verification?.dirty) }
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
