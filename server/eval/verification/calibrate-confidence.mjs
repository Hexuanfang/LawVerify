import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { confidenceBucket, confidenceCalibrationVersion, eligibleCalibrationBucket, parseConfidenceCalibration } from '../../src/intelligence/verification/confidence.ts'

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const verdict = z.enum(['pass', 'warn', 'fail', 'miss', 'pending'])
const predictionsSchema = z.object({ profileVersion: z.string().min(1),
  samples: z.array(z.object({ id: z.string().min(1), caseId: z.string().min(1),
    split: z.enum(['calibration', 'validation']), bucket: z.string().min(1), verdict })) })
const annotationsSchema = z.object({ reviewer: z.string().trim().min(1), reviewedAt: z.iso.date(),
  samples: z.array(z.object({ id: z.string().min(1), verdict: verdict.nullable() })) })

export function prepareAnnotations(snapshot) {
  const certificates = (snapshot.workspace ?? snapshot).certificates
  if (!Array.isArray(certificates)) throw new Error('输入应为工作区 JSON 快照。')
  const samples = new Map()
  const annotations = []
  let profileVersion
  for (const document of certificates) {
    const result = document.verification
    if (!result?.revision || !result.verifiedAt || !document.linkageInputKey || document.linkageStale
      || result.dirty || result.inputKey !== document.linkageInputKey) continue
    for (const item of result.declarations) {
      const bucket = confidenceBucket(item)
      if (!bucket) continue
      if (profileVersion && profileVersion !== result.profileVersion) {
        throw new Error('校准快照包含不同核验规则版本，请用同一版本重核后分别导出。')
      }
      profileVersion = result.profileVersion
      const id = digest([document.caseId, document.id, result.revision, item.id])
      if (samples.has(id)) continue
      const caseId = digest(document.caseId)
      const split = Number.parseInt(caseId.slice(0, 8), 16) % 3 === 0 ? 'validation' : 'calibration'
      samples.set(id, { id, caseId, split, bucket, verdict: bucket.split('|')[1] })
      annotations.push({ id, caseId: document.caseId, documentId: document.id, title: document.title, type: item.type,
        location: item.location, quote: item.quote, verdict: null })
    }
  }
  if (!samples.size) throw new Error('快照没有当前有效且已形成自动结论的声明。')
  return { predictions: { profileVersion, samples: [...samples.values()] },
    annotations: { reviewer: '', reviewedAt: '', samples: annotations } }
}

export function fitCalibration(predictions, annotations) {
  const { profileVersion, samples } = predictionsSchema.parse(predictions)
  const reviewed = annotationsSchema.parse(annotations).samples
  const byId = new Map()
  const splits = new Map()
  for (const sample of samples) {
    if (byId.has(sample.id)) throw new Error('AI 快照包含重复声明标识。')
    if (splits.has(sample.caseId) && splits.get(sample.caseId) !== sample.split) {
      throw new Error('同一案件不能同时进入校准集和验证集。')
    }
    if (sample.bucket.split('|')[1] !== sample.verdict) throw new Error('AI 快照的分组与核验结论不一致。')
    byId.set(sample.id, sample)
    splits.set(sample.caseId, sample.split)
  }
  const labels = new Map()
  for (const sample of reviewed) {
    if (!byId.has(sample.id) || labels.has(sample.id)) throw new Error('律师标注包含未知或重复的声明标识。')
    labels.set(sample.id, sample.verdict)
  }

  const representatives = new Map()
  // 在查看标注前固定代表声明，未审的代表不使用其他声明替补。
  for (const sample of samples) {
    const key = JSON.stringify([sample.bucket, sample.caseId])
    const rank = digest(sample.id)
    const current = representatives.get(key)
    if (!current || rank < current.rank) representatives.set(key, { sample, rank })
  }
  const groups = new Map()
  for (const { sample } of representatives.values()) {
    if (!groups.has(sample.bucket)) groups.set(sample.bucket, {
      calibration: { cases: 0, agreements: 0 }, validation: { cases: 0, agreements: 0 },
    })
    const label = labels.get(sample.id)
    if (label == null) continue
    const counts = groups.get(sample.bucket)[sample.split]
    counts.cases++
    counts.agreements += Number(label === sample.verdict)
  }
  const report = [...groups].sort(([left], [right]) => left.localeCompare(right)).map(([bucket, counts]) => ({
    bucket, ...counts, eligible: eligibleCalibrationBucket(counts),
  }))
  const buckets = Object.fromEntries(report.filter(group => group.eligible)
    .map(({ bucket, calibration, validation }) => [bucket, { calibration, validation }]))
  const version = confidenceCalibrationVersion(profileVersion, buckets)
  const artifact = { method: 'agreement-by-case-v1', profileVersion, version, buckets }
  if (Object.keys(buckets).length && !parseConfidenceCalibration(artifact, profileVersion)) {
    throw new Error('AI 快照包含未知校准分组。')
  }
  return { artifact: Object.keys(buckets).length ? artifact : null, report }
}

const readJson = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/u, ''))
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })

function run([mode, input, second, output]) {
  if (mode === 'prepare' && input && second && !output) {
    const { predictions, annotations } = prepareAnnotations(readJson(input))
    mkdirSync(second)
    writeJson(join(second, 'predictions.json'), predictions)
    writeJson(join(second, 'annotations.json'), annotations)
    process.stdout.write('已生成独立标注清单和 AI 预测快照。\n')
  } else if (mode === 'fit' && input && second && output) {
    const { artifact, report } = fitCalibration(readJson(input), readJson(second))
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
    if (!artifact) {
      process.stderr.write('样本量或独立验证未达标，未生成可加载的校准文件。\n')
      process.exitCode = 2
      return
    }
    writeJson(output, artifact)
  } else {
    throw new Error('用法：calibrate-confidence.mjs prepare <工作区JSON> <新输出目录>，或 fit <predictions.json> <annotations.json> <新校准文件>')
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    run(process.argv.slice(2))
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n')
    process.exitCode = 1
  }
}
