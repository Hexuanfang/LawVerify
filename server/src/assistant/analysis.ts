import type { Certificate, Evidence, EvidenceFragment, EvidenceRiskKind, WorkspaceState } from '../domain.js'
import { linkageMaterialFingerprint, type CasePosition } from '../intelligence/case-agent.js'
import { scanEvidenceRisks } from '../intelligence/evidence-risk-scan.js'
import { getLinkageSentences } from '../intelligence/linkage-policy.js'
import { applyDeclarationDependencies } from '../intelligence/verification/dependencies.js'
import { verifyEvidenceDeclarations } from '../intelligence/verification/evidence.js'
import { extractDeclarations } from '../intelligence/verification/extract.js'
import type { Declaration, DeclarationSource, VerificationCalculation } from '../intelligence/verification/protocol.js'
import { validateSkillOutput } from './skill-contract.js'

const analysisSkillIds = ['evidence', 'chain', 'calc', 'risk', 'focus', 'timeline'] as const
export type AnalysisSkillId = typeof analysisSkillIds[number]

export interface AnalysisInput {
  workspace: Pick<WorkspaceState, 'evidences' | 'evidenceFragments' | 'evidenceInsights' | 'caseContextMemories'>
  caseId: string
  certificate?: Certificate
  materialIds?: readonly string[]
  position?: CasePosition
}

type TimelineEvent = { date: string | null; event: string; material: string; loc: string; status: 'recorded' | 'pending' }
type CardStatus = 'ready' | 'pending'
type BaseCard = { type: 'analysis-card'; status: CardStatus }
type AnalysisFields = {
  evidence: { authenticity: string[]; legality: string[]; relevance: string[]; probative: string[]; reinforce: string[] }
  chain: { breaks: string[] }
  calc: { formula: string[]; inputs: string[]; result: string[] }
  risk: { risks: string[]; actions: string[] }
  focus: { ourIssues: string[]; theirIssues: string[]; shared: string[] }
  timeline: { events: TimelineEvent[] }
}
export type AnalysisOutput = BaseCard & AnalysisFields[AnalysisSkillId]
type MaterialInput = { material: Evidence; fragments: EvidenceFragment[] }
type AnalysisContext = { materials: MaterialInput[]; certificate?: Certificate; declarations: Declaration[]; stale: boolean; position?: CasePosition }

export function isAnalysisSkill(id: string): id is AnalysisSkillId {
  return analysisSkillIds.some(skill => skill === id)
}

function makeCard<T extends AnalysisFields[AnalysisSkillId]>(status: CardStatus, fields: T): BaseCard & T {
  return { ...fields, type: 'analysis-card', status }
}

const materialName = ({ name, fileName }: Evidence) => name.trim() || fileName
const loc = ({ location }: Declaration) => `第${location.paragraphIndex + 1}段${location.sentenceIndex === undefined ? '' : `第${location.sentenceIndex + 1}句`}`
const short = (value: string) => value.trim().length > 180 ? `${value.trim().slice(0, 180)}…` : value.trim()
const unique = (values: string[]) => [...new Set(values)].slice(0, 40)
const unresolved = (value: string) => ['warn', 'fail', 'miss', 'pending'].includes(value)

function buildContext({ workspace, caseId, certificate, materialIds, position }: AnalysisInput, needsDeclarations: boolean): AnalysisContext {
  const selected = materialIds === undefined ? undefined : new Set(materialIds)
  const allMaterials = workspace.evidences.filter(material => material.caseId === caseId)
  const evidences = allMaterials.filter(material => !selected || selected.has(material.id))
  const ids = new Set(evidences.map(material => material.id))
  const evidenceFragments = workspace.evidenceFragments.filter(fragment => fragment.caseId === caseId && ids.has(fragment.evidenceId))
  const allInsights = workspace.evidenceInsights.filter(insight => insight.caseId === caseId)
  const evidenceInsights = allInsights.filter(insight => ids.has(insight.evidenceId))
  const grouped = new Map<string, EvidenceFragment[]>()
  for (const fragment of evidenceFragments) {
    const fragments = grouped.get(fragment.evidenceId) ?? []
    fragments.push(fragment)
    grouped.set(fragment.evidenceId, fragments)
  }
  const materials = evidences.filter(material => !material.duplicateOf || !ids.has(material.duplicateOf))
    .map(material => ({ material, fragments: (grouped.get(material.id) ?? []).sort((a, b) => a.sequence - b.sequence) }))
  const current = certificate?.caseId === caseId ? certificate : undefined
  const stale = Boolean(current?.linkageStale || (current?.linkageInputKey
    && current.linkageInputKey !== linkageMaterialFingerprint(allMaterials, allInsights)))
  const context = { materials, certificate: current, stale, position, declarations: [] as Declaration[] }
  if (!current || !needsDeclarations) return context

  const stored = current.verification?.declarations
  if (stored && !stale && stored.every(item => item.sources.every(source => source.tier !== 'l1' || ids.has(source.id)))) {
    return { ...context, declarations: stored }
  }
  const extracted = extractDeclarations(current).declarations
  return { ...context, declarations: verifyEvidenceDeclarations(current, extracted, { evidences, evidenceFragments, evidenceInsights }) }
}

function textSources({ material, fragments }: MaterialInput) {
  if (material.parsing && material.parsing.status !== 'ready') return []
  const excerpts = fragments.filter(fragment => fragment.text.trim())
  if (excerpts.length) return excerpts.map(fragment => ({ text: fragment.text, loc: fragment.locator || `片段 ${fragment.sequence}` }))
  return material.ocrText.trim() ? [{ text: material.ocrText, loc: material.anchorHint?.trim() || '' }] : []
}

function materialSentences(item: MaterialInput) {
  return textSources(item).flatMap(excerpt => getLinkageSentences(excerpt.text).map(({ sentenceText, sentenceIndex }) => ({
    text: sentenceText, loc: excerpt.loc || `第${sentenceIndex + 1}句`, material: materialName(item.material),
  })))
}

const riskActions: Record<EvidenceRiskKind, string> = {
  'limitation-deadline': '补充通知原件与送达回证，核对起算日和期限。',
  'evidence-form': '核对材料形成与取得方式，补充所需的书面材料、认证或鉴定文件。',
  'original-missing': '补充原件、原始电子文件或原始设备，核对现有副本。',
  'signature-seal': '调取签章页和授权文件，核对签署人及签章。',
  'page-continuity': '调取完整原件并逐页核对页码和附件。',
  'delivery-address': '补充经确认的送达地址和相应送达回证。',
  'party-identity': '补充主体身份和授权材料，核对与文书记载是否一致。',
}

function evidenceCard({ materials, declarations, stale }: AnalysisContext) {
  const authenticity: string[] = []
  const legality: string[] = []
  const relevance: string[] = []
  const probative: string[] = []
  const reinforce: string[] = []
  for (const item of materials) {
    const name = materialName(item.material)
    const excerpts = textSources(item)
    const findings = scanEvidenceRisks(excerpts.map(excerpt => excerpt.text).join('\n'))
    const original = findings.some(finding => finding.kind === 'original-missing')
    const carrier = item.material.storageKey || item.material.sourceDataUrl
    authenticity.push(`${name}：${original || !carrier ? '原始载体待核。' : '系统已存材料文件，仍待比对原始载体及形成记录。'}`)
    legality.push(`${name}：${findings.find(finding => finding.kind === 'evidence-form')?.message ?? '来源、取得方式及提交形式待核。'}`)
    const linked = declarations.filter(declaration => declaration.sources.some(source => source.tier === 'l1' && source.id === item.material.id))
    relevance.push(...(linked.length ? linked.map(declaration => `${name}：已关联${loc(declaration)}「${short(declaration.quote)}」。`)
      : [`${name}：尚无可定位的关联声明，证明对象待核。`]))
    probative.push(...(linked.length ? linked.map(declaration => `${name} · ${loc(declaration)}：${stale || unresolved(declaration.verdict) ? '待核，' : ''}${declaration.reason}`)
      : [`${name}：${excerpts.length ? '证明范围待与其他材料交叉核对。' : '缺可回查原文，证明力待核。'}`]))
    reinforce.push(`${name}：${riskActions['original-missing']}`)
    reinforce.push(...findings.filter(finding => finding.kind !== 'original-missing').map(finding => `${name}：${riskActions[finding.kind]}`))
  }
  return makeCard('pending', {
    authenticity: unique(authenticity.length ? authenticity : ['缺少卷内材料，真实性待核。']),
    legality: unique(legality), relevance: unique(relevance), probative: unique(probative),
    reinforce: unique(reinforce.length ? reinforce : ['补充原始载体和拟证明事实。']),
  })
}

function chainCard({ certificate, declarations, stale }: AnalysisContext) {
  const relevant = declarations.filter(item => ['E-FACT', 'E-LAW', 'E-CASE', 'E-CLAIM'].includes(item.type))
  const checked = applyDeclarationDependencies(relevant)
  const byId = new Map(checked.map(item => [item.id, item]))
  const labels: Record<string, string> = { 'E-FACT': '事实', 'E-LAW': '法条', 'E-CASE': '案例', 'E-CLAIM': '主张' }
  const breaks: string[] = []
  if (stale) breaks.push('原有联动结果已过期，待重新核验论证依据。')
  for (const item of checked) {
    const prefix = `${loc(item)}${labels[item.type]}「${short(item.quote)}」`
    if (item.type !== 'E-CLAIM' && unresolved(item.verdict)) breaks.push(`${prefix}：${item.verdict === 'fail' ? '核验未通过' : '待核'}。${item.reason}`)
    for (const edge of item.dependencies ?? []) {
      const source = byId.get(edge.id)
      if (edge.check === 'C6' ? source?.checks.B2?.outcome === 'pass' && !unresolved(source.verdict) : source && !unresolved(source.verdict)) continue
      if (edge.check === 'B4') breaks.push(`${prefix}：上游事实未通过核对，重新核对法条适配。`)
      if (edge.check === 'C4' || edge.check === 'C6') breaks.push(`${prefix}：上游${edge.check === 'C6' ? '法条' : '事实'}未通过核对，重新核对类案命中。`)
    }
    if (item.type === 'E-CLAIM' && !checked.some(candidate => candidate.location.paragraphId === item.location.paragraphId && ['E-FACT', 'E-LAW', 'E-CASE'].includes(candidate.type))) {
      breaks.push(`${prefix}：本段尚未定位对应事实或法律依据，待核对文书中其他段落的支撑关系。`)
    }
  }
  if (!checked.length) breaks.push(certificate ? '当前文书尚无可定位的论证锚点。' : '待选择待查文书，定位事实、法条、案例与主张。')
  return makeCard(breaks.length ? 'pending' : 'ready', { breaks: unique(breaks) })
}

function sourceText(value: string) {
  return value.normalize('NFKC').replace(/\s/gu, '')
}

function currentSource(source: DeclarationSource, materials: MaterialInput[]) {
  if (source.tier !== 'l1' || !source.quote?.trim() || !source.locator?.trim()) return false
  const material = materials.find(item => item.material.id === source.id)
  if (!material) return false
  const quote = sourceText(source.quote)
  const version = material.material.contentHash ?? material.material.sourceFingerprint
  if (source.version && source.version !== version) return false
  return textSources(material).some(excerpt => (!material.fragments.length || excerpt.loc === source.locator) && sourceText(excerpt.text).includes(quote))
}

function formatCalculation(calculation: VerificationCalculation) {
  if (calculation.kind === 'trade-balance') {
    const { total, paid } = calculation
    const toCents = (amount: number) => Math.round(amount * 100)
    if (!(paid >= 0 && total >= paid && Number.isSafeInteger(toCents(total)))) return undefined
    return { formula: `${total}元 − ${paid}元`, inputs: `货款总额 ${total}元，累计实付 ${paid}元`, amount: (toCents(total) - toCents(paid)) / 100 }
  }
  const { principal, rate, days, annualDays } = calculation
  const cents = Math.round(principal * rate * days * 100 / annualDays)
  if (!(principal > 0 && rate >= 0 && Number.isSafeInteger(days) && days > 0 && [360, 365, 366].includes(annualDays) && Number.isSafeInteger(cents))) return undefined
  const percent = Number((rate * 100).toPrecision(15))
  return { formula: `${principal}元 × ${percent}% × ${days}天 ÷ ${annualDays}天`, inputs: `本金 ${principal}元，年利率 ${percent}%，期间 ${days}天，年化基准 ${annualDays}天`, amount: cents / 100 }
}

const materialInterestFormula = /(?<![\d.,+−-])(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?\s*(万)?元\s*[×xX*]\s*(\d+(?:\.\d+)?)\s*%\s*[×xX*]\s*(\d+)\s*[天日]\s*[÷/]\s*(360|365|366)(?![\d.])(?:\s*[天日])?/gu
const statedInterest = /^\s*(?:=|合计|共计|计为)\s*(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?\s*(万)?元/u

function materialCalculations(materials: MaterialInput[]) {
  const formula: string[] = []
  const inputs: string[] = []
  const result: string[] = []
  const seen = new Set<string>()
  const money = (whole: string, decimals?: string, unit?: string) => Number(whole.replace(/,/gu, '') + (decimals ?? '')) * (unit ? 10_000 : 1)
  for (const item of materials) for (const sentence of materialSentences(item)) {
    const text = sentence.text.normalize('NFKC')
    for (const match of text.matchAll(materialInterestFormula)) {
      const [, whole, decimals, unit, rate, days, annualDays] = match
      const details = formatCalculation({ principal: money(whole, decimals, unit), rate: Number(rate) / 100, days: Number(days), annualDays: Number(annualDays), amount: 0 })
      if (!details) continue
      const statement = statedInterest.exec(text.slice(match.index + match[0].length))
      const stated = statement ? money(statement[1], statement[2], statement[3]) : undefined
      const key = JSON.stringify([item.material.id, details.formula, stated])
      if (seen.has(key)) continue
      seen.add(key)
      const difference = stated !== undefined && Math.round(stated * 100) !== Math.round(details.amount * 100)
      formula.push(details.formula)
      inputs.push(`${details.inputs}。出处：${sentence.material} · ${sentence.loc}。`)
      result.push(`${details.amount}元${difference ? `，与材料列示的${stated}元不符` : ''}，待对照卷内流水。`)
      if (formula.length === 40) return { formula, inputs, result }
    }
  }
  return { formula, inputs, result }
}

function calculationCard({ declarations, materials, stale, certificate }: AnalysisContext) {
  if (!certificate) {
    const standalone = materialCalculations(materials)
    if (standalone.formula.length) return makeCard('pending', standalone)
  }
  const formula: string[] = []
  const inputs: string[] = []
  const result: string[] = []
  let pending = stale
  for (const item of declarations.filter(item => item.type === 'E-CALC').slice(0, 40)) {
    const calculation = item.calculation
    const sources = calculation?.sources?.filter(source => currentSource(source, materials)) ?? []
    const details = calculation && sources.length && formatCalculation(calculation)
    if (!details || stale) {
      pending = true
      formula.push(`${loc(item)}：待核对材料中的完整算式。`)
      inputs.push(`${loc(item)}：待补可回查的金额、利率、期间及约定计息方式，或结算总额和实付记录。`)
      result.push(`${loc(item)}：条件不足，结果待核。`)
      continue
    }
    const differences = (item.differences ?? []).map(difference => `${difference.field}：正文 ${difference.document}，出处 ${difference.source}`)
    formula.push(details.formula)
    inputs.push(`${details.inputs}。出处：${sources.map(source => `${source.name} · ${source.locator}`).join('、')}。`)
    result.push(`${details.amount}元${differences.length ? `，有差异待核（${differences.join('；')}）` : unresolved(item.verdict) ? '，核对状态待确认' : ''}。`)
    pending ||= unresolved(item.verdict) || differences.length > 0
  }
  if (!formula.length) return makeCard('pending', { formula: ['未找到具备计算条件的算式。'], inputs: ['待补载明计算条件的卷内材料。'], result: ['条件不足，结果待核。'] })
  return makeCard(pending ? 'pending' : 'ready', { formula, inputs, result })
}

function riskCard({ materials, declarations, stale }: AnalysisContext) {
  const risks: string[] = []
  const actions: string[] = []
  if (stale) {
    risks.push('原有联动结果已过期，当前声明的支持关系待核。')
    actions.push('按现行卷内材料重新执行核验。')
  }
  for (const item of declarations) {
    const checks = Object.values(item.checks).filter(check => check && unresolved(check.outcome))
    for (const check of checks) risks.push(`${loc(item)}「${short(item.quote)}」：${check.reason}`)
    if (!checks.length && unresolved(item.verdict)) risks.push(`${loc(item)}「${short(item.quote)}」：${item.reason}`)
    if (checks.some(check => check.outcome === 'miss') || item.verdict === 'miss') actions.push(`${loc(item)}：补充可回查的原文出处及对应定位。`)
    if (checks.some(check => check.outcome === 'fail') || item.verdict === 'fail') actions.push(`${loc(item)}：调取对应原文，逐项对照冲突字段，核对后再处理声明。`)
    if (checks.some(check => check.outcome === 'pending' || check.outcome === 'warn') || item.verdict === 'pending' || item.verdict === 'warn') actions.push(`${loc(item)}：补齐核验材料，复查原文及相关字段。`)
  }
  for (const item of materials) {
    const name = materialName(item.material)
    const excerpts = textSources(item)
    if (!excerpts.length) {
      risks.push(`${name}：缺可回查原文。`)
      actions.push(`${name}：补充原件或取得可定位的清晰原文。`)
    }
    for (const { text, loc } of excerpts) for (const finding of scanEvidenceRisks(text)) {
      risks.push(`${name} · ${loc || '材料全文'}：${finding.message}${finding.excerpt ? `原文片段「${finding.excerpt}」。` : ''}`)
      actions.push(`${name}：${riskActions[finding.kind]}`)
    }
  }
  if (!materials.length && !declarations.length) {
    risks.push('缺少可供核对的卷内材料或文书核验记录。')
    actions.push('补充可回查的材料及对应声明。')
  }
  return makeCard(risks.length ? 'pending' : 'ready', { risks: unique(risks), actions: unique(actions) })
}

function asQuestion(text: string) {
  const statement = short(text).replace(/[。；;！!？?]+$/u, '')
  return /^(?:是否|能否|应否|如何)|(?:是否|能否|应否|如何).{1,60}$/u.test(statement) ? `${statement}？` : `能否支持「${statement}」？`
}

function focusCard({ position, materials, declarations }: AnalysisContext) {
  const ourIssues = position ? [...position.disputes, ...position.goals].map(issue => `已确认立场：${asQuestion(issue)}`) : []
  const theirIssues: string[] = []
  const shared = declarations.filter(item => item.type === 'E-FOCUS')
    .map(item => `${loc(item)}：${asQuestion(item.quote.replace(/^(?:争议焦点|争点)[：:\s]+/u, ''))}`)
  const roleParties: Partial<Record<CasePosition['role'], readonly [string, string]>> = {
    plaintiff: ['原告', '被告'], defendant: ['被告', '原告'], applicant: ['申请人', '被申请人'], respondent: ['被申请人', '申请人'],
  }
  const roles = position && roleParties[position.role]
  for (const item of materials) for (const sentence of materialSentences(item)) {
    const { material, loc, text } = sentence
    const common = /^(?:双方争议焦点|争议焦点|争点)\s*[：:]\s*(.+)$/u.exec(text)
    if (common && common[1].trim()) shared.push(`${material} · ${loc}：${asQuestion(common[1])}`)
    const claim = /^(原告|被告|被申请人|申请人|双方)\s*(?:主张|认为|抗辩称|辩称)\s*[：:，,\s]*(.+)$/u.exec(text)
    if (!claim || !claim[2].trim()) continue
    const question = `${material} · ${loc}：${asQuestion(claim[2])}`
    if (claim[1] === '双方') shared.push(question)
    if (claim[1] === roles?.[0]) ourIssues.push(question)
    if (claim[1] === roles?.[1]) theirIssues.push(question)
  }
  return makeCard(ourIssues.length && theirIssues.length ? 'ready' : 'pending', {
    ourIssues: unique(ourIssues), theirIssues: unique(theirIssues), shared: unique(shared),
  })
}

const explicitDate = /(?<!\d)(\d{4})\s*(?:年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日|([./-])\s*(\d{1,2})\s*\4\s*(\d{1,2})(?!\d))/gu
const relativeDate = /当日|当天|次日|同日|随后|次月|近日/u
const eventSignal = /送达|收悉|签收|签署|签订|立案|受理|开庭|裁定|移送|付款|支付|转账|交付|还款|催告/u

function timelineCard({ materials }: AnalysisContext) {
  const events = new Map<string, TimelineEvent>()
  for (const item of materials) for (const { material, loc, text } of materialSentences(item)) {
    const dates = [...text.normalize('NFKC').matchAll(explicitDate)].map(match => {
      const date = `${match[1]}-${(match[2] ?? match[5]).padStart(2, '0')}-${(match[3] ?? match[6]).padStart(2, '0')}`
      const parsed = new Date(`${date}T00:00:00Z`)
      return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date ? null : date
    })
    if (relativeDate.test(text) || (!dates.length && eventSignal.test(text))) dates.push(null)
    for (const date of dates) events.set(JSON.stringify([item.material.id, loc, text, date]), {
      date, event: short(text), material, loc, status: date === null ? 'pending' : 'recorded',
    })
  }
  const sorted = [...events.values()].sort((a, b) => (a.date ?? '9999-99-99').localeCompare(b.date ?? '9999-99-99'))
  return makeCard(sorted.length && sorted.every(item => item.status === 'recorded') ? 'ready' : 'pending', { events: sorted.slice(0, 60) })
}

const cards: { [Id in AnalysisSkillId]: (context: AnalysisContext) => BaseCard & AnalysisFields[Id] } = {
  evidence: evidenceCard, chain: chainCard, calc: calculationCard, risk: riskCard, focus: focusCard, timeline: timelineCard,
}

export function runAnalysisSkill<Id extends AnalysisSkillId>(id: Id, input: AnalysisInput): BaseCard & AnalysisFields[Id] {
  const context = buildContext(input, id !== 'timeline')
  const output = cards[id](context)
  validateSkillOutput(id, output)
  return output
}
