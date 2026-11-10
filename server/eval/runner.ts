import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseLinkageParagraphResponse } from '../src/intelligence/linkage-response.js'
import {
  checkDatasetConsistency,
  evaluateGating,
  evaluateGrounding,
  evaluateNumbering,
  evaluateParseSuccess,
  evaluateRecall,
  type EvalSample,
  type FixtureEntry,
  type MetricResult,
} from './metrics.js'
import { renderEvalReport, type LiveMetric } from './report.js'

const here = path.dirname(fileURLToPath(import.meta.url))

interface Thresholds {
  offline: Record<string, number>
  live: Record<string, number>
}

interface Baseline {
  generatedAt: string
  corpus: string
  metrics: Record<string, number>
}

interface Args {
  live: boolean
  strict: boolean
  gateway: boolean
  updateBaseline: boolean
  datasetPaths: string[]
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    live: false,
    strict: false,
    gateway: false,
    updateBaseline: false,
    datasetPaths: [],
  }

  for (const arg of argv) {
    if (arg === '--live') args.live = true
    else if (arg === '--strict') args.strict = true
    else if (arg === '--gateway') args.gateway = true
    else if (arg === '--update-baseline') args.updateBaseline = true
    else if (arg.startsWith('--dataset=')) args.datasetPaths.push(arg.slice('--dataset='.length))
    else throw new Error(`未知参数：${arg}`)
  }

  return args
}

function readJson<T>(filePath: string, fallback: T): T {
  if (!existsSync(filePath)) {
    return fallback
  }
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as T
  } catch (error) {
    throw new Error(`读取 ${filePath} 失败：${(error as Error).message}`)
  }
}

function loadSamples(filePaths: string[]): EvalSample[] {
  const samples: EvalSample[] = []
  for (const filePath of filePaths) {
    if (!existsSync(filePath)) {
      console.warn(`跳过不存在的语料文件：${filePath}`)
      continue
    }
    const raw = readFileSync(filePath, 'utf8')
    for (const [index, line] of raw.split(/\r?\n/).entries()) {
      const trimmed = line.trim()
      // 以 # 或 // 开头的行是语料文件的注释行，不是样本。
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) continue
      try {
        samples.push(JSON.parse(trimmed) as EvalSample)
      } catch (error) {
        throw new Error(`${filePath} 第 ${index + 1} 行不是合法 JSON：${(error as Error).message}`)
      }
    }
  }
  return samples
}

function formatTimestamp(date: Date) {
  return date.toISOString().replace(/[:.]/g, '-')
}

function belowThreshold(metric: MetricResult, thresholds: Record<string, number>) {
  const threshold = thresholds[metric.key]
  if (threshold === undefined) {
    return false
  }
  return metric.key.endsWith('_rate_max')
    ? metric.value > threshold
    : metric.value < threshold
}

async function runLiveEval(samples: EvalSample[], gateway: boolean): Promise<LiveMetric[]> {
  if (gateway) {
    process.env.AI_GATEWAY_MODE = 'cloud'
    console.warn('[live] 已显式开启 --gateway：本次调用会消耗云端账户积分。')
  } else {
    console.warn('[live] 直连模式：使用 LLM_BASE_URL / LLM_API_KEY 对应的模型服务。')
  }

  const { createChatCompletion, isLlmConfigured } = await import('../src/integrations/llm-service.js')
  if (!isLlmConfigured()) {
    throw new Error('未配置 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL，无法运行 live 评测。')
  }

  let judged = 0
  let correctMaterial = 0
  let wrongMaterial = 0
  let missed = 0
  let relationMatched = 0
  const confusion: Record<string, number> = {}
  const failures: string[] = []

  for (const sample of samples) {
    const targets = sample.claims.filter(claim => claim.expect.link && claim.expect.materialId)
    if (!targets.length) {
      continue
    }
    const candidates = sample.materials.map(material => ({
      evidenceNumber: material.number,
      name: material.name,
      excerpt: material.text.replace(/\s+/g, ' ').slice(0, 220),
    }))
    const sentences = targets.map(claim => ({
      sentenceIndex: claim.sentenceIndex,
      sentenceText: claim.sentenceText,
    }))

    const completion = await createChatCompletion({
      messages: [
        {
          role: 'system',
          content: '你是证据挂接裁判。只判断每句话应该挂接到哪一份材料，或不应挂接。必须返回 JSON：{"links":[{"sentenceIndex":0,"evidenceNumber":"E01","relation":"support"}]}。不应挂接的句子不要出现在 links 中。relation 只能是 support/partial/contradict。',
        },
        {
          role: 'user',
          content: JSON.stringify({ caseName: sample.case.name, candidates, sentences }),
        },
      ],
      maxTokens: 2000,
      temperature: 0,
      responseFormat: 'json_object',
    })

    let predicted: Array<{ sentenceIndex: number; evidenceNumber: string; relation: string }> = []
    try {
      const parsed = JSON.parse(completion.content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, ''))
      const links = Array.isArray(parsed?.links) ? parsed.links : []
      predicted = links
        .filter((link: unknown) => link && typeof link === 'object')
        .map((link: Record<string, unknown>) => ({
          sentenceIndex: Number(link.sentenceIndex),
          evidenceNumber: String(link.evidenceNumber ?? ''),
          relation: String(link.relation ?? ''),
        }))
    } catch {
      predicted = []
    }

    const numberToMaterial = new Map(sample.materials.map(material => [material.number, material]))

    for (const claim of targets) {
      judged += 1
      const expectedMaterial = sample.materials.find(material => material.id === claim.expect.materialId)
      const hit = predicted.find(item => item.sentenceIndex === claim.sentenceIndex)
      const expectedKey = claim.expect.relation
      const actualKey = hit?.relation ?? 'none'
      confusion[`${expectedKey}->${actualKey}`] = (confusion[`${expectedKey}->${actualKey}`] ?? 0) + 1

      if (!hit) {
        missed += 1
        failures.push(`${claim.id} 漏挂（期望 ${expectedMaterial?.number}）`)
        continue
      }
      const predictedMaterial = numberToMaterial.get(hit.evidenceNumber)
      if (predictedMaterial?.id === claim.expect.materialId) {
        correctMaterial += 1
        if (hit.relation === claim.expect.relation) {
          relationMatched += 1
        }
      } else {
        wrongMaterial += 1
        failures.push(`${claim.id} 错挂（期望 ${expectedMaterial?.number}，实际 ${hit.evidenceNumber || '无'}）`)
      }
    }
  }

  const ratio = (value: number) => (judged ? value / judged : 0)
  return [
    { key: 'link_accuracy', label: '句级挂接准确率', value: ratio(correctMaterial), detail: `${correctMaterial}/${judged}` },
    { key: 'wrong_link_rate', label: '错挂率', value: ratio(wrongMaterial), detail: `${wrongMaterial}/${judged}` },
    { key: 'miss_link_rate', label: '漏挂率', value: ratio(missed), detail: `${missed}/${judged}` },
    { key: 'relation_accuracy', label: '关系判断准确率', value: ratio(relationMatched), detail: `${relationMatched}/${judged}` },
    { key: 'confusion', label: '关系混淆矩阵', value: 0, detail: Object.entries(confusion).map(([key, value]) => `${key}=${value}`).join('，') || '无' },
    { key: 'live_failures', label: '失败样本', value: 0, detail: failures.slice(0, 30).join('；') || '无' },
  ]
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const startedAt = Date.now()

  const thresholds = readJson<Thresholds>(path.join(here, 'thresholds.json'), { offline: {}, live: {} })
  const baseline = readJson<Baseline>(path.join(here, 'baseline.json'), { generatedAt: '', corpus: '', metrics: {} })

  const datasetPaths = args.datasetPaths.length
    ? args.datasetPaths
    : [
      path.join(here, 'datasets', 'synthetic-v1.jsonl'),
      path.join(here, 'datasets', 'real-v1.jsonl'),
    ]
  const samples = loadSamples(datasetPaths)
  if (!samples.length) {
    throw new Error('没有可用的评测样本。')
  }

  const corpus = samples.every(sample => sample.corpus === 'synthetic') ? 'synthetic' : 'mixed'
  const datasetIssues = checkDatasetConsistency(samples).map(issue => `${issue.sampleId}/${issue.claimId}：${issue.reason}`)

  const fixtures = readJson<{ entries: FixtureEntry[] }>(
    path.join(here, 'fixtures', 'linkage-offline-v1.json'),
    { entries: [] },
  ).entries ?? []

  const metrics: MetricResult[] = [
    evaluateRecall(samples),
    evaluateGating(samples),
    evaluateGrounding(
      samples,
      fixtures.flatMap(entry => (entry.links ?? []).map((link, index) => ({
        id: `${entry.id}-${index + 1}`,
        sampleId: entry.sampleId,
        ...link,
      }))),
    ),
    evaluateNumbering(samples),
    evaluateParseSuccess(fixtures, (raw, paragraphIds, stage) => parseLinkageParagraphResponse(raw, paragraphIds, stage)),
  ]

  const live = args.live ? await runLiveEval(samples, args.gateway) : undefined

  const offlineThresholds = thresholds.offline ?? {}
  const liveThresholds = thresholds.live ?? {}
  const failures = metrics.filter(metric => belowThreshold(metric, offlineThresholds))
  if (live) {
    const liveAccuracy = live.find(metric => metric.key === 'link_accuracy')
    const liveWrong = live.find(metric => metric.key === 'wrong_link_rate')
    if (liveAccuracy && liveThresholds.link_accuracy !== undefined && liveAccuracy.value < liveThresholds.link_accuracy) {
      failures.push({
        key: 'link_accuracy',
        label: liveAccuracy.label,
        value: liveAccuracy.value,
        total: 0,
        correct: 0,
        failures: [{ id: 'live', reason: `低于阈值 ${liveThresholds.link_accuracy}` }],
      })
    }
    if (liveWrong && liveThresholds.wrong_link_rate_max !== undefined && liveWrong.value > liveThresholds.wrong_link_rate_max) {
      failures.push({
        key: 'wrong_link_rate',
        label: liveWrong.label,
        value: liveWrong.value,
        total: 0,
        correct: 0,
        failures: [{ id: 'live', reason: `高于阈值 ${liveThresholds.wrong_link_rate_max}` }],
      })
    }
  }

  const currentMetrics: Record<string, number> = {}
  for (const metric of metrics) {
    currentMetrics[metric.key] = metric.value
  }

  const generatedAt = new Date().toISOString()
  const report = renderEvalReport({
    generatedAt,
    mode: args.live ? 'live' : 'offline',
    corpus,
    samples: samples.length,
    materials: samples.reduce((total, sample) => total + sample.materials.length, 0),
    claims: samples.reduce((total, sample) => total + sample.claims.length, 0),
    metrics,
    live,
    baseline: baseline.metrics,
    thresholds: offlineThresholds,
    datasetIssues,
    durationMs: Date.now() - startedAt,
  })

  const reportDir = path.join(here, 'reports')
  mkdirSync(reportDir, { recursive: true })
  const reportPath = path.join(reportDir, `eval-${formatTimestamp(new Date())}.md`)
  writeFileSync(reportPath, `${report}\n`, 'utf8')
  writeFileSync(path.join(reportDir, 'latest.md'), `${report}\n`, 'utf8')

  if (args.updateBaseline) {
    writeFileSync(
      path.join(here, 'baseline.json'),
      `${JSON.stringify({ generatedAt, corpus, metrics: currentMetrics }, null, 2)}\n`,
      'utf8',
    )
    console.log('已更新基线：server/eval/baseline.json')
  }

  console.log(`语料：corpus=${corpus}，样本 ${samples.length}，主张句 ${samples.reduce((total, sample) => total + sample.claims.length, 0)}`)
  for (const metric of metrics) {
    const threshold = offlineThresholds[metric.key]
    const state = threshold === undefined
      ? '无阈值'
      : belowThreshold(metric, offlineThresholds) ? '低于阈值' : '达标'
    console.log(`  ${metric.label}：${(metric.value * 100).toFixed(1)}%（${metric.correct}/${metric.total}）${threshold === undefined ? '' : ` 阈值 ${(threshold * 100).toFixed(0)}% ${state}`}`)
  }
  if (live) {
    for (const metric of live) {
      console.log(`  ${metric.label}：${metric.detail}`)
    }
  }
  if (datasetIssues.length) {
    console.warn(`语料自检发现 ${datasetIssues.length} 处问题，指标不可信`)
  }
  console.log(`报告：${reportPath}`)

  if (failures.length) {
    console.warn(`未达标指标 ${failures.length} 项：${failures.map(metric => metric.key).join(', ')}`)
    if (args.strict) {
      process.exitCode = 1
      return
    }
  }
  if (args.strict) {
    console.log('严格模式：全部指标达标')
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
