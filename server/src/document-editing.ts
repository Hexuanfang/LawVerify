import { z } from 'zod'
import { AppError } from './core/app-error.js'
import type { CertificateParagraph, EvidenceLink, ParagraphReference } from './domain.js'
import { runExclusiveWorkspaceMutation } from './infrastructure/workspace-lock.js'
import { getLinkageSentences } from './intelligence/linkage-policy.js'
import { readWorkspace, writeWorkspace } from './store.js'

const blockSchema = z.object({
  id: z.string().min(1).max(200),
  text: z.string().max(8_000_000),
  richText: z.string().max(16_000_000).optional(),
})
const contentSchema = z.object({
  paragraphs: z.array(blockSchema).min(1).max(10_000),
  expectedContent: z.array(blockSchema).max(10_000),
})
type ContentBlock = z.infer<typeof blockSchema>

function sameContent(left: ContentBlock[], right: ContentBlock[]) {
  return left.length === right.length && left.every((item, index) => {
    const other = right[index]
    return item.id === other.id && item.text === other.text && item.richText === other.richText
  })
}

function rebuildParagraphs(current: CertificateParagraph[], blocks: ContentBlock[]) {
  const originals = new Map(current.map(paragraph => [paragraph.id, paragraph]))
  const next = blocks.map(block => {
    const original = originals.get(block.id)
    if (original?.text === block.text) return { ...original, ...block }
    return {
      id: block.id, text: block.text, richText: block.richText,
      note: original?.note, verified: false, links: [], references: [],
    } satisfies CertificateParagraph
  })
  const before = current.flatMap(paragraph => getLinkageSentences(paragraph.text))
  const after = next.flatMap(paragraph => getLinkageSentences(paragraph.text)
    .map(sentence => ({ ...sentence, paragraph })))
  const oldCounts = new Map<string, number>()
  const destinations = new Map<string, typeof after>()
  for (const sentence of before) oldCounts.set(sentence.sentenceText, (oldCounts.get(sentence.sentenceText) ?? 0) + 1)
  for (const sentence of after) {
    const matches = destinations.get(sentence.sentenceText) ?? []
    matches.push(sentence)
    destinations.set(sentence.sentenceText, matches)
  }
  const relocate = (paragraph: CertificateParagraph, source: EvidenceLink | ParagraphReference) => {
    if (source.sentenceIndex === undefined) return null
    const sentence = getLinkageSentences(paragraph.text)[source.sentenceIndex]
    if (!sentence || (source.sentenceText && source.sentenceText !== sentence.sentenceText)) return null
    const matches = destinations.get(sentence.sentenceText)
    if (oldCounts.get(sentence.sentenceText) !== 1 || matches?.length !== 1) return null
    return matches[0]
  }
  for (const original of current) {
    if (next.some(paragraph => paragraph.id === original.id && paragraph.text === original.text)) continue
    for (const link of original.links?.length ? original.links : original.link ? [original.link] : []) {
      const target = relocate(original, link)
      if (target) {
        target.paragraph.links ??= []
        target.paragraph.links.push({ ...link, sentenceIndex: target.sentenceIndex, sentenceText: target.sentenceText })
        target.paragraph.link = target.paragraph.links[0]
      }
    }
    for (const reference of original.references ?? []) {
      const target = relocate(original, reference)
      if (target) {
        target.paragraph.references ??= []
        target.paragraph.references.push({ ...reference, sentenceIndex: target.sentenceIndex, sentenceText: target.sentenceText })
      }
    }
  }
  return next
}

export async function saveDocumentContent(certificateId: string, input: unknown) {
  const { paragraphs, expectedContent } = contentSchema.parse(input)
  const ids = new Set(paragraphs.map(paragraph => paragraph.id))
  if (ids.size !== paragraphs.length) throw new AppError('文书包含重复段落标识，请重新打开编辑器。', 400, 'DUPLICATE_PARAGRAPH_ID')
  return runExclusiveWorkspaceMutation(async () => {
    const workspace = await readWorkspace()
    const certificate = workspace.certificates.find(item => item.id === certificateId)
    if (!certificate) throw new AppError('文书已不存在，本机草稿已保留。', 404, 'DOCUMENT_NOT_FOUND')
    const current = certificate.paragraphs
    // 网络重试已经成功的提交时，保留后来产生的引用与审阅记录。
    if (sameContent(current, paragraphs)) return { workspace }
    if (!sameContent(current, expectedContent)) {
      throw new AppError('正文已有更新，本机草稿已保留。请对照最新版本后再保存。', 409, 'DOCUMENT_CONFLICT')
    }
    const otherIds = new Set(workspace.certificates.filter(item => item.id !== certificateId)
      .flatMap(item => item.paragraphs.map(paragraph => paragraph.id)))
    if (paragraphs.some(paragraph => otherIds.has(paragraph.id))) {
      throw new AppError('段落标识与其他文书重复，请重新打开编辑器。', 400, 'PARAGRAPH_ID_CONFLICT')
    }
    const textChanged = current.length !== paragraphs.length || current.some((paragraph, index) =>
      paragraph.id !== paragraphs[index]?.id || paragraph.text !== paragraphs[index]?.text)
    certificate.paragraphs = rebuildParagraphs(current, paragraphs)
    certificate.paragraphIds = certificate.paragraphs.map(paragraph => paragraph.id)
    if (textChanged) {
      certificate.linkageStale = true
      const caseFolder = workspace.cases.find(item => item.id === certificate.caseId)
      if (caseFolder?.status === 'ready') caseFolder.status = 'in_review'
    }
    await writeWorkspace(workspace)
    return { workspace: await readWorkspace() }
  })
}
