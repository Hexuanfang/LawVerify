import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual, parseArgs } from 'node:util'
import { verifyEvidenceDeclarations } from '../../src/intelligence/verification/evidence.ts'
import { extractDeclarations } from '../../src/intelligence/verification/extract.ts'
import { verifyLegalDeclarations } from '../../src/intelligence/verification/legal.ts'
import { profile } from '../../src/intelligence/verification/profile.ts'
import { gradeSeedPairing } from './extraction-score.mjs'
import { scoreCaseControlled, scoreSeedCases } from './case-benchmark.mjs'
import { scoreSeedStatutes, scoreStatuteControlled, scoreStatuteQuoteMutation } from './statute-benchmark.mjs'

export { gradeSeedPairing } from './extraction-score.mjs'

const sets = ['seed', 'adversarial', 'extra', 'all']
const readFixture = name => readFile(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')

async function inspect(input, materials = [], excerpts = []) {
  const evidence = materials.filter(item => !['law', 'case'].includes(item.t)).map((item, index) => ({
    id: item.id ?? `material-${index}`, caseId: input.caseId, name: item.name ?? item.n, fileName: item.name ?? item.n,
    type: 'text', ocrText: [item.text, ...excerpts.filter(excerpt => excerpt.name === (item.name ?? item.n)).map(excerpt => excerpt.excerpt)].filter(Boolean).join('\n'),
  }))
  const evidenceFragments = excerpts.flatMap(item => {
    const source = evidence.find(material => material.name === item.name)
    return source ? [{ evidenceId: source.id, locator: item.loc, text: item.excerpt }] : []
  })
  const anchors = materials.flatMap(item => {
    if (!Number.isInteger(item.anchorParagraph) || !item.locator || !item.text?.trim()) return []
    const source = evidence.find(material => material.name === (item.name ?? item.n))
    return source ? [{ paragraph: item.anchorParagraph, evidenceId: source.id, locator: item.locator, quote: item.text }] : []
  })
  evidenceFragments.push(...anchors.map(({ evidenceId, locator, quote }) => ({ evidenceId, locator, text: quote })))
  const certificate = { ...input, paragraphs: input.paragraphs.map((text, index) => ({ id: `${input.id}-${index}`, text, verified: false,
    links: anchors.filter(anchor => anchor.paragraph === index).map(({ evidenceId, locator, quote }) => ({ evidenceId, locator, quote, relation: 'context' })),
  })) }
  const { declarations, offCandidates } = extractDeclarations(certificate)
  const evaluated = await verifyLegalDeclarations(certificate,
    verifyEvidenceDeclarations(certificate, declarations, { evidences: evidence, evidenceFragments, evidenceInsights: [] }),
    { knowledgeStatutes: [], knowledgeCases: [] })
  const withDocument = item => ({ ...item, documentId: input.id })
  return { offCandidates: offCandidates.map(withDocument), declarations: evaluated.map(withDocument) }
}

export async function scoreControlled(item) {
  if (item.input.provider || !item.input.quote && !item.input.paragraphs) {
    return { id: item.id, status: 'not-run', reason: '需要详情适配、已锚定来源或应用入口。' }
  }
  const result = await inspect({ id: item.id, caseId: item.id, docKey: item.input.docKey, paragraphs: item.input.paragraphs ?? [item.input.quote] },
    item.input.materials?.map(material => typeof material === 'string' ? { name: material } : material) ?? [])
  const found = result.declarations.find(declaration => declaration.type === item.expected.type
    && (!item.expected.failedCheck || declaration.checks[item.expected.failedCheck]?.outcome === 'fail'))
    ?? result.declarations.find(declaration => declaration.type === item.expected.type)
  const actual = { verdict: found?.verdict ?? null, check: item.expected.failedCheck ? found?.checks[item.expected.failedCheck]?.outcome ?? null : null }
  const matched = actual.verdict === item.expected.verdict && (!item.expected.failedCheck || actual.check === 'fail')
  const unmeasured = Object.keys(item.expected).filter(key => !['type', 'verdict', 'failedCheck'].includes(key))
  return { id: item.id, status: !matched ? 'fail' : unmeasured.length ? 'partial' : 'pass',
    expected: { verdict: item.expected.verdict, check: item.expected.failedCheck ?? null }, actual, unmeasured }
}

function scoreExtractionRegression(item) {
  if (!Array.isArray(item.expected.declarations) || typeof item.input.quote !== 'string') return { id: item.id, status: 'not-run' }
  const text = item.input.quote
  const document = { id: item.id, docKey: item.input.docKey, paragraphs: [{ id: 'original', text }] }
  const { declarations, offCandidates } = extractDeclarations(document)
  const actual = declarations.map(entry => ({ documentId: document.id, type: entry.type, quote: entry.quote, location: entry.location }))
  const expected = item.expected.declarations.map((entry, index) => ({ ...entry, id: `expected-${index + 1}`,
    documentId: document.id, paragraphIndex: 0, purpose: 'declaration' }))
  const score = gradeSeedPairing(expected, actual)
  const ordered = [...actual].sort((left, right) => left.location.start - right.location.start)
  const exactRanges = ordered.every(({ location, quote }, index) => text.slice(location.start, location.end) === quote
    && (!index || ordered[index - 1].location.end <= location.start))
  const pass = exactRanges && offCandidates.length === 0 && score.recall.value === 1 && score.precision.value === 1
  return { id: item.id, status: pass ? 'pass' : 'fail', actual }
}

async function scoreL1SourceRegression(item) {
  const { id, input, expected } = item
  const result = await inspect({ id, caseId: id, docKey: input.docKey, paragraphs: [input.quote] }, input.materials)
  const declaration = result.declarations.find(entry => entry.type === 'E-FACT' && entry.quote === input.quote)
  const actual = { verdict: declaration?.verdict ?? null, sources: declaration?.sources ?? null,
    sourceTier: declaration ? declaration.sources[0]?.tier ?? 'l0' : null,
    substitutedSource: declaration ? declaration.sources.some(source => source.tier === 'l1') : null }
  const unmeasured = Object.keys(expected).filter(key => !Object.hasOwn(actual, key))
  const matched = Object.entries(expected).every(([key, value]) => unmeasured.includes(key) || isDeepStrictEqual(actual[key], value))
  return { id, status: !matched ? 'fail' : unmeasured.length ? 'partial' : 'pass', actual, unmeasured }
}

function inventoryExtra(documents, materials) {
  const byCase = new Map(materials.map(item => [item.caseId, item]))
  const byType = Object.fromEntries(Object.keys(profile.profiles).map(key => [key, {
    difficulties: { simple: 0, standard: 0, adversarial: 0 }, defense: 0,
  }]))
  const issues = []
  const ids = new Set()
  const causes = new Set()
  const inventory = documents.map(({ id, caseId, docKey, difficulty, title, materialIds, paragraphs }) => {
    const dossier = byCase.get(caseId)
    const group = Object.hasOwn(byType, docKey) ? byType[docKey] : undefined
    if (!id || ids.has(id) || !title?.trim() || !paragraphs?.length || paragraphs.some(text => !text.trim())) {
      issues.push({ id, reason: '文书 ID、标题或正文不完整，或 ID 重复。' })
    }
    ids.add(id)
    if (!dossier?.cause || !['claimant', 'defendant'].includes(dossier.side) || !materialIds?.length ||
      materialIds.some(sourceId => !dossier.materials.some(item => item.id === sourceId &&
        item.title?.trim() && item.segments?.length && item.segments.every(segment => segment.locator?.trim() && segment.text?.trim())))) {
      issues.push({ id, reason: '案由、立场或卷内材料不可回查。' })
    }
    if (!group || !Object.hasOwn(group.difficulties, difficulty)) {
      issues.push({ id, reason: '文书类型或难度无有效配置。' })
    } else {
      group.difficulties[difficulty]++
      if (dossier?.side === 'defendant') group.defense++
    }
    if (dossier?.cause) causes.add(dossier.cause)
    return { id, title, caseId, docKey, difficulty, materialIds, cause: dossier?.cause, side: dossier?.side }
  })
  for (const [docKey, group] of Object.entries(byType)) {
    if (Object.values(group.difficulties).some(count => count === 0) || !group.defense) {
      issues.push({ docKey, reason: '缺少某难度或防御立场样本。' })
    }
  }
  if (documents.length < 30 || causes.size < 3 || !causes.has('民间借贷纠纷') || !causes.has('买卖合同纠纷')) {
    issues.push({ reason: '文书总数或案由覆盖不足。' })
  }
  return { status: 'not-run', reason: '扩充正文和材料已纳入覆盖清单，判定金标待律师核定。', documents: documents.length, labels: 0,
    inventory, coverage: { byType, causes: [...causes], issues } }
}

export async function runBenchmark(set) {
  if (!sets.includes(set)) throw new Error(`--set 应为 ${sets.join('|')}`)
  const run = value => set === 'all' || set === value
  const report = {
    generatedAt: new Date().toISOString(), commit: null, workingTree: null, mode: 'offline-rules-only', set,
    profileVersion: profile.version, node: process.version, fixtureHashes: {}, systemGrade: null,
    production: { status: 'not-run', reason: '未执行律师复核、真实法源或模型联调。' },
    unmeasured: ['真实入口端到端', '完整助手技能验收', '生产法条和类案检索', 'R1–R10 全量命中率', '人工抽检', '分档'],
  }
  try {
    const cwd = fileURLToPath(new URL('../../../', import.meta.url))
    report.commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim()
    report.workingTree = execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' }).trim() ? 'dirty' : 'clean'
  } catch { report.commit = null }
  const load = async name => {
    const fixture = await readFixture(name)
    report.fixtureHashes[name] = createHash('sha256').update(fixture).digest('hex')
    return JSON.parse(fixture)
  }
  const statutoryDetails = run('seed') || run('adversarial') ? await load('statute-details') : undefined
  const [documents, expected, caseDetails] = run('seed') || run('adversarial')
    ? await Promise.all(['seed/documents', 'seed/expected', 'case-details'].map(load)) : []
  if (run('seed')) {
    const sources = await load('seed/sources')
    const results = await Promise.all(documents.map(document => {
      const source = sources.find(item => item.caseId === document.caseId)
      return inspect(document, source?.materials, source?.excerpts?.filter(item => item.st === 'l1'))
    }))
    const offCandidates = results.flatMap(item => item.offCandidates)
    report.seed = { documents: documents.length, rawLabels: expected.length, offCandidates,
      scope: '仅抽取和离线规则；演示摘要不作可信法源，不用于发布门槛。',
      statuteChecks: await scoreSeedStatutes(documents, statutoryDetails),
      caseChecks: await scoreSeedCases(documents, expected, caseDetails),
      ...gradeSeedPairing(expected, results.flatMap(item => item.declarations), { documents, offCandidates }) }
  }
  if (run('adversarial')) {
    const { adversarial, regressions } = await load('controlled')
    const scoreCase = item => scoreCaseControlled(item, caseDetails, documents, expected)
    const rows = await Promise.all(adversarial.map(async item => await scoreCase(item) ?? await scoreStatuteControlled(item, statutoryDetails) ?? scoreControlled(item)))
    const redlineRegressions = await Promise.all(regressions.filter(item => !item.input.mutationOf).map(async item => {
      if (['SOURCE-ABSENT', 'SOURCE-SAME-NAME-WRONG-PERIOD'].includes(item.id)) return scoreL1SourceRegression(item)
      return await scoreCase(item) ?? await scoreStatuteControlled(item, statutoryDetails) ?? scoreExtractionRegression(item)
    }))
    const baselines = new Map([...rows, ...redlineRegressions].map(row => [row.id, row]))
    for (const item of regressions.filter(item => item.input.mutationOf)) {
      redlineRegressions.push(scoreStatuteQuoteMutation(item, baselines.get(item.input.mutationOf)))
    }
    const cases = [...rows, ...redlineRegressions].filter(row => row.actual?.type === 'E-CASE')
    const operative = cases.filter(row => row.actual.allowOperativeQuote)
    const detailBeforeCitation = operative.filter(row => row.actual.detailBeforeCitation).length
    report.adversarial = { declared: rows.length, executed: rows.filter(row => row.status !== 'not-run').length, rows,
      redlineRegressions, caseMetrics: {
        fourElements: { measured: cases.length, complete: cases.filter(row => row.actual.fourElements).length },
        matchLevels: Object.fromEntries(['strict', 'analogous', 'irrelevant', 'unclassified'].map(level =>
          [level, cases.filter(row => (row.actual.match ?? 'unclassified') === level).length])),
        operativeCitations: { cited: operative.length, detailBeforeCitation, rate: operative.length ? detailBeforeCitation / operative.length : null },
      } }
  }
  if (run('extra')) {
    const [extraDocuments, extraMaterials] = await Promise.all(['extra/documents', 'extra/materials'].map(load))
    report.extra = inventoryExtra(extraDocuments, extraMaterials)
  }
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { set: { type: 'string' }, out: { type: 'string' } } })
  if (!values.set || !values.out) throw new Error('用法：bench --set seed|adversarial|extra|all --out <path>')
  const report = await runBenchmark(values.set)
  const output = resolve(values.out)
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`${report.mode} → ${output}（未达线或未测项见报告，不代表通过验收）`)
}
