import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { env } from '../../src/config/env.ts'
import { applyConfidenceCalibration, confidenceBucket, parseConfidenceCalibration } from '../../src/intelligence/verification/confidence.ts'
import { recordVerification } from '../../src/intelligence/verification/workspace-review.ts'
import { fitCalibration, prepareAnnotations } from './calibrate-confidence.mjs'

const item = { id: 'statement', type: 'E-FACT', verdict: 'fail', quote: '货款已全部支付。',
  location: { paragraphId: 'p', start: 0, end: 8 }, reason: '已核余额与声明相冲突。', conf: null,
  checks: { A1: { outcome: 'pass', reason: '原文可回查。' }, A2: { outcome: 'fail', reason: '金额不一致。' } },
  sources: [{ tier: 'l1', id: 'material', quote: '尚欠货款100元。', locator: '第1页' }] }
const key = confidenceBucket(item)

test('标注清单可回查原文，且不包含 AI 结论、理由或推荐来源', () => {
  const certificate = { id: 'doc', caseId: 'case', title: '起诉状', linkageInputKey: 'input',
    verification: { inputKey: 'input', revision: 'revision', verifiedAt: '2026-11-20', profileVersion: 'rules', declarations: [item] } }
  const { predictions, annotations } = prepareAnnotations({ certificates: [certificate, { ...certificate, id: 'stale', linkageStale: true }] })
  assert.equal(predictions.samples.length, 1)
  assert.equal(annotations.samples.length, 1)
  assert.equal(annotations.samples[0].quote, item.quote)
  assert.equal(annotations.samples[0].verdict, null)
  assert.equal(predictions.samples[0].id, annotations.samples[0].id)
  assert.doesNotMatch(JSON.stringify(annotations), /金额不一致|尚欠货款|已核余额|"fail"/u)
})

function fixture(calibrationCases = 80, validationCases = 80, validationAgreements = 64) {
  const samples = []
  for (const [split, count, agreed] of [['calibration', calibrationCases, Math.floor(calibrationCases * 0.8)], ['validation', validationCases, validationAgreements]]) {
    for (let index = 0; index < count; index++) {
      const id = `${split}-${index}`
      samples.push({ id, caseId: id, split, bucket: key, verdict: 'fail', reviewedVerdict: index < agreed ? 'fail' : 'pass' })
    }
  }
  return {
    predictions: { profileVersion: 'rules', samples: samples.map(({ reviewedVerdict, ...sample }) => sample) },
    annotations: { reviewer: 'reviewer-id', reviewedAt: '2026-11-20', samples: samples.map(({ id, reviewedVerdict }) => ({ id, verdict: reviewedVerdict })) },
  }
}

test('按独立案件校准，允许有充分证据支持的不通过结论有高置信度', () => {
  const { predictions, annotations } = fixture()
  const calibration = parseConfidenceCalibration(fitCalibration(predictions, annotations).artifact, 'rules')
  const [scored] = applyConfidenceCalibration([item], calibration)
  assert.equal(scored.verdict, 'fail')
  assert.equal(scored.conf, 80)
  assert.equal(scored.confidenceCalibration.validationCases, 80)
  assert.equal(scored.confidenceCalibration.validationAgreementPercent, 80)
  assert.match(scored.confidenceCalibration.basis, /原文可定位/u)
})

test('样本不足、留出集表现不符或核验规则版本变化时不给概率', () => {
  const small = fixture(5, 5, 4)
  const badHoldout = fixture(80, 80, 36)
  assert.equal(fitCalibration(small.predictions, small.annotations).artifact, null)
  assert.equal(fitCalibration(badHoldout.predictions, badHoldout.annotations).artifact, null)
  const ready = fixture()
  assert.equal(parseConfidenceCalibration(fitCalibration(ready.predictions, ready.annotations).artifact, 'updated-rules'), undefined)
  assert.equal(applyConfidenceCalibration([{ ...item, conf: 88 }], undefined)[0].conf, null)
})

test('同案多条不能扩大验证样本量，同案跨集合会被拒绝', () => {
  const { predictions, annotations } = fixture()
  predictions.samples.filter(sample => sample.split === 'validation').forEach(sample => { sample.caseId = 'only-one-case' })
  assert.equal(fitCalibration(predictions, annotations).artifact, null)
  predictions.samples.at(-1).caseId = predictions.samples[0].caseId
  assert.throws(() => fitCalibration(predictions, annotations), /同一案件/u)
})

test('保存核验结果时写入已验证的概率来源，损坏的校准文件不产生分数', t => {
  const root = fileURLToPath(new URL('../../../tmp/', import.meta.url))
  mkdirSync(root, { recursive: true })
  const directory = mkdtempSync(join(root, 'lawverify-confidence-'))
  const previousPath = env.VERIFICATION_CALIBRATION_FILE
  const file = join(directory, 'calibration.json')
  t.after(() => {
    env.VERIFICATION_CALIBRATION_FILE = previousPath
    rmSync(directory, { recursive: true, force: true })
  })
  env.VERIFICATION_CALIBRATION_FILE = file
  const { predictions, annotations } = fixture()
  const { artifact } = fitCalibration(predictions, annotations)
  const save = () => recordVerification({ user: { name: '测试用户' } }, undefined,
    { version: 1, profileVersion: 'rules', inputKey: 'materials', classificationRequired: false, declarations: [item] })
  writeFileSync(file, JSON.stringify(artifact))
  const [saved] = save().declarations
  assert.equal(saved.conf, 80)
  assert.equal(saved.confidenceCalibration.version, artifact.version)
  writeFileSync(file, JSON.stringify({ ...artifact, version: 'cal-0000000000000000' }))
  assert.equal(save().declarations[0].conf, null)
})
