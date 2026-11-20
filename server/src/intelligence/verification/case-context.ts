import type { CaseDetail } from '../../integrations/legal-case.js'
import type { CaseVerification, Declaration } from './protocol.js'

type CaseDimensions = readonly [number, number, number, number, number]

export function classifyCaseSimilarity(dimensions: CaseDimensions) {
  if (dimensions.some(value => !Number.isFinite(value) || value < 0 || value > 1)) throw new Error('类案相似度各维度必须在 0 到 1 之间。')
  const weighted = dimensions[0] * 30 + dimensions[1] * 25 + dimensions[2] * 25 + dimensions[3] * 15 + dimensions[4] * 5
  return { score: weighted / 100, match: weighted < 50 ? 'irrelevant' : weighted >= 75 && dimensions[0] === 1 ? 'strict' : 'analogous' } as const
}

export const caseText = (value: string) => value.normalize('NFKC').replace(/\s/gu, '')
const relationPatterns = [
  ['借贷', /民间借贷|借贷关系|借款合同/u], ['买卖', /买卖合同|买卖关系|买卖价款/u],
  ['劳动', /劳动合同|劳动关系|劳动争议/u], ['侵权', /侵权责任|侵权纠纷|侵权关系/u],
] as const

function relation(value: string) {
  const matches = relationPatterns.filter(([, pattern]) => pattern.test(value))
  return matches.length === 1 ? matches[0][0] : undefined
}

function compareFeatures(expected: string[], actual: string) {
  if (!expected.length || !actual) return undefined
  return expected.filter(item => actual.includes(caseText(item))).length / expected.length
}

export function assessCaseContext(declaration: Declaration, item: CaseDetail, declarations: Declaration[], docKey?: string) {
  const earlierCases = new Set(declarations.filter(other => other.type === 'E-CASE' && other.id !== declaration.id).map(other => other.location.paragraphId))
  const before = declarations.filter(other => {
    if (!['E-FACT', 'E-FOCUS', 'E-PROC', 'E-CLAIM', 'E-LAW'].includes(other.type)) return false
    if (other.location.paragraphId === declaration.location.paragraphId) return other.location.end <= declaration.location.start
      && !declarations.some(earlier => earlier.type === 'E-CASE' && earlier.location.paragraphId === other.location.paragraphId
        && earlier.location.start < other.location.start)
    return other.location.paragraphIndex < declaration.location.paragraphIndex && !earlierCases.has(other.location.paragraphId)
  })
  const facts = before.filter(other => other.type === 'E-FACT')
  const corpus = (entries: Declaration[]) => caseText(entries.map(other => other.quote).join('\n'))
  const factual = corpus(facts)
  const issues = corpus(before.filter(other => other.type === 'E-FOCUS' || other.type === 'E-CLAIM'))
  const rules = corpus(before.filter(other => other.type === 'E-LAW' || other.type === 'E-FOCUS'))
  const all = corpus(before)
  const currentRelation = relation(`${factual}\n${issues}`)
  const targetRelation = relation(item.legal_relationship || item.cause || '')
  const relationScore = currentRelation && targetRelation ? Number(currentRelation === targetRelation) : undefined
  const stage = docKey === 'ss' ? '二审' : docKey === 'zs' ? '再审' : all.match(/(?:本案|程序)(?:为|处于)?(一审|二审|再审)/u)?.[1]
  const stageScore = stage && item.procedure ? Number(caseText(item.procedure) === stage) : undefined
  const scores = [relationScore, compareFeatures(item.issues, issues), compareFeatures(item.key_facts, factual),
    compareFeatures(item.rules, rules), stageScore] as const
  const fields = ['法律关系', '争议焦点', '关键事实', '裁判规则', '程序问题']
  const dimensions: NonNullable<CaseVerification['dimensions']> = scores.map((score, index) => ({ field: fields[index], score,
    reason: score === undefined ? '现案或详情缺少可核对内容。' : score === 1 ? '已匹配详情和现案声明。' : score === 0 ? '当前声明未匹配详情。' : '部分特征匹配。' }))
  const cause = item.cause ? Number(all.includes(caseText(item.cause)) || (relationScore === 1 && relation(item.cause) === currentRelation)) : undefined
  const accuracy = [all ? cause : undefined, compareFeatures(item.party_roles, factual), scores[2], scores[1]]
  const accuracyReason = ['案由', '主体', '关键事实', '争议'].map((field, index) => {
    const score = accuracy[index]
    return `${field}${score === undefined ? '待核' : score >= 0.5 ? '匹配' : '未匹配'}。`
  }).join('')
  const matched = accuracy.filter(score => score !== undefined && score >= 0.5).length
  const comparable = accuracy.filter(score => score !== undefined).length
  const similarity = scores.filter(score => score !== undefined).length >= 3
    ? classifyCaseSimilarity([scores[0] ?? 0, scores[1] ?? 0, scores[2] ?? 0, scores[3] ?? 0, scores[4] ?? 0]) : undefined
  const dependencies = facts.map(fact => ({ id: fact.id, check: 'C4' as const }))
  return { dimensions, matched, comparable, accuracyReason, similarity, dependencies }
}
