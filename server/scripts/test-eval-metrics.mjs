import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  checkDatasetConsistency,
  checkLinkGrounded,
  evaluateGating,
  evaluateGrounding,
  evaluateNumbering,
  evaluateParseSuccess,
  evaluateRecall,
  parseLocatorPages,
  rankMaterialCandidates,
} from '../eval/metrics.ts'

const paged = pages => pages.map((content, index) => `-- 第 ${index + 1}/${pages.length} 页 --\n${content}`).join('\n')

const baseMaterial = {
  id: 'm-1',
  number: 'E01',
  sourceNumber: '证据1',
  name: '购销合同',
  type: 'pdf',
  relativePath: '证据1 购销合同.pdf',
  text: paged([
    '甲乙买卖合同\n甲方：甲科技有限公司\n乙方：乙贸易有限公司',
    '合同总价款为人民币120万元，分两期支付。',
  ]),
}

const baseSample = {
  id: 'syn-test',
  corpus: 'synthetic',
  case: { name: '测试案件', role: 'plaintiff' },
  materials: [baseMaterial],
  paragraphs: [{ id: 'p-1', text: '合同总价款为人民币120万元。' }],
  claims: [
    {
      id: 'c-1',
      paragraphId: 'p-1',
      sentenceIndex: 0,
      sentenceText: '合同总价款为人民币120万元。',
      expect: { link: true, materialId: 'm-1', locator: '第 2 页', relation: 'support', statutes: [], cases: [] },
    },
  ],
}

test('定位解析：支持单页、跨页与全文三种写法', () => {
  assert.deepEqual(parseLocatorPages('第 2 页'), [2])
  assert.deepEqual(parseLocatorPages('第1-3页'), [1, 2, 3])
  assert.equal(parseLocatorPages('全文'), null)
  assert.equal(parseLocatorPages(''), null)
})

test('候选召回：命中期望材料记正确，未进入候选集记失败', () => {
  const sample = {
    ...baseSample,
    materials: [
      baseMaterial,
      { ...baseMaterial, id: 'm-2', number: 'E02', sourceNumber: '证据2', name: '付款凭证', relativePath: '证据2 付款凭证.pdf', text: '交易金额：人民币600,000.00元' },
    ],
  }

  const hit = evaluateRecall([sample], 1)
  assert.equal(hit.total, 1)
  assert.equal(hit.correct, 1)
  assert.equal(hit.value, 1)

  const miss = evaluateRecall([{
    ...sample,
    claims: [{ ...sample.claims[0], expect: { ...sample.claims[0].expect, materialId: 'm-9' } }],
  }], 1)
  assert.equal(miss.value, 0)
  assert.equal(miss.failures.length, 1)
})

test('候选召回：只有应挂接材料的主张句参与计分', () => {
  const result = evaluateRecall([{
    ...baseSample,
    claims: [{ ...baseSample.claims[0], expect: { ...baseSample.claims[0].expect, materialId: null } }],
  }])
  assert.equal(result.total, 0)
})

test('候选排序：同一查询下更贴题的材料排在前面', () => {
  const ranked = rankMaterialCandidates('合同总价款120万元', [
    baseMaterial,
    { ...baseMaterial, id: 'm-2', name: '庭审笔录', relativePath: '证据2 庭审笔录.pdf', text: '审判长：双方对购销合同本身的签订是否有异议' },
  ], 2)
  assert.equal(ranked[0], 'm-1')
})

test('句级门控：身份类与标题句应跳过，事实句应放行', () => {
  const positive = evaluateGating([baseSample])
  assert.equal(positive.value, 1)

  const negative = evaluateGating([{
    ...baseSample,
    claims: [{ ...baseSample.claims[0], sentenceText: '甲方：甲科技有限公司', expect: { ...baseSample.claims[0].expect, link: false } }],
  }])
  assert.equal(negative.value, 1)

  const mismatched = evaluateGating([{
    ...baseSample,
    claims: [{ ...baseSample.claims[0], sentenceText: '甲方：甲科技有限公司' }],
  }])
  assert.equal(mismatched.value, 0)
  assert.equal(mismatched.failures.length, 1)
})

test('引用可溯：引用是原文子串且定位存在时才算可溯', () => {
  const good = checkLinkGrounded(baseMaterial, '第 2 页', '合同总价款为人民币120万元，分两期支付')
  assert.equal(good.grounded, true)

  const wrongPage = checkLinkGrounded(baseMaterial, '第 5 页', '合同总价款为人民币120万元，分两期支付')
  assert.equal(wrongPage.grounded, false)

  const wrongQuote = checkLinkGrounded(baseMaterial, '第 2 页', '合同总价款为人民币999万元')
  assert.equal(wrongQuote.grounded, false)

  const missingMaterial = checkLinkGrounded(undefined, '第 2 页', '合同总价款')
  assert.equal(missingMaterial.grounded, false)
})

test('引用可溯率：错挂计入失败并保留失败明细', () => {
  const result = evaluateGrounding([baseSample], [
    { id: 'l-1', sampleId: 'syn-test', materialId: 'm-1', locator: '第 2 页', quote: '合同总价款为人民币120万元，分两期支付' },
    { id: 'l-2', sampleId: 'syn-test', materialId: 'm-1', locator: '第 2 页', quote: '合同总价款为人民币999万元' },
  ])
  assert.equal(result.total, 2)
  assert.equal(result.correct, 1)
  assert.equal(result.value, 0.5)
  assert.equal(result.failures[0].id, 'l-2')
})

test('编号一致性：引用编号与目录编号必须唯一且可由路径推断', () => {
  const ok = evaluateNumbering([baseSample])
  assert.equal(ok.value, 1)

  const broken = evaluateNumbering([{
    ...baseSample,
    materials: [{ ...baseMaterial, sourceNumber: '证据9' }],
  }])
  assert.equal(broken.value, 0)
  assert.match(broken.failures[0].reason, /引用编号不一致/)

  const duplicated = evaluateNumbering([{
    ...baseSample,
    materials: [baseMaterial, { ...baseMaterial, id: 'm-2' }],
  }])
  assert.equal(duplicated.value, 0)
  assert.match(duplicated.failures[0].reason, /重复/)
})

test('解析健壮率：期望能解析的响应全部解析成功', () => {
  const entries = [
    { id: 'f-1', sampleId: 'syn-test', kind: 'normal', stage: 'links', paragraphIds: ['p-1'], raw: '{"paragraphs":[{"paragraphId":"p-1","evidenceLinks":[]}]}', expectParse: true },
    { id: 'f-2', sampleId: 'syn-test', kind: 'garbage', stage: 'links', paragraphIds: ['p-1'], raw: '抱歉，无法完成。', expectParse: false },
  ]

  const result = evaluateParseSuccess(entries, (raw, paragraphIds, stage) => (
    raw.includes('"paragraphId"') && raw.includes(paragraphIds[0]) && stage === 'links'
      ? [{ paragraphId: paragraphIds[0] }]
      : []
  ))
  assert.equal(result.value, 1)
  assert.equal(result.total, 1)
  assert.match(result.notes, /正确未产出结果/)

  const broken = evaluateParseSuccess(entries, () => [])
  assert.equal(broken.value, 0)
  assert.equal(broken.failures[0].id, 'f-1')
})

test('语料自检：句子与段落正文对不上时报错', () => {
  const issues = checkDatasetConsistency([{
    ...baseSample,
    claims: [{ ...baseSample.claims[0], sentenceText: '对不上的句子。' }],
  }])
  assert.equal(issues.length, 1)
  assert.match(issues[0].reason, /不一致/)
})
