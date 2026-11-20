import type { Declaration, VerificationVerdict } from './protocol.js'

export function mayConfirmDeclaration(item: Declaration) {
  if (item.verdict === 'fail' || item.verdict === 'miss'
    || Object.values(item.checks).some(check => check.outcome === 'fail' || check.outcome === 'miss')) return false
  const tier = item.type === 'E-LAW' ? 'l2' : item.type === 'E-CASE' ? 'l3' : 'l1'
  return item.sources.some(source => source.tier === tier && source.quote?.trim() && source.locator?.trim())
}

export function reviewedVerdict(item: Declaration): VerificationVerdict {
  if (item.verdict === 'fail' || item.verdict === 'miss') return item.verdict
  if (item.review?.decision === 'rejected') return 'pending'
  if (item.review?.decision === 'confirmed' && item.verdict === 'pending' && mayConfirmDeclaration(item)) return 'note'
  return item.verdict
}

export function quotedStatuteText(value: string) {
  return /^\s*(?:[：:,，]|规定|载明|指出|判决|裁定)*\s*[“‘「"]([^”’」"]+)[”’」"]/u.exec(value)
}

export function declarationEditRange(text: string, item: Declaration, action: 'adopt' | 'delete') {
  const { start, end } = item.location
  if (start < 0 || end <= start || text.slice(start, end) !== item.quote) return undefined
  if (action === 'delete') return item.verdict === 'miss' ? { start, end, replacement: '' } : undefined
  if (!item.verifiedText?.trim() || !item.verifiedSources?.some(source => source.quote?.trim() && source.locator?.trim())) return undefined
  // 条号声明通常止于条号，既有引号中的原文与本次替换一起处理。
  const cited = item.type === 'E-LAW' ? quotedStatuteText(text.slice(end))?.[0] : undefined
  return { start, end: end + (cited?.length ?? 0), replacement: item.verifiedText }
}
