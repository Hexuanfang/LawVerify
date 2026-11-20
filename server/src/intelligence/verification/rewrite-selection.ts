export interface RewriteSelection {
  paragraphId: string
  start: number
  quote: string
}

export function locateRewriteSelection<T extends { id: string; text: string }>(paragraphs: T[], input: unknown): T {
  if (!input || typeof input !== 'object') throw new Error('请提供正文选区。')
  const { paragraphId, start, quote } = input as Partial<RewriteSelection>
  if (typeof paragraphId !== 'string' || typeof start !== 'number' || !Number.isSafeInteger(start) || start < 0
    || typeof quote !== 'string' || !quote.trim() || quote.length > 1000) throw new Error('正文选区无效。')
  const paragraph = paragraphs.find(item => item.id === paragraphId)
  if (!paragraph || paragraph.text.slice(start, start + quote.length) !== quote) throw new Error('正文选区已变化，请重新选择。')
  return paragraph
}

const protectedFields = /\(\d{4}\)[^\s,。;:]{2,36}?\d+号|《[^》]+》|第[零〇一二三四五六七八九十百千万两\d]+[条款项]|\d{4}[年./-]\d{1,2}[月./-]\d{1,2}日?|[零〇一二三四五六七八九十百千万两]+(?:年|月|日|元|%|％)|[-−]?\d[\d,]*\d(?:\.\d+)?(?:\s*(?:万元|元|年|月|日|天|%|‰))?|[-−]?\d(?:\.\d+)?(?:\s*(?:万元|元|年|月|日|天|%|‰))?/gu
const invariants = (text: string) => [...text.normalize('NFKC').matchAll(protectedFields)].map(match => match[0].replace(/\s/gu, ''))

export function validateRewritePreview(original: string, paragraphs: Array<{ text: string }>) {
  const text = paragraphs[0]?.text.trim()
  if (paragraphs.length !== 1 || !text || /[\r\n]/u.test(text) || text.length > 2000) throw new Error('选区改写必须返回一段非空单段文本。')
  if (JSON.stringify(invariants(original)) !== JSON.stringify(invariants(text))) throw new Error('改写改变了数字、日期、条号或案号等保护字段，未保存。')
  return text
}
