import assert from 'node:assert/strict'
import { test } from 'node:test'
import { planLinkageParagraphBatches } from '../src/intelligence/linkage-batching.ts'
import * as policy from '../src/intelligence/linkage-policy.ts'

const fact = '甲方于2026年10月1日支付代理费5000元。'
const focusFor = text => policy.normalizeSentenceLinkageFocus(text, policy.getLinkageSentences(text).map(sentence => ({
  ...sentence, kind: 'fact', priority: 'high', reason: '核验付款事实', evidenceNeeded: true,
})))

test('动态组批允许超过五段，保持段落全文、顺序和共享上下文', () => {
  const paragraphs = Array.from({ length: 7 }, (_, index) => ({ paragraphId: `p${index}`, text: fact }))
  const batches = planLinkageParagraphBatches({
    stage: 'overview', paragraphIds: paragraphs.map(p => p.paragraphId), maxTokens: 10000,
    messages: [{ role: 'user', content: JSON.stringify({ caseContextMemory: '背景', paragraphs }) }],
  })
  assert.equal(batches.length, 1)
  assert.deepEqual(JSON.parse(batches[0].messages[0].content), { caseContextMemory: '背景', paragraphs })
  assert.deepEqual(planLinkageParagraphBatches({ stage: 'overview', paragraphIds: [], messages: [], maxTokens: 10000 }), [])
})

test('输入按完整消息和转义后大小贪心组批，尽量装入完整段落', () => {
  const paragraphs = [0, 1, 2].map(index => ({ paragraphId: `p${index}`, text: '"'.repeat(3000) }))
  const batches = planLinkageParagraphBatches({
    stage: 'overview', paragraphIds: ['p0', 'p1', 'p2'], maxTokens: 10000,
    messages: [{ role: 'system', content: '背'.repeat(1000) }, { role: 'user', content: JSON.stringify({ paragraphs }) }],
  })
  assert.deepEqual(batches.map(batch => batch.paragraphIds), [['p0', 'p1'], ['p2']])
  assert.ok(batches.every(batch => batch.messages.reduce((total, message) => total + message.content.length, 0) <= 16000))
  assert.deepEqual(batches.flatMap(batch => JSON.parse(batch.messages[1].content).paragraphs), paragraphs)
})

test('完整请求恰好16000字符时合批，超过一个字符时按完整段落分批', () => {
  const paragraphs = [{ paragraphId: 'p0', text: '' }, { paragraphId: 'p1', text: '' }]
  const overhead = JSON.stringify({ paragraphs }).length
  paragraphs[0].text = '文'.repeat(16000 - overhead)
  for (const extra of ['', '字']) {
    paragraphs[1].text = extra
    const content = JSON.stringify({ paragraphs })
    assert.equal(content.length, 16000 + extra.length)
    const batches = planLinkageParagraphBatches({
      stage: 'overview', paragraphIds: ['p0', 'p1'], maxTokens: 10000,
      messages: [{ role: 'user', content }],
    })
    assert.deepEqual(batches.map(batch => batch.paragraphIds), extra ? [['p0'], ['p1']] : [['p0', 'p1']])
    assert.deepEqual(batches.flatMap(batch => JSON.parse(batch.messages[0].content).paragraphs), paragraphs)
  }
})

test('两阶段按句子和候选关联估算输出，复杂证据核对使用更小批次', () => {
  const paragraphs = Array.from({ length: 6 }, (_, index) => ({
    paragraphId: `p${index}`, text: fact.repeat(10),
    sentenceGroups: policy.getLinkageSentences(fact.repeat(10)),
    evidenceCandidates: Array.from({ length: 12 }, (_, id) => ({ evidenceNumber: `E${id}` })),
    overview: { sentenceFocus: focusFor(fact.repeat(10)) },
  }))
  const options = {
    paragraphIds: paragraphs.map(p => p.paragraphId), maxTokens: 10000,
    messages: [{ role: 'user', content: JSON.stringify({ paragraphs }) }],
  }
  const overview = planLinkageParagraphBatches({ ...options, stage: 'overview' })
  const links = planLinkageParagraphBatches({ ...options, stage: 'links' })
  assert.deepEqual(overview.map(batch => batch.paragraphIds.length), [4, 2])
  assert.deepEqual(links.map(batch => batch.paragraphIds.length), [2, 2, 2])
  assert.ok([...overview, ...links].every(batch => batch.maxTokens >= 6000 && batch.maxTokens <= 10000))
})

test('超长单段独立处理并保留原文，超过软预算时仍遵守硬上限', () => {
  const paragraphs = [{ paragraphId: 'long', text: '文'.repeat(125000) }, { paragraphId: 'short', text: fact }]
  const batches = planLinkageParagraphBatches({
    stage: 'overview', paragraphIds: ['long', 'short'], maxTokens: 10000,
    messages: [{ role: 'user', content: JSON.stringify({ paragraphs }) }],
  })
  assert.deepEqual(batches.map(batch => batch.paragraphIds), [['long'], ['short']])
  assert.deepEqual(batches.flatMap(batch => JSON.parse(batch.messages[0].content).paragraphs), paragraphs)
})

test('同一句有多份候选证据时计入全部潜在关联，避免低估输出', () => {
  const sizes = []
  for (const count of [1, 12]) {
    const paragraphs = Array.from({ length: 7 }, (_, index) => ({
      paragraphId: `p${index}`, text: fact, overview: { sentenceFocus: focusFor(fact) },
      evidenceCandidates: Array.from({ length: count }, (_, id) => ({ evidenceNumber: `E${id}` })),
    }))
    const batches = planLinkageParagraphBatches({
      stage: 'links', paragraphIds: paragraphs.map(p => p.paragraphId), maxTokens: 10000,
      messages: [{ role: 'user', content: JSON.stringify({ paragraphs }) }],
    })
    sizes.push(batches.map(batch => batch.paragraphIds.length))
  }
  assert.deepEqual(sizes, [[7], [2, 2, 2, 1]])
})
