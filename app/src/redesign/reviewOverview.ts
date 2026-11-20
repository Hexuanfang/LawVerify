import type { ReviewElement, Source } from './model'
import type { AppState } from '../types'

export function groupReview(elements: ReviewElement[]) {
  const required: ReviewElement[] = []
  const pending: ReviewElement[] = []
  const warnings: ReviewElement[] = []
  const passed: ReviewElement[] = []
  for (const element of elements) {
    if (element.verdict === 'fail' || element.verdict === 'miss') required.push(element)
    else if (element.verdict === 'pending') pending.push(element)
    else if (element.verdict === 'warn') warnings.push(element)
    else passed.push(element)
  }
  const todo = [...required, ...pending, ...warnings.filter(item => !item.ignored)]
  return {
    required, pending, warnings, passed,
    annotated: elements.filter(element => element.note.trim()),
    todo,
    processed: elements.length - todo.length,
  }
}

export function documentBadge(elements: ReviewElement[]) {
  if (!elements.length) return null
  const { required, pending, warnings } = groupReview(elements)
  const count = required.length + pending.length
  if (count) return { tone: 'fail', count, label: `${count} 项待处理` }
  if (warnings.some(item => !item.ignored)) return { tone: 'warn', count: 0, label: '有预警' }
  return { tone: 'pass', count: 0, label: '核验项已处理' }
}

type AuthorityLocation = { source: Source; manual: boolean; mcp: boolean }

export function linkedAuthorities(elements: ReviewElement[], workspace?: Pick<AppState, 'knowledgeCases' | 'knowledgeStatutes'>) {
  const statuteTargets = new Map(workspace?.knowledgeStatutes.flatMap(law => [
    [law.id, { law, article: '' }] as const,
    ...law.articles.map(article => [article.id, { law, article: article.articleNumber }] as const),
  ]))
  const caseTargets = new Map(workspace?.knowledgeCases.flatMap(entry => [
    [entry.id, entry] as const, ...(entry.excerpts ?? []).map(excerpt => [excerpt.id, entry] as const),
  ]))
  const groups = new Map<string, { tier: 'l2' | 'l3'; name: string; version?: string; locations: Map<string, AuthorityLocation> }>()
  for (const element of elements) {
    for (const source of element.sources) {
      if (source.st === 'l1' || !source.targetId) continue
      const statute = source.st === 'l2' ? statuteTargets.get(source.targetId) : undefined
      const entry = source.st === 'l3' ? caseTargets.get(source.targetId) : undefined
      const judgment = source.st === 'l3' ? element.caseVerification?.documents?.find(item => item.id === source.targetId) : undefined
      const number = (judgment?.caseNumber || entry?.caseNumber)?.normalize('NFKC').replace(/[〔【]/gu, '(').replace(/[〕】]/gu, ')').replace(/\s/gu, '')
      const key = JSON.stringify(statute ? ['l2', statute.law.title, statute.law.issuer, statute.law.version,
        statute.law.effectiveDate, statute.article || source.loc] : [source.st, number || source.targetId])
      const group = groups.get(key) ?? { tier: source.st, name: source.name, version: statute?.law.version, locations: new Map() }
      const locationKey = JSON.stringify([source.loc, source.quote])
      const previous = group.locations.get(locationKey)
      const manual = source.reason === '人工挂靠出处' || Boolean(element.original.references?.some(reference =>
        reference.reason === '人工挂靠出处' && reference.targetId === source.targetId && (reference.locator ?? '') === source.loc
        && (reference.sentenceIndex === undefined || reference.sentenceIndex === element.sentenceIndex)))
      const mcp = /MCP/iu.test(`${entry?.sourceType ?? ''} ${judgment?.provider ?? ''}`)
      group.locations.set(locationKey, { source: previous?.source ?? source, manual: manual || !!previous?.manual, mcp: mcp || !!previous?.mcp })
      groups.set(key, group)
    }
  }
  return [...groups].map(([id, group]) => ({ ...group, id, locations: [...group.locations.values()] }))
}
