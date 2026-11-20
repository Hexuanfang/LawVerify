import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import type { Declaration } from './protocol.js'

const sourceLabels = {
  official: '已取得官方法源详情并定位原文',
  judgment: '已取得裁判详情并定位原文',
  located: '原文可定位',
  missing: '缺少可定位原文',
} as const

const countSchema = z.object({ cases: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  agreements: z.number().int().nonnegative() }).refine(item => item.agreements <= item.cases)
const bucketSchema = z.object({ calibration: countSchema, validation: countSchema })
const bucketKeySchema = z.string().regex(/^E-(?:SUBJ|CLAIM|FACT|CALC|EVID|PURP|LAW|CASE|FOCUS|PROC|CROSS|ERR)\|(pass|warn|fail|miss)\|(official|judgment|located|missing)\|(resolved|open)$/u)
const artifactSchema = z.object({ method: z.literal('agreement-by-case-v1'), version: z.string().regex(/^cal-[a-f0-9]{16}$/u),
  profileVersion: z.string().min(1), buckets: z.record(bucketKeySchema, bucketSchema) })
type Calibration = z.infer<typeof artifactSchema>
type CaseCounts = z.infer<typeof countSchema>

export function confidenceCalibrationVersion(profileVersion: string, buckets: Calibration['buckets']) {
  const entries = Object.entries(buckets).sort(([left], [right]) => left.localeCompare(right))
  const hash = createHash('sha256').update(JSON.stringify(['agreement-by-case-v1', profileVersion, entries])).digest('hex')
  return `cal-${hash.slice(0, 16)}`
}

export function confidenceBucket(item: Declaration) {
  const checks = Object.values(item.checks).filter(check => check.outcome !== 'not-applicable')
  if (!checks.length) return undefined
  const tier = item.type === 'E-LAW' ? 'l2' : item.type === 'E-CASE' ? 'l3' : 'l1'
  const located = item.sources.some(source => source.tier === tier && source.quote?.trim() && source.locator?.trim())
  const source = !located ? 'missing' : item.statuteVerification?.official?.outcome === 'found' ? 'official'
    : item.caseVerification?.detailOutcome === 'found' ? 'judgment' : 'located'
  const open = checks.some(check => ['pending', 'miss', 'warn'].includes(check.outcome))
  // 已比对且仅等待律师确认的支持结论，按自动判定的支持采样。
  const supported = located && checks.every(check => check.outcome === 'pass')
  const verdict = item.verdict === 'pending' || item.verdict === 'note' ? supported && 'pass' : item.verdict
  return verdict ? `${item.type}|${verdict}|${source}|${open ? 'open' : 'resolved'}` : undefined
}

export function eligibleCalibrationBucket({ calibration, validation }: { calibration: CaseCounts; validation: CaseCounts }) {
  if (calibration.cases < 40 || validation.cases < 40) return false
  const estimate = calibration.agreements / calibration.cases
  const heldOut = validation.agreements / validation.cases
  if (Math.abs(estimate - heldOut) > 0.10) return false
  // 验证集每个案件只取一条。用 Wilson 区间约束小样本和极端比例的波动。
  const z = 1.96
  const n = validation.cases
  const denominator = 1 + z ** 2 / n
  const center = (heldOut + z ** 2 / (2 * n)) / denominator
  const halfWidth = z * Math.sqrt(heldOut * (1 - heldOut) / n + z ** 2 / (4 * n ** 2)) / denominator
  return Math.abs(center - estimate) + halfWidth <= 0.20
}

export function parseConfidenceCalibration(value: unknown, profileVersion: string): Calibration | undefined {
  const parsed = artifactSchema.safeParse(value)
  if (!parsed.success || parsed.data.profileVersion !== profileVersion) return
  if (parsed.data.version !== confidenceCalibrationVersion(profileVersion, parsed.data.buckets)) return
  const buckets = Object.values(parsed.data.buckets)
  if (buckets.length && buckets.every(eligibleCalibrationBucket)) return parsed.data
}

export function readConfidenceCalibration(file: string | undefined, profileVersion: string) {
  if (!file) return
  try {
    return parseConfidenceCalibration(JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/u, '')), profileVersion)
  } catch {
    return undefined
  }
}

export function applyConfidenceCalibration(declarations: Declaration[], calibration: Calibration | undefined): Declaration[] {
  return declarations.map(item => {
    const key = calibration && confidenceBucket(item)
    const bucket = key ? calibration?.buckets[key] : undefined
    if (!bucket || !calibration || !key) return item.conf == null && !item.confidenceCalibration ? item
      : { ...item, conf: null, confidenceCalibration: undefined }
    const [, , source, checks] = key.split('|')
    const basis = `${sourceLabels[source as keyof typeof sourceLabels]}，${checks === 'open' ? '存在预警、缺源或待定检查' : '检查无待定项'}`
    return { ...item, conf: Math.round(bucket.calibration.agreements / bucket.calibration.cases * 100), confidenceCalibration: {
      version: calibration.version, basis, calibrationCases: bucket.calibration.cases, validationCases: bucket.validation.cases,
      validationAgreementPercent: Math.round(bucket.validation.agreements / bucket.validation.cases * 100),
    } }
  })
}
