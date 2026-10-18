import type { EvidenceInsight } from './types'

export function getAttentionGroups(insight: EvidenceInsight) {
  const seen = new Set<string>()
  return [
    { label: '证明目的', tone: 'proof', items: insight.proofPurposes ?? [] },
    { label: '争议与矛盾', tone: 'risk', items: insight.disputedPoints ?? [] },
    { label: '证明局限与待核验', tone: 'risk', items: [...(insight.proofLimitations ?? []), ...insight.issues] },
    { label: '关键事实', tone: 'fact', items: insight.keyFacts },
    { label: '主张与立场', tone: 'fact', items: insight.positions },
  ].map((group) => ({
    ...group,
    items: group.items.filter((item) => {
      const key = item.trim()
      if (!key || seen.has(key)) return false
      seen.add(key)
      return true
    }),
  })).filter((group) => group.items.length)
}

export function getAttentionTerms(insight?: EvidenceInsight) {
  if (!insight || insight.status !== 'ready') return []
  const details = [...insight.amounts, ...insight.timelineEvents].join('\n')
  const tokens = details.match(
    /[¥￥]?\d[\d,]*(?:\.\d+)?\s*(?:万|亿)?元|[一二三四五六七八九十百千万亿两]+元|\d{4}[-/.年]\d{1,2}(?:[-/.月]\d{1,2}日?)?|\d{1,2}月\d{1,2}日/g,
  ) ?? []
  return [...new Set([
    ...(insight.keyExcerpts ?? []).map((item) => item.quote),
    ...insight.amounts,
    ...tokens,
    ...insight.entities,
  ].map((item) => item.trim()).filter((item) => item.length >= 2))]
    .sort((a, b) => b.length - a.length).slice(0, 60)
}

// Match only text actually present, with longest overlapping quotations taking priority.
export function splitAttentionText(text: string, terms: string[]) {
  const candidates: { start: number; end: number }[] = []
  for (const term of [...new Set(terms)].filter(Boolean).sort((a, b) => b.length - a.length)) {
    let start = text.indexOf(term)
    while (start !== -1) {
      const end = start + term.length
      if (!candidates.some((item) => start < item.end && end > item.start)) {
        candidates.push({ start, end })
      }
      start = text.indexOf(term, end)
    }
  }
  candidates.sort((a, b) => a.start - b.start)
  const parts: { text: string; highlighted: boolean }[] = []
  let cursor = 0
  for (const match of candidates) {
    if (match.start > cursor) parts.push({ text: text.slice(cursor, match.start), highlighted: false })
    parts.push({ text: text.slice(match.start, match.end), highlighted: true })
    cursor = match.end
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), highlighted: false })
  return parts
}
