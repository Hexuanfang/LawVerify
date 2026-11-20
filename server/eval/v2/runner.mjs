import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { env } from '../../src/config/env.ts'
import { dataset, guardProbes } from './dataset.mjs'
import { scoreLinks, scoreExtraction, validateDataset, validateManifest, ratio, locatorPages } from './metrics.mjs'
import { renderReport } from './report.mjs'
import { parserProbes } from './parser-probes.mjs'
import { parseLinkageParagraphResponse } from '../../src/intelligence/linkage-response.ts'
import { rememberCloudAiToken } from '../../src/integrations/cloud-ai.ts'
import { runWithWorkspaceAccount } from '../../src/store.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const project = path.resolve(here, '../../..')
const args = new Set(process.argv.slice(2))
for (const arg of args) if (!['--strict', '--live', '--vision'].includes(arg)) throw new Error(`未知参数 ${arg}`)
const runLive = args.has('--live'), runVision = args.has('--vision')
if (runVision && !runLive) throw new Error('--vision 必须配合 --live；该模式会实际调用模型并产生费用')
mkdirSync(path.join(project, 'tmp'), { recursive: true })
const scratch = mkdtempSync(path.join(project, 'tmp', 'benchmark-v2-'))
env.WORKSPACE_DATA_DIR = path.join(scratch, 'data')
env.STORAGE_LOCAL_ROOT = path.join(scratch, 'storage')
env.KNOWLEDGE_RAG_MODE = 'local'
env.DATABASE_URL = undefined
env.AI_GATEWAY_MODE = 'direct'
env.PARSER_SERVICE_URL = process.env.PARSER_TEST_SERVICE_URL || env.PARSER_SERVICE_URL
const parserSession = process.env.PARSER_TEST_SESSION_TOKEN?.trim()
if (parserSession) env.PARSER_SERVICE_TOKEN = undefined
// 离线评估只开放明确指定的解析和签发接口，其他请求继续阻断。
if (!runLive) {
  const parser = process.env.PARSER_TEST_SERVICE_URL && new URL(`${env.PARSER_SERVICE_URL.replace(/\/$/, '')}/parse`)
  const issuer = parserSession && env.CLOUD_API_BASE_URL && new URL(`${env.CLOUD_API_BASE_URL.replace(/\/$/, '')}/api/account/parser-ticket`)
  const request = globalThis.fetch
  globalThis.fetch = async (input, options) => {
    const url = new URL(input instanceof Request ? input.url : input)
    if (options?.method === 'POST' && parser && [parser, issuer].some(target => target
      && url.origin === target.origin && url.pathname === target.pathname)) return request(input, { ...options, redirect: 'error' })
    throw new Error('离线 benchmark 只允许访问 PARSER_TEST_SERVICE_URL 指定的解析服务及其凭证签发接口')
  }
}

const { applyProductionLinks, measureChunkRetrieval, parseUploadedFile, serviceSha256 } = await import('./production-adapter.mjs')
const { liveAvailability, predictLinks, recognizePages } = await import('./live.mjs')
const hash = value => createHash('sha256').update(value).digest('hex')
const manifestBytes = readFileSync(path.join(here, 'media-manifest.json'))
const manifest = JSON.parse(manifestBytes)
const thresholds = { file_field_accuracy_min: 1, file_cer_max: 0.02, guard_accuracy_min: 1,
  parser_accuracy_min: 1, chunk_recall_at_5_min: 0.95, live_precision_min: 0.95, live_recall_min: 0.90,
  live_relation_accuracy_min: 0.95, live_page_accuracy_min: 1, mutation_detection_min: 1 }
const report = { generatedAt: new Date().toISOString(), mode: runLive ? `live${runVision ? '+vision' : ''}` : 'offline', status: '部分验证',
  counts: { cases: dataset.length, claims: dataset.reduce((n, s) => n + s.claims.length, 0), files: manifest.documents.length },
  sourceHashes: { service: serviceSha256, dataset: hash(JSON.stringify(dataset)), manifest: hash(manifestBytes),
    modules: Object.fromEntries(readdirSync(here).filter(n => /\.(mjs|py)$/.test(n)).map(n => [n, hash(readFileSync(path.join(here, n)))])),
    production: { ...Object.fromEntries(['intelligence/evidence-retrieval.ts', 'intelligence/evidence-matching.ts', 'intelligence/linkage-policy.ts',
      'intelligence/linkage-response.ts', 'infrastructure/document-jobs.ts', 'middleware/bounded-upload.ts']
      .map(n => [n, hash(readFileSync(path.join(here, '../../src', n)))])),
    'python-workers/python-workers.ts': hash(readFileSync(path.join(project, 'python-workers/python-workers.ts'))) } },
  thresholds, cases: [], files: [], guards: { correct: 0, total: 0, rate: null }, mutations: {},
  live: { textStatus: runLive ? '待执行' : '未测', visionStatus: runVision ? '待执行' : '未测', caseResults: [], visionResults: [], fileLinkResults: [] },
  issues: [...validateDataset(dataset), ...validateManifest(manifest)], scratch }
if (report.counts.cases < 8 || report.counts.claims < 120) report.issues.push('场景覆盖不足：至少8案120句')
let failed = report.issues.length > 0
function issue(message) { report.issues.push(message); failed = true }
report.parser = parserProbes(parseLinkageParagraphResponse)
for (const result of report.parser.results.filter(r => !r.correct)) issue(`parser/${result.id}：解析输出与严格字段契约不一致`)

// 评分器自身的故障注入，与产品成绩分开报告。
const oracleSample = dataset[0]
const oracleLinks = oracleSample.claims.flatMap(c => c.expected.map(e => ({ claimId: c.id,
  materialId: e.materialId, relation: e.relation, locator: `第${e.page}页`, quote: oracleSample.materials.find(m => m.id === e.materialId).pages[e.page - 1] })))
const oracleScore = scoreLinks(oracleSample, oracleLinks)
const mutations = [
  ['全部漏挂', []], ['错关系', oracleLinks.map(l => ({ ...l, relation: l.relation === 'support' ? 'contradict' : 'support' }))],
  ['未知证据', oracleLinks.map(l => ({ ...l, materialId: 'unknown' }))], ['无效页码', oracleLinks.map(l => ({ ...l, locator: '不存在的位置' }))],
  ['越界页码', oracleLinks.map(l => ({ ...l, locator: '第1-999页' }))], ['虚构引文', oracleLinks.map(l => ({ ...l, quote: '不在材料中的虚构事实abcxyz' }))],
  ['重复输出', [...oracleLinks, oracleLinks[0]]], ['禁挂句错挂', [...oracleLinks, { ...oracleLinks[0], claimId: oracleSample.claims[9].id }]],
  ['删除否定词', oracleLinks.map(l => ({ ...l, quote: l.quote.replaceAll('尚未', '').replaceAll('不能', '') }))],
]
report.mutations = { oracleF1: oracleScore.f1, results: mutations.map(([name, links]) => ({ name, f1: scoreLinks(oracleSample, links).f1 })),
  total: mutations.length, detected: 0 }
report.mutations.detected = report.mutations.results.filter(r => r.f1 !== null && r.f1 < oracleScore.f1).length
if (oracleScore.f1 !== 1 || report.mutations.detected !== report.mutations.total) issue('评分器反例自检未通过')

for (const sample of dataset) {
  const probes = guardProbes(sample).map(probe => {
    const outputs = applyProductionLinks(sample, [probe])
    const correct = probe.shouldKeep ? outputs.length === 1 && (!probe.expectedRelation || outputs[0].relation === probe.expectedRelation)
      && (!probe.expectedPage || locatorPages(outputs[0].locator, sample.materials.find(m => m.id === probe.materialId).pages.length)?.[0] === probe.expectedPage)
      : outputs.length === 0
    if (!correct) issue(`${sample.id}/${probe.id}：生产防线未拦截或未正确降级`)
    return { ...probe, outputs, correct }
  })
  const retrievalDetails = measureChunkRetrieval(sample)
  const retrieval = { recall1: ratio(retrievalDetails.filter(r => r.rank !== null && r.rank <= 1).length, retrievalDetails.length),
    recall5: ratio(retrievalDetails.filter(r => r.rank !== null && r.rank <= 5).length, retrievalDetails.length), details: retrievalDetails }
  if (retrieval.recall5 === null || retrieval.recall5 < thresholds.chunk_recall_at_5_min) issue(`${sample.id}：chunk recall@5 不达标`)
  const guards = { correct: probes.filter(p => p.correct).length, total: probes.length, probes }
  report.cases.push({ id: sample.id, name: sample.name, retrieval, guards })
  report.guards.correct += guards.correct; report.guards.total += guards.total
}
report.guards.rate = ratio(report.guards.correct, report.guards.total)

const availability = liveAvailability()
if (runLive && !availability.text) issue('未配置直连文本模型，语义核验未测')
if (runVision && !availability.vision) issue('未配置视觉模型，视觉核验未测')
report.live.textStatus = runLive && availability.text ? '已请求执行，逐案结果见下' : '未测'
report.live.visionStatus = runVision && availability.vision ? '已请求执行，逐文件结果见下' : '未测'

async function evaluateLive(sample, destination) {
  try {
    const prediction = await predictLinks(sample)
    const outputs = applyProductionLinks(sample, prediction.intents)
    const score = scoreLinks(sample, [...outputs, ...prediction.invalid])
    const rawScore = scoreLinks(sample, prediction.rawPredictions)
    const result = { id: sample.id, score, rawScore, prediction, outputs }
    destination.push(result)
    if (prediction.missing.length || prediction.invalid.length || prediction.protocolIssues.length || score.precision === null || score.precision < thresholds.live_precision_min
      || score.recall === null || score.recall < thresholds.live_recall_min || score.relationAccuracy < thresholds.live_relation_accuracy_min
      || score.pageAccuracy < thresholds.live_page_accuracy_min || score.negativeAccuracy < 1
      || rawScore.precision === null || rawScore.precision < thresholds.live_precision_min || rawScore.recall === null
      || rawScore.recall < thresholds.live_recall_min || rawScore.pageAccuracy < 1 || rawScore.relationAccuracy < thresholds.live_relation_accuracy_min
      || rawScore.negativeAccuracy < 1) issue(`${sample.id}：模型核验未达标或输出不完整`)
  } catch (error) { issue(`${sample.id}：模型核验失败 ${error.message}`) }
}

for (const doc of manifest.documents) {
  console.log(`解析附件：${doc.id}`)
  const filePath = path.resolve(here, doc.file)
  const result = { id: doc.id, kind: doc.kind, status: '未执行' }
  report.files.push(result)
  let parsed
  try {
    if (!filePath.startsWith(path.join(here, 'assets') + path.sep)) throw new Error('附件路径越界')
    result.sha256 = hash(readFileSync(filePath))
    if (result.sha256 !== doc.sha256) throw new Error('附件哈希不匹配')
    result.integrityVerified = true
    parsed = await runWithWorkspaceAccount('eval-parser@example.invalid', () => {
      rememberCloudAiToken(parserSession)
      return parseUploadedFile(filePath, doc.file.endsWith('.png') ? 'image/png' : 'application/pdf')
    })
    result.totalPages = parsed.patch.pages; result.renderedPages = parsed.patch.pageImageDataUrls?.length ?? 0
    result.uploadBytesMatch = parsed.uploadBytesMatch; result.actualPages = parsed.pages
    if (!parsed.uploadBytesMatch) issue(`${doc.id}：上传内容变化`)
    if (doc.expectFailure) { result.status = '错误接受损坏文件'; issue(`${doc.id}：损坏文件未拒绝`); continue }
    result.extraction = scoreExtraction(doc, parsed.pages, { totalPages: parsed.patch.pages })
    const ok = result.extraction.fieldAccuracy >= thresholds.file_field_accuracy_min
      && result.extraction.characterErrorRate <= thresholds.file_cer_max && result.extraction.pageCountCorrect
    result.status = ok ? '通过' : '文本提取不足'
    if (!ok) issue(`${doc.id}：文本/图片关键字段缺失、字符错误或页码不符`)
  } catch (error) {
    result.error = error.message
    result.status = doc.expectFailure && result.integrityVerified ? '正确拒绝损坏文件' : '解析或完整性失败'
    if (!doc.expectFailure || !result.integrityVerified) issue(`${doc.id}：解析或完整性失败 ${error.message}`)
  }
  if (doc.expectFailure || !result.integrityVerified) continue
  let observedPages = parsed?.pages ?? []
  if (runVision && availability.vision) {
    try {
      const pages = await recognizePages(filePath, doc.file.endsWith('.png') ? 'image/png' : 'application/pdf')
      const score = scoreExtraction(doc, pages)
      report.live.visionResults.push({ id: doc.id, score, actualPages: pages })
      observedPages = pages
      if (score.fieldAccuracy < thresholds.file_field_accuracy_min || score.characterErrorRate > thresholds.file_cer_max || !score.pageCountCorrect) issue(`${doc.id}：视觉识别未达标`)
    } catch (error) { issue(`${doc.id}：视觉识别失败 ${error.message}`) }
  }
  if (runLive && availability.text) {
    const sample = { id: `file-${doc.id}`, name: doc.id,
      materials: [{ id: '1', number: 'E01', name: '原始附件', role: 'source_evidence',
        pages: doc.pages.map((_, i) => observedPages.find(p => p.page === i + 1)?.text ?? '') }],
      claims: doc.claims.map((c, i) => ({ id: `${doc.id}-c${i + 1}`, text: c.text,
        expected: c.relation ? [{ materialId: '1', relation: c.relation, page: c.page }] : [] })) }
    // 评分使用金标准原文；模型和生产挂接只看到实际解析结果，防止答案泄漏。
    const predictionSample = sample
    try {
      const prediction = await predictLinks(predictionSample)
      const outputs = applyProductionLinks(predictionSample, prediction.intents)
      const goldSample = { ...sample, materials: [{ ...sample.materials[0], pages: doc.pages.map(p => p.text) }] }
      const score = scoreLinks(goldSample, [...outputs, ...prediction.invalid])
      const rawScore = scoreLinks(goldSample, prediction.rawPredictions)
      report.live.fileLinkResults.push({ id: sample.id, score, rawScore, prediction, outputs })
      if (prediction.missing.length || prediction.invalid.length || prediction.protocolIssues.length || score.precision === null || score.precision < thresholds.live_precision_min
        || score.recall === null || score.recall < thresholds.live_recall_min || score.pageAccuracy < 1 || score.negativeAccuracy < 1
        || rawScore.precision === null || rawScore.precision < thresholds.live_precision_min || rawScore.recall === null || rawScore.recall < thresholds.live_recall_min
        || rawScore.pageAccuracy < 1 || rawScore.negativeAccuracy < 1) issue(`${sample.id}：文件到挂接未达标`)
    } catch (error) { issue(`${sample.id}：文件到挂接失败 ${error.message}`) }
  }
}

if (runLive && availability.text) for (const sample of dataset) {
  console.log(`语义核验：${sample.id}`)
  await evaluateLive(sample, report.live.caseResults)
}
if (!runLive || !availability.text || report.live.caseResults.length !== dataset.length) issue('未测/未完成：真实模型语义核验')
if (!runVision || !availability.vision || report.live.visionResults.length !== manifest.documents.filter(d => !d.expectFailure).length) issue('未测/未完成：真实视觉识别')
if (report.live.fileLinkResults.length !== manifest.documents.filter(d => !d.expectFailure).length) issue('未测/未完成：原始文件到挂接完整链路')
report.status = failed ? '未通过（含失败或未测）' : '全部达标'
const reports = path.resolve(here, '../reports/v2')
mkdirSync(reports, { recursive: true })
const name = `benchmark-${report.generatedAt.replace(/[:.]/g, '-')}`
for (const stem of [name, 'latest']) {
  writeFileSync(path.join(reports, `${stem}.json`), JSON.stringify(report, null, 2) + '\n')
  writeFileSync(path.join(reports, `${stem}.md`), renderReport(report))
}
console.log(`结果：${report.status}；防线 ${report.guards.correct}/${report.guards.total}；附件通过 ${report.files.filter(f => f.status === '通过' || f.status === '正确拒绝损坏文件').length}/${report.files.length}`)
console.log(`报告：${path.join(reports, `${name}.md`)}`)
if (args.has('--strict') && failed) process.exitCode = 1
