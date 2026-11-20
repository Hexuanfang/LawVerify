import type { Certificate, CertificateParagraph } from '../types'

export type RewriteAnchor = {
  id: string
  certificateId: string
  paragraphId: string
  start: number
  end: number
  quote: string
  original: CertificateParagraph
}

export function rewriteAnchor(certificate: Pick<Certificate, 'id' | 'paragraphs'> | undefined, quote?: string): RewriteAnchor | undefined {
  if (!certificate || !quote?.trim() || quote.length > 1000) return undefined
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
