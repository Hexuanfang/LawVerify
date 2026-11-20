import { isDeepStrictEqual } from 'node:util'
import { createLegalCaseAdapter } from '../../src/integrations/legal-case.ts'
import { applyDeclarationDependencies } from '../../src/intelligence/verification/dependencies.ts'
import { extractDeclarations } from '../../src/intelligence/verification/extract.ts'
import { verifyLegalDeclarations } from '../../src/intelligence/verification/legal.ts'

const caseChecks = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7']
const seedIds = ['c1-q7', 'c1-l3']

async function verify(id, docKey, texts, response) {
  const steps = []
  const adapter = createLegalCaseAdapter('offline-case-fixture', async request => {
    const result = await response(request)
    steps.push({ action: request.action, id: request.id, caseNumber: request.case_number })
    return result
  })
  const paragraphs = texts.map((text, index) => ({ id: `p${index}`, text }))
  const certificate = { id, docKey, paragraphs }
  const { declarations } = extractDeclarations(certificate)
  const evaluated = await verifyLegalDeclarations(certificate, declarations, { knowledgeStatutes: [], knowledgeCases: [] },
    undefined, undefined, undefined, adapter)
  return { evaluated, steps }
}

function fixedDetail(row) {
  return async request => ({ items: request.action !== 'detail' || (request.id ? row.id === request.id : row.case_number === request.case_number) ? [row] : [] })
}

function observe(item, steps) {
  const state = item?.caseVerification
  const sources = item?.sources ?? []
  const allowOperativeQuote = state?.allowCitation === true && state.citationKind === 'operative'
  return { type: item?.type, verdict: item?.verdict, reason: item?.reason, checks: item?.checks ?? {}, sources,
    sourceTier: sources[0]?.tier ?? 'l0', allowCitation: state?.allowCitation === true, allowOperativeQuote,
    queryOutcome: state?.queryOutcome, detailOutcome: state?.detailOutcome,
    detailVerified: state?.detailOutcome === 'found',
    fourElements: !!(state?.caseNumber && state.court && state.judgmentDate && sources.some(source => source.locator && source.quote && source.url)),
    match: state?.match, label: state?.match === 'analogous' ? '近似类比' : undefined,
    detailBeforeCitation: allowOperativeQuote && sources.some(source => steps.some(step => step.action === 'detail'
      && (step.id === source.id || step.caseNumber === state.caseNumber))),
  }
}

function grade(id, expected, actual) {
  const matches = Object.entries(expected).every(([key, value]) => {
    if (key === 'failedCheck') return actual.checks[value]?.outcome === 'fail'
    if (key === 'reasonContains') return actual.reason?.includes(value)
    return isDeepStrictEqual(actual[key], value)
  })
  return { id, status: matches ? 'pass' : 'fail', expected, actual }
}

async function runSeed(id, documents, labels, fixtures, upstream) {
  const label = labels.find(item => item.id === id)
  const original = documents.find(item => item.id === label?.documentId)
  if (!original || original.paragraphs[label.paragraphIndex] !== label.quote) return {}
  const isLaw = id === 'c1-l3'
  const row = isLaw ? { ...fixtures.seed, referenced_statutes: ['《中华人民共和国合同法》第一百零七条'] } : fixtures.seed
  const texts = [...original.paragraphs]
  texts.splice(label.paragraphIndex, 0, fixtures.seedContext)
  const { evaluated, steps } = await verify(id, original.docKey, texts, fixedDetail(row))
  const candidate = evaluated.find(item => item.type === 'E-CASE' && item.location.paragraphIndex === label.paragraphIndex + 1)
  const upstreamLabel = labels.find(item => item.id === upstream?.id)
  const upstreamIndex = upstreamLabel && upstreamLabel.paragraphIndex
    + Number(upstreamLabel.paragraphIndex >= label.paragraphIndex)
  const upstreamItems = evaluated.filter(item => upstreamLabel && item.type === upstreamLabel.type
    && upstreamLabel.quote.includes(item.quote)
    && upstreamIndex === item.location.paragraphIndex)
  const affected = candidate?.dependencies?.find(edge => upstreamItems.some(item => item.id === edge.id))
  let changed = candidate
  if (upstream && affected && candidate) {
    const dependencies = new Map(candidate.dependencies.map(edge => [edge.id, edge.check]))
    const input = evaluated.map(item => {
      const check = dependencies.get(item.id)
      if (!check) return item
      // 隔离当前变更，其余上游使用已经核过的受控结果。
      const verdict = item.id === affected.id ? upstream.verdict : 'pass'
      return { ...item, verdict, checks: check === 'C6' ? { ...item.checks, B2: { outcome: verdict } } : item.checks }
    })
    changed = applyDeclarationDependencies(input).find(item => item.id === candidate.id)
  }
  const reopened = affected && candidate.checks[affected.check]?.outcome === 'pass' && changed?.checks[affected.check]?.outcome === 'warn'
  return { label, actual: { ...observe(changed, steps), ...(reopened && { reopenedCheck: affected.check }) }, isolated: !upstream || !!affected }
}

export async function scoreSeedCases(documents, labels, fixtures) {
  return Promise.all(seedIds.map(async id => {
    const { label, actual } = await runSeed(id, documents, labels, fixtures)
    if (!actual?.type) return { id, status: 'not-run' }
    const expected = { verdict: 'pass', sourceTier: 'l3', allowCitation: true, fourElements: true, match: 'strict' }
    const result = grade(id, expected, actual)
    if (!caseChecks.every(code => actual.checks[code]?.outcome === 'pass')) result.status = 'fail'
    return { ...result, frozenVerdict: label.verdict, scope: '冻结种子正文、受控比对语境与裁判详情，C1–C7 局部验证' }
  }))
}

export async function scoreCaseControlled(item, fixtures, documents, labels) {
  const { id, input, expected } = item
  if (id === 'CASCADE-FACT' || id === 'CASCADE-LAW') {
    const { actual, isolated } = await runSeed(input.seedId, documents, labels, fixtures, { id: input.upstreamId, verdict: input.upstreamVerdict })
    return isolated ? grade(id, expected, actual) : { id, status: 'not-run', reason: '未关联冻结种子的上游声明。' }
  }
  if (id !== 'ADV-01' && !id.startsWith('CASE-')) return undefined
  const provider = input.provider
  const row = { ...fixtures.sample, ...provider?.row }
  if (provider && Object.hasOwn(provider, 'body')) row.body = provider.body
  if (provider && Object.hasOwn(provider, 'url')) row.url = provider.url
  if (provider?.summary) row.gist = provider.summary
  if (provider?.operativeText && row.body) {
    row.body = row.body.replace(/^判决如下：[^\n]+/mu, () => `判决如下：${provider.operativeText}`)
  }
  const quote = id === 'ADV-01' ? input.quote : `参照${row.case_number}${input.quote ?? ''}`
  const transport = provider?.outcome === 'found' ? fixedDetail(row) : async request => {
    if (request.action !== 'detail') return { items: [] }
    if (provider?.outcome === 'empty-response') return null
    return { outcome: provider?.outcome ?? 'not-queried' }
  }
  const { evaluated, steps } = await verify(id, input.docKey ?? 'ss', [fixtures.context, quote], transport)
  const actual = observe(evaluated.find(entry => entry.type === 'E-CASE'), steps)
  return grade(id, expected, actual)
}
