import type { KnowledgeStatuteDocument } from '../types'

export type LibraryRow = {
  key: string
  id: string
  title: string
  description: string
  meta: string
  badge: string
  badgeStyle: string
}

function* lawRows(statutes: KnowledgeStatuteDocument[], query: string): Generator<LibraryRow> {
  const keyword = query.trim().toLowerCase()
  for (const [documentIndex, document] of statutes.entries()) {
    for (const [articleIndex, article] of document.articles.entries()) {
      const title = `${document.title} ${article.articleNumber}`
      const description = article.plainText || article.content || '—'
      if (keyword && !`${title}\n${description}`.toLowerCase().includes(keyword)) continue
      yield {
        // 导入数据可能复用条文 ID，用文档与位置区分每一行。
        key: JSON.stringify(['law', document.id, documentIndex, article.id, articleIndex]),
        id: article.id,
        title,
        description,
        meta: `${document.issuer} · 施行 ${document.effectiveDate || '未提供'}`,
        badge: document.effectiveStatus === 'effective' ? '现行有效' : document.effectiveStatus === 'repealed' ? '已废止' : '已修正',
        badgeStyle: document.effectiveStatus === 'effective' ? 'ok' : document.effectiveStatus === 'repealed' ? 'bad' : 'warn',
      }
    }
  }
}

export function createLawCursor(statutes: KnowledgeStatuteDocument[], query: string) {
  return { iterator: lawRows(statutes, query), next: null as LibraryRow | null }
}
export type LawCursor = ReturnType<typeof createLawCursor>

export function readLawBatch(cursor: LawCursor, size = 40) {
  const rows: LibraryRow[] = []
  if (cursor.next) { rows.push(cursor.next); cursor.next = null }
  while (rows.length < size) {
    const entry = cursor.iterator.next()
    if (entry.done) return { rows, hasMore: false }
    rows.push(entry.value)
  }
  const following = cursor.iterator.next()
  cursor.next = following.done ? null : following.value
  return { rows, hasMore: Boolean(cursor.next) }
}

export function sameLawRows(left: KnowledgeStatuteDocument[], right: KnowledgeStatuteDocument[]) {
  return left === right || (left.length === right.length && left.every((document, index) => {
    const other = right[index]
    return document === other || (document.id === other.id && document.title === other.title
      && document.issuer === other.issuer && document.effectiveDate === other.effectiveDate
      && document.effectiveStatus === other.effectiveStatus && document.articles.length === other.articles.length
      && document.articles.every((article, articleIndex) => {
        const candidate = other.articles[articleIndex]
        return article === candidate || (article.id === candidate.id && article.articleNumber === candidate.articleNumber
          && article.plainText === candidate.plainText && article.content === candidate.content)
      }))
  }))
}
