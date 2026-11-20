import assert from 'node:assert/strict'
import test from 'node:test'
import { gradeSeedPairing, runBenchmark, scoreControlled } from './bench.mjs'

test('近似重叠不算精确定位，缺失样本不写成满分', () => {
  const expected = [{ id: 'a', documentId: 'doc', type: 'E-FACT', quote: '原告支付五万元', paragraphIndex: 0, start: 0, end: 7, verdict: 'pass', purpose: 'declaration' }]
  const predicted = [{ id: 'p', documentId: 'doc', type: 'E-FACT', quote: '原告支付五万元。', location: { paragraphIndex: 0, start: 0, end: 8 }, verdict: 'miss' }]
  const score = gradeSeedPairing(expected, predicted)
  assert.equal(score.paired, 1)
  assert.deepEqual(score.locationAccuracy, { numerator: 0, denominator: 1, value: 0 })
  assert.equal(score.failures[0].actualVerdict, 'miss')
  assert.equal(gradeSeedPairing([], []).recall.value, null)
})

test('计分按位置给重复片段消歧，类型错、必拆漏抽、off 和 N/A 分开计', () => {
  const base = { documentId: 'doc', paragraphIndex: 0, purpose: 'declaration' }
  const quote = '付款凭证'
  const expected = [
    { ...base, id: 'row-2', type: 'E-EVID', quote, start: 5, end: 9, row: 2, column: 1 },
    { ...base, id: 'row-1', type: 'E-EVID', quote, start: 0, end: 4, row: 1, column: 1 },
    { ...base, id: 'purpose-missing', type: 'E-PURP', quote: '用于付款', start: 10, end: 14 },
    { ...base, id: 'outside-scope', type: 'E-PURP', purpose: 'not-applicable' },
  ]
  const predicted = [
    { ...base, id: 'near-first-wrong-type', type: 'E-PURP', quote, location: { paragraphIndex: 0, start: 0, end: 4, row: 1, column: 1 } },
    { ...base, id: 'near-second', type: 'E-EVID', quote, location: { paragraphIndex: 0, start: 5, end: 9, row: 2, column: 3 } },
    { ...base, id: 'duplicate-first', type: 'E-PURP', quote, location: { paragraphIndex: 0, start: 0, end: 4, row: 1, column: 1 } },
  ]
  const offCandidates = [{ ...base, id: 'off', type: 'E-LAW', quote: '某法', location: { paragraphIndex: 0, start: 16, end: 18 } }]
  const score = gradeSeedPairing(expected, predicted, { documents: [{ id: 'doc', docKey: 'zj' }], offCandidates })
  assert.equal(score.paired, 2)
  assert.deepEqual(score.recall, { numerator: 1, denominator: 3, value: 1 / 3 })
  assert.deepEqual(score.requiredRecall, score.recall)
  assert.deepEqual(score.precision, { numerator: 1, denominator: 4, value: 1 / 4 })
  assert.equal(score.typeAccuracy.numerator, 1)
  assert.equal(score.locationAccuracy.numerator, 1)
  assert.equal(score.offFalsePositiveRate.numerator, 1)
  assert.ok(score.offFalsePositiveRate.denominator > 1)
  assert.deepEqual(score.requiredMisses.map(item => item.id).sort(), ['purpose-missing', 'row-1'])
  assert.deepEqual(score.unscoredLabels, [{ id: 'outside-scope', purpose: 'not-applicable' }])
})

test('允许规格内的少量编辑差异，但不把无法锚定的金标当作定位成功', () => {
  const expected = [{ id: 'a', documentId: 'doc', type: 'E-FACT', quote: '当事人已经交付全部货物', paragraphIndex: 0, purpose: 'declaration' }]
  const predicted = [{ id: 'p', documentId: 'doc', type: 'E-FACT', quote: '当事人已经交还全部货物', location: { paragraphIndex: 0, start: 0, end: 11 } }]
  const score = gradeSeedPairing(expected, predicted, { documents: [{ id: 'doc', docKey: 'qs', paragraphs: [predicted[0].quote] }] })
  assert.equal(score.paired, 1)
  assert.equal(score.locationAccuracy.value, null)
  assert.deepEqual(score.unanchoredLabels, ['a'])
})

test('复合句只返回一条时，保留配对，同时记未拆部分的漏抽和额外误报', () => {
  const claim = '请求返还借款'
  const law = '《测试法》第一条'
  const base = { documentId: 'doc', paragraphIndex: 0, purpose: 'declaration' }
  const expected = [{ ...base, id: 'claim', type: 'E-CLAIM', quote: claim }, { ...base, id: 'law', type: 'E-LAW', quote: law }]
  for (const text of [`${claim}，依据${law}。`, `依据${law}，${claim}。`]) {
    const predicted = [{ ...base, id: 'merged', type: 'E-CLAIM', quote: text, location: { paragraphIndex: 0, start: 0, end: text.length } }]
    const score = gradeSeedPairing(expected, predicted, { documents: [{ id: 'doc', docKey: 'qs', paragraphs: [text] }] })
    assert.deepEqual(score.requiredRecall, { numerator: 1, denominator: 2, value: 0.5 })
    assert.deepEqual(score.precision, { numerator: 1, denominator: 2, value: 0.5 })
    assert.deepEqual(score.requiredMisses.map(item => item.id), ['law'])
    assert.deepEqual(score.unsplitPredictions.map(item => item.id), ['merged'])
  }
})

test('待核位置占位只校验指定元素和状态，不进入完整文书的抽取分母', () => {
  const documentId = 'placeholder'
  const quote = '请求撤销原判'
  const expected = [{ id: 'pending', documentId, paragraphIndex: 0, purpose: 'pending-placeholder', type: 'E-CLAIM', quote, verdict: 'pending' }]
  const prediction = { id: 'first', documentId, type: 'E-CLAIM', quote, verdict: 'pending', location: { paragraphIndex: 0, start: 0, end: quote.length } }
  const options = { documents: [{ id: documentId, docKey: 'lsh', paragraphs: [quote] }] }
  const score = gradeSeedPairing(expected, [prediction], options)
  assert.equal(score.precision.value, null)
  assert.equal(score.offFalsePositiveRate.value, null)
  assert.deepEqual(score.pendingPlaceholders, [{ id: 'pending', status: 'pass', actualVerdict: 'pending' }])
  assert.equal(gradeSeedPairing(expected, [{ ...prediction, verdict: 'pass' }], options).pendingPlaceholders[0].status, 'fail')
})

test('原始清单标注包含两列时，优先和同类型的原文子片段配对', () => {
  const text = '银行回单\t证明对方付款'
  const documentId = 'catalog'
  const expected = [{ id: 'purpose', documentId, paragraphIndex: 0, purpose: 'declaration', type: 'E-PURP', quote: text }]
  const predicted = [{ id: 'material', documentId, type: 'E-EVID', quote: '银行回单', location: { paragraphIndex: 0, start: 0, end: 4 } },
    { id: 'purpose', documentId, type: 'E-PURP', quote: '证明对方付款', location: { paragraphIndex: 0, start: 5, end: 11 } }]
  const score = gradeSeedPairing(expected, predicted, { documents: [{ id: documentId, docKey: 'zj', paragraphs: [text] }] })
  assert.equal(score.recall.value, 1)
  assert.equal(score.locationAccuracy.value, 0)
})

test('同一段的重复预测不能替另一段相同原文拿到召回', () => {
  const quote = '款项已经转入指定账户'
  const documentId = 'repeated'
  const expected = [0, 1].map(paragraphIndex => ({ id: `element-${paragraphIndex}`, documentId, paragraphIndex, type: 'E-FACT', purpose: 'declaration', quote }))
  const predicted = [0, 1].map(index => ({ id: `copy-${index}`, documentId, type: 'E-FACT', quote,
    location: { paragraphIndex: 0, start: 0, end: quote.length } }))
  const score = gradeSeedPairing(expected, predicted, { documents: [{ id: documentId, docKey: 'qs', paragraphs: [quote, quote] }] })
  assert.equal(score.recall.value, 0.5)
  assert.equal(score.precision.value, 0.5)
  assert.equal(score.duplicatePredictions.length, 1)
  assert.deepEqual(score.requiredMisses.map(item => item.id), ['element-1'])
})

test('段落与字符锚点相同时，重复表格原文按单元格消歧', () => {
  const quote = '付款凭证'
  const documentId = 'catalog'
  const base = { paragraphIndex: 0, start: 0, end: quote.length, row: 1 }
  const expected = [1, 2].map(column => ({ id: `cell-${column}`, documentId, type: 'E-EVID',
    purpose: 'declaration', quote, location: { ...base, column } }))
  const predict = column => ({ id: `prediction-${column}`, documentId, type: 'E-EVID', quote,
    location: { ...base, column } })
  const options = { documents: [{ id: documentId, docKey: 'zj' }] }

  const score = gradeSeedPairing(expected, [predict(1), predict(3)], options)
  assert.deepEqual(score.recall, { numerator: 1, denominator: 2, value: 0.5 })
  assert.deepEqual(score.precision, { numerator: 1, denominator: 2, value: 0.5 })
  assert.equal(score.locationAccuracy.value, 1)
  assert.deepEqual(score.requiredMisses.map(item => item.id), ['cell-2'])
  assert.deepEqual(score.unmatchedPredictions.map(item => item.id), ['prediction-3'])
  assert.equal(gradeSeedPairing(expected, [predict(2), predict(1)], options).locationAccuracy.value, 1)

  const approximate = column => ({ ...predict(column), quote: '付款 凭证' })
  assert.equal(gradeSeedPairing(expected, [approximate(1), approximate(3)], options).recall.value, 0.5)
})

test('固定评测区分可执行规则、不适用与未跑交付环节', async () => {
  const report = await runBenchmark('all')
  assert.equal(report.seed.documents, 11)
  assert.equal(report.seed.rawLabels, 36)
  assert.equal(report.adversarial.declared, 12)
  assert.ok(report.adversarial.rows.some(item => item.status === 'not-run'))
  assert.equal(report.adversarial.redlineRegressions.find(item => item.id === 'EXTRACT-MIXED-APPEAL').status, 'pass')
  assert.equal(report.extra.status, 'not-run')
  assert.equal(report.systemGrade, null)
  assert.equal(report.production.status, 'not-run')
})

test('对抗样本经过抽取与原文证据核验；移除原文或改写预期不能得分', async () => {
  const report = await runBenchmark('adversarial')
  assert.equal(report.adversarial.rows.find(item => item.id === 'ADV-06').status, 'pass')
  const priorJudgment = report.adversarial.rows.find(item => item.id === 'ADV-08')
  assert.equal(priorJudgment.status, 'partial')
  assert.equal(priorJudgment.actual.verdict, 'fail')
  assert.ok(priorJudgment.unmeasured.includes('allowCitation'))
  const input = { docKey: 'ss', quote: '原审驳回我方赔偿请求。', materials: [{ name: '受控一审判决摘录', locator: '判项第一项', text: '被告向原告赔偿1000元。', anchorParagraph: 0 }] }
  const expected = { type: 'E-ERR', verdict: 'fail', failedCheck: 'A2', allowCitation: false }
  assert.equal((await scoreControlled({ id: 'original', input, expected })).status, 'partial')
  assert.equal((await scoreControlled({ id: 'mutant', input, expected: { ...expected, verdict: 'pass' } })).status, 'fail')
  input.materials[0].text = ''
  const noQuote = await scoreControlled({ id: 'mutant', input, expected })
  assert.equal(noQuote.status, 'fail')
  assert.equal(noQuote.actual.verdict, 'miss')
})

test('T4 法条对抗样本经过生产判定器，来源及替代建议分开计分', async () => {
  const report = await runBenchmark('all')
  const adversarial = new Map(report.adversarial.rows.map(item => [item.id, item]))
  for (const id of ['ADV-02', 'ADV-03', 'ADV-04', 'ADV-10']) assert.equal(adversarial.get(id).status, 'pass', id)
  assert.equal(adversarial.get('ADV-03').actual.verifiedText.includes('第五百七十七条'), true)
  assert.equal(adversarial.get('ADV-10').actual.sourceTier, 'l0')
  const regressions = new Map(report.adversarial.redlineRegressions.map(item => [item.id, item]))
  for (const id of ['STATUTE-REPLACEMENT-ONLY', 'TOOL-EMPTY', 'TOOL-NO-HITS', 'TOOL-403', 'R3-ACCEPTED-QUOTE']) {
    assert.equal(regressions.get(id).status, 'pass', id)
  }
  assert.deepEqual(report.seed.statuteChecks.map(item => [item.id, item.actual.B1, item.actual.B2, item.actual.B3]), [
    ['c1-l2', 'pass', 'warn', 'miss'], ['c1-l4', 'pass', 'fail', 'miss'], ['c1-s4', 'pass', 'warn', 'miss'],
  ])
})

test('L1 缺源与同名异期用例实际执行，桌面徽标仍由桌面端单独验证', async () => {
  const report = await runBenchmark('adversarial')
  const byId = new Map(report.adversarial.redlineRegressions.map(row => [row.id, row]))
  assert.equal(byId.get('SOURCE-ABSENT').status, 'partial')
  assert.deepEqual(byId.get('SOURCE-ABSENT').actual.sources, [])
  assert.equal(byId.get('SOURCE-ABSENT').actual.sourceTier, 'l0')
  assert.deepEqual(byId.get('SOURCE-ABSENT').unmeasured, ['coloredSourceBadges'])
  assert.equal(byId.get('SOURCE-SAME-NAME-WRONG-PERIOD').status, 'pass')
  assert.deepEqual(byId.get('SOURCE-SAME-NAME-WRONG-PERIOD').actual.sources, [])
  assert.equal(byId.get('SOURCE-SAME-NAME-WRONG-PERIOD').actual.substitutedSource, false)
})

test('T5 用独立裁判详情执行案号、原文、种子和级联验收', async () => {
  const report = await runBenchmark('all')
  const absent = report.adversarial.rows.find(item => item.id === 'ADV-01')
  assert.equal(absent.status, 'pass')
  assert.equal(absent.actual.checks.C1.outcome, 'fail')
  assert.match(absent.actual.reason, /案号未命中/u)
  assert.deepEqual(absent.actual.sources, [])

  const regressions = new Map(report.adversarial.redlineRegressions.map(item => [item.id, item]))
  for (const id of ['CASE-SUMMARY-NOT-OPERATIVE-TEXT', 'CASE-NO-BODY', 'CASE-REVERSED-OPERATIVE', 'CASCADE-LAW', 'CASCADE-FACT']) {
    assert.equal(regressions.get(id)?.status, 'pass', id)
  }
  assert.equal(regressions.get('CASE-SUMMARY-NOT-OPERATIVE-TEXT').actual.sourceTier, 'l0')
  assert.equal(regressions.get('CASCADE-FACT').actual.label, '近似类比')
  assert.deepEqual(report.seed.caseChecks.map(item => [item.id, item.status, item.actual.match]), [
    ['c1-q7', 'pass', 'strict'], ['c1-l3', 'pass', 'strict'],
  ])
  for (const item of report.seed.caseChecks) {
    assert.equal(item.frozenVerdict, 'pass')
    assert.equal(item.actual.fourElements, true)
    assert.deepEqual(Object.values(item.actual.checks).map(check => check.outcome), Array(7).fill('pass'))
  }
  assert.deepEqual(report.adversarial.caseMetrics.operativeCitations, { cited: 1, detailBeforeCitation: 1, rate: 1 })
})

test('固定详情分别记录权威查无、搜索零候选、空响应、超时和 403', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('离线评测不得请求网络'))
  const report = await runBenchmark('adversarial')
  const rows = new Map([...report.adversarial.rows, ...report.adversarial.redlineRegressions].map(row => [row.id, row]))
  for (const [id, check, verdict] of [
    ['ADV-01', 'C1', 'fail'], ['ADV-02', 'B1', 'fail'],
    ['CASE-NO-HITS', 'C1', 'pending'], ['CASE-EMPTY', 'C1', 'pending'],
    ['CASE-TIMEOUT', 'C1', 'pending'], ['CASE-403', 'C1', 'pending'],
    ['TOOL-NO-HITS', 'B1', 'pending'], ['TOOL-EMPTY', 'B1', 'pending'],
    ['ADV-10', 'B1', 'pending'], ['TOOL-403', 'B1', 'pending'],
  ]) {
    const row = rows.get(id)
    assert.equal(row?.status, 'pass', id)
    assert.equal(row.actual.checks[check].outcome, verdict, id)
    assert.equal(row.actual.allowCitation, false, id)
    assert.deepEqual(row.actual.sources, [], id)
  }
  assert.equal(rows.get('CASE-NO-HITS').actual.queryOutcome, 'no-candidates')
  assert.equal(rows.get('CASE-EMPTY').actual.detailOutcome, 'empty-response')
  assert.equal(rows.get('CASE-403').actual.detailOutcome, 'forbidden')
  assert.equal(rows.get('CASE-NO-BODY').actual.allowOperativeQuote, false)
  assert.equal(rows.get('CASE-EXACT-OPERATIVE').actual.detailBeforeCitation, true)
  assert.equal(rows.get('STATUTE-HISTORICAL').status, 'pass')
  assert.equal(rows.get('STATUTE-HISTORICAL').actual.checks.B3.outcome, 'pass')
  assert.equal(rows.get('STATUTE-HISTORICAL').actual.validity, 'REPEALED')
  assert.equal(rows.get('STATUTE-HISTORICAL').actual.historicallyApplicable, true)
  assert.equal(rows.get('ADV-03').actual.historicallyApplicable, false)
  assert.equal(globalThis.fetch.mock.callCount(), 0)
})

test('增删真值或实际结果时区分多抽、漏抽、错类、错位及空分母', () => {
  const text = '被告支付五万元。'
  const expected = [{ id: 'gold', documentId: 'doc', type: 'E-FACT', quote: text, purpose: 'declaration', paragraphIndex: 0, start: 0, end: text.length }]
  const location = { paragraphIndex: 0, start: 0, end: text.length }
  const actual = [{ id: 'prediction', documentId: 'doc', type: 'E-FACT', quote: text, location }]
  const options = { documents: [{ id: 'doc', docKey: 'qs', paragraphs: [text] }] }
  const grade = (labels, predictions) => gradeSeedPairing(labels, predictions, options)

  assert.deepEqual(grade(expected, actual).extractionCounts, { tp: 1, fp: 0, fn: 0 })
  const missingLabel = grade([], actual)
  assert.deepEqual(missingLabel.extractionCounts, { tp: 0, fp: 1, fn: 0 })
  assert.deepEqual(missingLabel.recall, { numerator: 0, denominator: 0, value: null })
  assert.deepEqual(missingLabel.unmatchedPredictions.map(row => row.id), ['prediction'])
  const missingPrediction = grade(expected, [])
  assert.deepEqual(missingPrediction.extractionCounts, { tp: 0, fp: 0, fn: 1 })
  assert.deepEqual(missingPrediction.precision, { numerator: 0, denominator: 0, value: null })
  assert.deepEqual(missingPrediction.requiredMisses.map(row => row.id), ['gold'])

  const wrongType = grade(expected, [{ ...actual[0], type: 'E-CLAIM' }])
  assert.deepEqual(wrongType.extractionCounts, { tp: 0, fp: 1, fn: 1 })
  assert.deepEqual(wrongType.typeAccuracy, { numerator: 0, denominator: 1, value: 0 })
  assert.deepEqual(wrongType.locationAccuracy, { numerator: 1, denominator: 1, value: 1 })
  const shifted = grade(expected, [{ ...actual[0], location: { ...location, start: 1 } }])
  assert.deepEqual(shifted.extractionCounts, { tp: 1, fp: 0, fn: 0 })
  assert.deepEqual(shifted.locationAccuracy, { numerator: 0, denominator: 1, value: 0 })
})

test('扩充覆盖逐份回查文书、材料、案由和防御立场，未核定前只报告覆盖', async () => {
  const report = await runBenchmark('extra')
  const extra = report.extra
  assert.equal(extra.status, 'not-run')
  assert.equal(extra.labels, 0)
  assert.equal(extra.documents, 30)
  assert.deepEqual(extra.coverage.causes.sort(), ['买卖合同纠纷', '房屋租赁合同纠纷', '民间借贷纠纷'])
  assert.equal(Object.keys(extra.coverage.byType).length, 10)
  for (const group of Object.values(extra.coverage.byType)) {
    assert.deepEqual(group.difficulties, { simple: 1, standard: 1, adversarial: 1 })
    assert.ok(group.defense >= 1)
  }
  assert.deepEqual(extra.coverage.issues, [])
  assert.equal(new Set(extra.inventory.map(item => item.id)).size, 30)
  assert.ok(extra.inventory.every(item => item.materialIds.length > 0 && item.title && item.cause && item.side))
  assert.match(report.fixtureHashes['extra/documents'], /^[a-f0-9]{64}$/u)
  assert.match(report.fixtureHashes['extra/materials'], /^[a-f0-9]{64}$/u)
})

test('法条 R3 区分格式容差、正确拦截和错误外发', async () => {
  const report = await runBenchmark('adversarial')
  const rows = new Map(report.adversarial.redlineRegressions.map(row => [row.id, row]))
  assert.equal(rows.get('STATUTE-QUOTE-FORMATTING')?.actual.checks.B3.outcome, 'pass')
  assert.equal(rows.get('STATUTE-QUOTE-PERIOD')?.actual.checks.B3.outcome, 'fail')
  assert.equal(rows.get('STATUTE-QUOTE-PERIOD')?.actual.redlineHitWhenBlocked, false)
  assert.deepEqual(rows.get('R3-FORMATTING-ACCEPTED')?.actual, { redlineHit: false })
  assert.deepEqual(rows.get('R3-PERIOD-EXPORTED')?.actual, { redlineHit: true })
  assert.deepEqual(rows.get('R3-ACCEPTED-QUOTE')?.actual, { redlineHit: true })
  for (const id of ['STATUTE-QUOTE-FORMATTING', 'STATUTE-QUOTE-PERIOD', 'R3-FORMATTING-ACCEPTED', 'R3-PERIOD-EXPORTED', 'R3-ACCEPTED-QUOTE']) {
    assert.equal(rows.get(id).status, 'pass', id)
  }
})
