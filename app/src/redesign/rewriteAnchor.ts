import type { Certificate, CertificateParagraph } from '../types'
import type { RewriteSelection } from '../../../server/src/intelligence/verification/rewrite-selection'
import { richTextIndex } from './richTextIndex.ts'

export type RewriteAnchor = {
  id: string
  certificateId: string
  paragraphId: string
  start: number
  end: number
  quote: string
  original: CertificateParagraph
}

export function rewriteAnchor(certificate: Pick<Certificate, 'id' | 'paragraphs'> | undefined, quote?: string, known?: RewriteSelection): RewriteAnchor | undefined {
  if (!certificate || !quote?.trim() || quote.length > 1000) return undefined
  if (known?.quote === quote) {
    const original = certificate.paragraphs.find(paragraph => paragraph.id === known.paragraphId)
    const end = known.start + quote.length
    if (!original || original.text.slice(known.start, end) !== quote) return undefined
    return { ...known, id: `${certificate.id}:${original.id}:${known.start}:${end}:rewrite`, end, certificateId: certificate.id, original }
  }
  let anchor: RewriteAnchor | undefined
  for (const paragraph of certificate.paragraphs) {
    const start = paragraph.text.indexOf(quote)
    if (start < 0) continue
    if (anchor || paragraph.text.indexOf(quote, start + 1) >= 0) return undefined
    const end = start + quote.length
    anchor = { id: `${certificate.id}:${paragraph.id}:${start}:${end}:rewrite`, certificateId: certificate.id,
      paragraphId: paragraph.id, start, end, quote, original: paragraph }
  }
  return anchor
}

export function lastSelectedAnchor(body: Element, range: Range, certificate?: Pick<Certificate, 'paragraphs'>): RewriteSelection | undefined {
  const byId = new Map(certificate?.paragraphs.map(paragraph => [paragraph.id, paragraph]))
  for (const block of Array.from(body.children).reverse()) {
    if (!range.intersectsNode(block)) continue
    const paragraph = byId.get(block.getAttribute('data-lawverify-id') ?? '')
    if (!paragraph) return undefined
    let index = richTextIndex(block)
    if (index.text !== paragraph.text) index = richTextIndex(block, false)
    if (index.text !== paragraph.text) return undefined
    const selected = index.segments.flatMap(segment => {
      if (!segment.node || !range.intersectsNode(segment.node)) return []
      const start = segment.start + (range.startContainer === segment.node ? range.startOffset : 0)
      const end = range.endContainer === segment.node ? segment.start + range.endOffset : segment.end
      return start < end ? [{ start, end }] : []
    })
    if (!selected.length) continue
    const end = selected.at(-1)!.end
    const raw = index.text.slice(Math.max(selected[0].start, end - 1000), end)
    const quote = raw.trim()
    if (quote) return { paragraphId: paragraph.id, start: end - raw.length + raw.indexOf(quote), quote }
  }
}
