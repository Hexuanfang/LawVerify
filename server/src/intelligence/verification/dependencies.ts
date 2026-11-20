import type { CheckCode, CheckOutcome, Declaration } from './protocol.js'
import { reviewedVerdict } from './review-status.js'

const blocking = new Set(['fail', 'miss', 'pending'])
const severity: Record<CheckOutcome, number> = { fail: 5, miss: 4, pending: 3, warn: 2, pass: 1, 'not-applicable': 0 }

export function dependentDeclarationIds(declarations: Declaration[], changed: Iterable<string>) {
  const affected = new Set(changed)
  const consumers = new Map<string, string[]>()
  for (const item of declarations) for (const { id } of item.dependencies ?? []) {
    const ids = consumers.get(id) ?? []
    ids.push(item.id)
    consumers.set(id, ids)
  }
  for (const id of affected) for (const dependent of consumers.get(id) ?? []) affected.add(dependent)
  return affected
}

export function applyDeclarationDependencies(declarations: Declaration[]): Declaration[] {
  const indexed = new Map<string, Declaration[]>()
  const byId = new Map(declarations.map(declaration => [declaration.id, declaration]))
  const key = (item: Declaration) => item.location.sentenceIndex === undefined ? undefined : `${item.location.paragraphId}:${item.location.sentenceIndex}`
  for (const item of declarations) {
    const anchor = key(item)
    if (anchor === undefined) continue
    const group = indexed.get(anchor) ?? []
    group.push(item)
    indexed.set(anchor, group)
  }
  return declarations.map(item => {
    if (item.type !== 'E-LAW' && item.type !== 'E-CASE') return item
    const anchor = key(item)
    const group = anchor === undefined ? [] : indexed.get(anchor) ?? []
    const edges = [...(item.dependencies ?? []), ...group.flatMap<{ id: string; check: CheckCode }>(source => {
      if (source.id === item.id) return []
      if (source.type === 'E-FACT') return [{ id: source.id, check: item.type === 'E-LAW' ? 'B4' as const : 'C4' as const }]
      if (source.type === 'E-LAW' && item.type === 'E-CASE') return [{ id: source.id, check: 'C6' as const }]
      return []
    })]
    const dependencies = [...new Map(edges.map(edge => [`${edge.id}:${edge.check}`, edge])).values()]
    if (!dependencies.length) return item
    const checks = { ...item.checks }
    let { verdict, reason } = item
    let caseVerification = item.caseVerification
    for (const edge of dependencies) {
      const source = byId.get(edge.id)
      let adjustment: { outcome: 'pending' | 'warn'; reason: string } | undefined
      if ((edge.check === 'B4' || edge.check === 'C4') && (!source || blocking.has(reviewedVerdict(source)))) {
        adjustment = edge.check === 'B4'
          ? { outcome: 'pending', reason: '依赖事实待核验，重新检查法律适配。' }
          : { outcome: 'warn', reason: '依赖事实待核验，类案仅作近似参照。' }
      } else if (edge.check === 'C6' && (!source || source.checks.B2?.outcome !== 'pass')) {
        adjustment = { outcome: 'warn', reason: '依赖法条的效力未通过，类案仅作近似参照。' }
      }
      if (!adjustment) continue
      if (severity[adjustment.outcome] >= severity[checks[edge.check]?.outcome ?? 'not-applicable']) checks[edge.check] = adjustment
      if (severity[adjustment.outcome] > severity[verdict === 'note' ? 'pass' : verdict]) ({ outcome: verdict, reason } = adjustment)
      if (caseVerification?.match === 'strict' && (edge.check === 'C4' || edge.check === 'C6')) {
        caseVerification = { ...caseVerification, match: 'analogous' }
      }
    }
    if (caseVerification && blocking.has(verdict)) caseVerification = { ...caseVerification, allowCitation: false, counted: false }
    return { ...item, dependencies, checks, verdict, reason, ...(caseVerification && { caseVerification }) }
  })
}
