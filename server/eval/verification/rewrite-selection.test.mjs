import assert from 'node:assert/strict'
import test from 'node:test'
import { locateRewriteSelection, validateRewritePreview } from '../../src/intelligence/verification/rewrite-selection.ts'

test('选区必须按段落和字符范围绑定，重复文本不靠猜测定位', () => {
  const paragraphs = [{ id: 'first', text: '同一事实。' }, { id: 'second', text: '此前：同一事实。' }]
  assert.equal(locateRewriteSelection(paragraphs, { paragraphId: 'second', start: 3, quote: '同一事实。' }), paragraphs[1])
  assert.throws(() => locateRewriteSelection(paragraphs, { paragraphId: 'second', start: 0, quote: '同一事实。' }), /选区/)
  assert.throws(() => locateRewriteSelection(paragraphs, null), /选区/)
})

test('候选仅一个非空段，保持数字、日期、案号和法条依据', () => {
  const facts = '2023年4月11日支付35,000元，适用《测试法》第三条，参照（2021）京01民终2号。'
  assert.equal(validateRewritePreview(facts, [{ text: '经核对，' + facts }]), '经核对，' + facts)
  for (const changed of [facts.replace('35,000', '30,000'), facts.replace('11日', '12日'), facts.replace('第三条', '第四条'), facts.replace('民终2号', '民初2号'), facts.replace('测试法', '其他法'), facts + '金额为100元。']) {
    assert.throws(() => validateRewritePreview(facts, [{ text: changed }]), /保护字段/)
  }
  assert.throws(() => validateRewritePreview(facts, [{ text: facts }, { text: '新增其他正文。' }]), /单段/)
})
