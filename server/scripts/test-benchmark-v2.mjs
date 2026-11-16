import assert from 'node:assert/strict'
import { test } from 'node:test'

const module = await import('../eval/v2/metrics.mjs').catch(() => ({}))
const sample = {
  id: 'case', materials: [{ id: 'm1', pages: ['甲公司已支付货款50000元。', '乙公司尚未支付尾款30000元。'] }],
  claims: [{ id: 'c1', text: '甲公司已支付货款50000元。', expected: [{ materialId: 'm1', relation: 'support', page: 1 }] },
    { id: 'c2', text: '无证据支持的主张。', expected: [] }],
}
const good = { claimId: 'c1', materialId: 'm1', relation: 'support', locator: '第1页', quote: '甲公司已支付货款50000元' }

test('v2 评分器可用且空输出不能获得满分', () => {
  assert.equal(typeof module.scoreLinks, 'function')
  const result = module.scoreLinks(sample, [])
  assert.equal(result.recall, 0)
  assert.equal(result.precision, null)
  assert.equal(result.fn, 1)
})

test('v2 错关系、错页、未知ID、伪造引文均不得计正确', () => {
  assert.equal(typeof module.scoreLinks, 'function')
  assert.equal(module.scoreLinks(sample, [good]).f1, 1)
  for (const patch of [{ relation: 'contradict' }, { locator: '第2页' }, { locator: '第1-99页' },
    { claimId: 'unknown' }, { materialId: 'unknown' }, { quote: '甲公司已支付货款90000元' }, { locator: '' }]) {
    const result = module.scoreLinks(sample, [{ ...good, ...patch }])
    assert.equal(result.tp, 0, JSON.stringify(patch))
    assert.equal(result.fp, 1)
    assert.equal(result.fn, 1)
  }
})

test('v2 重复挂接及无证据句错挂必须扣分', () => {
  assert.equal(typeof module.scoreLinks, 'function')
  const duplicate = module.scoreLinks(sample, [good, good])
  assert.equal(duplicate.tp, 1)
  assert.equal(duplicate.fp, 1)
  const wrong = module.scoreLinks(sample, [good, { ...good, claimId: 'c2' }])
  assert.equal(wrong.precision, 0.5)
  assert.equal(wrong.negativeAccuracy, 0)
})

test('v2 多证据缺一份计漏挂，覆盖不了的指标为 null', () => {
  assert.equal(typeof module.scoreLinks, 'function')
  const both = structuredClone(sample)
  both.materials.push({ id: 'm2', pages: ['甲公司已支付货款50000元。'] })
  both.claims[0].expected.push({ materialId: 'm2', relation: 'support', page: 1 })
  assert.equal(module.scoreLinks(both, [good]).recall, 0.5)
  assert.equal(module.scoreLinks({ ...sample, claims: [] }, []).f1, null)
})

test('v2 解析字段评分必须保留金额、日期、主体、否定词及页码', () => {
  assert.equal(typeof module.scoreExtraction, 'function')
  const gold = { id: 'doc', pages: [{ text: '甲公司于2026年11月1日尚未支付50000元。', fields: ['甲公司', '2026年11月1日', '尚未支付', '50000元'] }] }
  const good = module.scoreExtraction(gold, [{ page: 1, text: gold.pages[0].text }])
  assert.equal(good.fieldAccuracy, 1)
  for (const text of ['甲公司于2026年11月1日已支付50000元。', '甲公司于2026年11月1日尚未支付90000元。']) {
    assert.ok(module.scoreExtraction(gold, [{ page: 1, text }]).fieldAccuracy < 1)
  }
  assert.equal(module.scoreExtraction(gold, [{ page: 2, text: gold.pages[0].text }]).fieldAccuracy, 0)
})

test('v2 实际页数元数据错误不能因文本分页正确而通过', () => {
  const gold = { id: 'doc', pages: [{ text: '合同金额50000元。', fields: ['50000元'] }] }
  assert.equal(module.scoreExtraction(gold, [{ page: 1, text: gold.pages[0].text }], { totalPages: 99 }).pageCountCorrect, false)
  assert.equal(module.scoreExtraction(gold, [{ page: 1, text: gold.pages[0].text }], { totalPages: undefined }).pageCountCorrect, false)
})

test('v2 live 原始输出必须保留重复与未知提案供评分，不能被生产过滤抹去', async () => {
  const live = await import('../eval/v2/live.mjs')
  assert.equal(typeof live.decodeRawPredictions, 'function')
  const raw = JSON.stringify({ paragraphs: [
    { paragraphId: 'c1', evidenceLinks: [{ sentenceIndex: 0, evidenceNumber: 'E01', relation: 'support', quoteHint: good.quote, locator: '第1页' }] },
    { paragraphId: 'c1', evidenceLinks: [{ sentenceIndex: 0, evidenceNumber: 'E99', relation: 'support', quoteHint: good.quote, locator: '第1页' }] },
    { paragraphId: 'unknown', evidenceLinks: [{ sentenceIndex: 0, evidenceNumber: 'E01', relation: 'support', quoteHint: good.quote, locator: '第1页' }] },
  ] })
  const numbered = { ...sample, materials: [{ ...sample.materials[0], number: 'E01' }] }
  const predictions = live.decodeRawPredictions(raw, numbered)
  const score = module.scoreLinks(numbered, predictions)
  assert.equal(predictions.length, 3)
  assert.equal(score.tp, 1)
  assert.equal(score.fp, 2)
  assert.ok(live.checkResponseProtocol(raw, ['c1']).length >= 2)
})

test('v2 模型输入不含标准答案和标注理由', async () => {
  const { buildLinkageInput } = await import('../eval/v2/live.mjs')
  const input = buildLinkageInput(sample)
  assert.deepEqual(input.claims, sample.claims.map(c => ({ paragraphId: c.id, text: c.text })))
  assert.equal(JSON.stringify(input).includes('expected'), false)
})

test('v2 空附件集、缺少混合场景、重复 ID 和无字段标注必须阻断验收', async () => {
  assert.equal(typeof module.validateManifest, 'function')
  const { readFileSync } = await import('node:fs')
  const manifest = JSON.parse(readFileSync(new URL('../eval/v2/media-manifest.json', import.meta.url)))
  assert.deepEqual(module.validateManifest(manifest), [])
  assert.ok(module.validateManifest({ documents: [] }).length)
  assert.ok(module.validateManifest({ documents: manifest.documents.filter(d => d.kind !== 'mixed_pdf') }).length)
  const duplicate = structuredClone(manifest)
  duplicate.documents[1].id = duplicate.documents[0].id
  assert.ok(module.validateManifest(duplicate).length)
  const noFields = structuredClone(manifest)
  noFields.documents[0].pages[0].fields = []
  assert.ok(module.validateManifest(noFields).length)
})
