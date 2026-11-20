import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadProductionFunctions } from '../eval/v2/production-adapter.mjs'
import { env } from '../src/config/env.ts'
import { withModelRedaction } from '../src/integrations/model-redaction.ts'
import { splitEvidenceTextIntoPages } from '../src/intelligence/evidence-retrieval.ts'

const sentence = (sentenceText, sentenceIndex = 0) => ({ sentenceText, sentenceIndex, priority: 'normal' })
const material = (id, text, locator = '第 1 页') => ({ id, number: `E${id.padStart(2, '0')}`,
  name: '案件材料', fragments: [{ text, locator }] })

test('证据召回覆盖不同句子并返回材料末尾的真实命中片段', async () => {
  const { rankLinkageEvidence } = await import('../src/intelligence/linkage-evidence-ranking.ts')
  const documents = Array.from({ length: 15 }, (_, i) =>
    material(String(i + 1), `消防工程验收合格后交付楼栋，查验记录编号${i + 1}。`))
  const target = material('16', '银行回单记载星穹公司支付仓储租金人民币12万元。', '第 9 页')
  target.fragments.unshift(...Array.from({ length: 8 }, (_, i) =>
    ({ locator: `第 ${i + 1} 页`, text: '库存台账记录货物重量、包装形式和入库渠道。' })))
  const ranks = await rankLinkageEvidence([{ id: 'p', sentences: [
    sentence('消防工程验收合格后交付楼栋。'), sentence('星穹公司支付仓储租金120,000元。', 1),
  ] }], [...documents, target])
  const rows = ranks.get('p')
  assert.equal(rows.length, 12)
  assert.equal(new Set(rows.map(item => item.evidenceId)).size, 12)
  assert.equal(rows[1].evidenceId, '16')
  assert.deepEqual(rows[1].sentenceIndexes, [1])
  assert.deepEqual(rows[1].fragments[0], { locator: '第 9 页', text: target.fragments.at(-1).text })
})

test('字段重排区分金额日期的精确匹配，同时保留冲突材料', async () => {
  const { rankLinkageEvidence } = await import('../src/intelligence/linkage-evidence-ranking.ts')
  const exact = material('2', '银行转账：星穹公司在2026年9月1日支付仓储租金10万元。')
  const conflict = material('1', '银行转账：星穹公司在2026年9月2日支付仓储租金30万元。')
  const ranks = await rankLinkageEvidence([{ id: 'p', sentences: [
    sentence('仓储租金转账见Ｅ０２，星穹公司于2026-09-01支付人民币100,000元。'),
  ] }], [conflict, exact])
  assert.deepEqual(ranks.get('p').map(item => item.evidenceId), ['2', '1'])
})

test('精确金额支持十进制单位换算，并把字段命中的长片段原文交给模型', async () => {
  const { rankLinkageEvidence } = await import('../src/intelligence/linkage-evidence-ranking.ts')
  const incorrect = material('1', '复核付款金额为1.002万元。')
  const correct = material('2', `复核付款金额并非300,000元。${'内部资料归档，用于后续审阅。'.repeat(28)}确认实收1.001万元。`)
  const ranks = await rankLinkageEvidence([{ id: 'p', sentences: [sentence('复核付款金额为10010元。')] }], [incorrect, correct])
  const match = ranks.get('p').find(candidate => candidate.evidenceId === '2')
  assert.ok(match.fragments.some(fragment => fragment.text.includes('1.001万元')))
  assert.equal(ranks.get('p')[0].evidenceId, '2')
})

test('限制向量预算时优先覆盖不同段落，全部材料仍参加 BM25 召回', async () => {
  const { rankLinkageEvidence } = await import('../src/intelligence/linkage-evidence-ranking.ts')
  const paragraphs = [
    { id: 'a', sentences: [sentence('核对仓库租金。'), sentence('核对工程款。', 1), sentence('核对办公费用。', 2)] },
    { id: 'b', sentences: [sentence('核对运输单号。')] },
  ]
  const docs = ['办公费用清单。', '工程款到账。', '仓库租金回执。', '运输单号已登记。'].map((text, i) => material(String(i + 1), text))
  let queries, passages
  const result = await rankLinkageEvidence(paragraphs, docs, {
    maxQueries: 2, maxPassages: 2,
    embedQueries: async texts => {
      queries = texts
      return texts.map(() => [1, 0])
    },
    embedPassages: async texts => {
      passages = texts
      return texts.map(() => [1, 0])
    },
  })
  assert.deepEqual(queries, ['核对仓库租金。', '核对运输单号。'])
  assert.equal(passages.length, 2)
  assert.ok(passages[0].includes('仓库租金'))
  assert.ok(passages[1].includes('运输单号'))
  assert.ok(result.get('a').some(candidate => candidate.evidenceId === '1' && candidate.sentenceIndexes.includes(2)))
})

test('先脱敏再送出分块，跨分块的邮箱仍被完整遮盖', async () => {
  const { rankLinkageEvidence } = await import('../src/intelligence/linkage-evidence-ranking.ts')
  const { maskTextForEvidenceEmbedding } = await import('../src/integrations/embedding-service.ts')
  let passages
  const results = await withModelRedaction(() => rankLinkageEvidence([{ id: 'p', sentences: [sentence('确认邮箱。')] }], [
    material('1', `${'前'.repeat(793)}邮箱abc@example.invalid。`),
  ], {
    prepareText: maskTextForEvidenceEmbedding,
    embedQueries: async () => [[1, 0]],
    embedPassages: async texts => { passages = texts; return texts.map(() => [1, 0]) },
  }))
  assert.equal(passages.length, 2)
  assert.ok(passages.every(text => !text.includes('abc') && !text.includes('example.invalid')))
  assert.ok(results.get('p').flatMap(candidate => candidate.fragments).every(fragment => !fragment.text.includes('abc') && !fragment.text.includes('example.invalid')))
})

test('向量召回能找回词面未命中的材料，调用失败时保留 BM25 结果', async () => {
  const { rankLinkageEvidence } = await import('../src/intelligence/linkage-evidence-ranking.ts')
  const paragraphs = [{ id: 'p', sentences: [sentence('货款已经付清。')] }]
  const documents = [material('1', '货款仍未付清。'), material('2', '收款方确认银行回单对应的应收款余额为零。')]
  const hybrid = await rankLinkageEvidence(paragraphs, documents, {
    embedQueries: async () => [[1, 0]], embedPassages: async () => [[0, 1], [1, 0]],
  })
  assert.ok(hybrid.get('p').some(candidate => candidate.evidenceId === '2'))
  const lexical = await rankLinkageEvidence(paragraphs, documents, {
    embedQueries: async () => { throw new Error('Embedding 不可用') }, embedPassages: async () => [],
  })
  assert.equal(lexical.get('p')[0].evidenceId, '1')
})

test('取消联动会终止正在进行的向量请求', async () => {
  const { rankLinkageEvidence } = await import('../src/intelligence/linkage-evidence-ranking.ts')
  const controller = new AbortController()
  let embeddingStopped = false
  const ranks = rankLinkageEvidence([{ id: 'p', sentences: [sentence('核对入账。')] }], [material('1', '已入账。')], {
    embedPassages: async (_texts, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
      embeddingStopped = true
      reject(signal.reason)
    }, { once: true })),
    embedQueries: async () => {
      controller.abort(new Error('用户停止'))
      return [[1, 0]]
    },
  }, controller.signal)
  await assert.rejects(ranks, /用户停止/)
  assert.equal(embeddingStopped, true)
})

test('生产联动在整体理解之后发起候选检索并把命中片段送入挂接阶段', async () => {
  const { rankLinkageEvidence } = await import('../src/intelligence/linkage-evidence-ranking.ts')
  const calls = []
  const text = '已完成分期付款。尚未完成设备交付。'
  const p = { id: 'p', text }
  const focus = { sentenceIndex: 0, priority: 'high', kind: 'fact', reason: '付款事实', evidenceNeeded: true }
  const evidence = { ...material('1', text), fileName: '材料.pdf', ocrText: '已收到分期款项。' }
  const workspace = { cases: [], evidenceInsights: [], evidenceFragments: [{ evidenceId: evidence.id,
    text: evidence.ocrText, locator: '第 9 页', summary: '' }] }
  const { analyzeCertificateAutoLinksWithLlm } = loadProductionFunctions([
    'analyzeCertificateAutoLinksWithLlm', 'normalizeAutoLinkSignalList', 'normalizeAutoLinkEvidenceIntents',
    'normalizeAutoLinkStatuteIntents', 'normalizeAutoLinkCaseIntents', 'uniqueStrings',
    'buildLinkageEvidenceCandidates', 'getMeaningfulEvidenceText', 'isPlaceholderEvidenceText', 'getLatestEvidenceInsight',
    'summarizeEvidenceForAutoLinkPrompt', 'inferEvidenceSemanticSignals', 'EVIDENCE_SEMANTIC_ALIAS_PATTERNS',
    'normalizeSemanticPhrase', 'isWeakSemanticAlias', 'summarizeForPrompt',
  ], {
    isLlmConfigured: () => true,
    isEmbeddingConfigured: () => true,
    env: { AI_GATEWAY_MODE: 'cloud' },
    getEmbeddingBatchSize: () => 16,
    getCurrentWorkspaceAccount: () => null,
    maskTextForEvidenceEmbedding: text => text,
    createEmbeddings: async texts => texts.map(() => [1, 0]),
    createEvidencePassageEmbeddings: async (_scope, texts) => texts.map(() => [1, 0]),
    buildParagraphAutoLinkPayload: () => [{ paragraphId: p.id, text, evidenceCandidates: [] }],
    rankLinkageEvidence: async (inputs, documents, options, signal) => {
      calls.push('ranking')
      assert.equal(inputs.length, 1)
      assert.equal(inputs[0].sentences.length, 1)
      assert.equal(inputs[0].sentences[0].sentenceIndex, 0)
      assert.equal(options.maxQueries, 16)
      assert.equal(options.maxPassages, 16)
      return rankLinkageEvidence(inputs, documents, options, signal)
    },
    requestLinkageParagraphBatch: async options => {
      calls.push(options.stage)
      const [payload] = JSON.parse(options.messages[1].content).paragraphs
      if (options.stage === 'overview') {
        assert.equal(payload.evidenceCandidates, undefined)
        return { paragraphs: [{ paragraphId: p.id, sentenceFocus: [focus] }] }
      }
      assert.equal(payload.evidenceCandidates.length, 1)
      assert.equal(payload.evidenceCandidates[0].evidenceNumber, 'E01')
      assert.deepEqual(payload.evidenceCandidates[0].fragmentSnippets, [{ locator: '第 9 页', summary: evidence.ocrText }])
      return { paragraphs: [{ paragraphId: p.id, evidenceLinks: [], statuteIntents: [], caseIntents: [] }] }
    },
  })
  await analyzeCertificateAutoLinksWithLlm(workspace, { caseId: 'case', paragraphs: [p] }, [evidence], null)
  assert.deepEqual(calls, ['overview', 'ranking', 'links'])
})

test('最终挂接优先定位到实际包含摘录的原件片段', () => {
  const { findBestEvidenceFragmentForParagraph, getEvidenceFragmentsForEvidence } = loadProductionFunctions([
    'findBestEvidenceFragmentForParagraph', 'getEvidenceFragmentsForEvidence', 'scoreKeywords', 'tokenizeKeywordSource',
  ], { splitEvidenceTextIntoPages })
  const evidence = { id: 'e', name: '回单' }
  const evidenceFragments = [
    { evidenceId: 'e', locator: '第 1 页', text: '付款约定，付款日，支付，租金，收款方。', summary: '', keywords: [] },
    { evidenceId: 'e', locator: '第 9 页', text: '银行确认已入账12万元。', summary: '', keywords: [] },
  ]
  const fragment = findBestEvidenceFragmentForParagraph({ evidenceFragments }, evidence, '付款约定，付款日，支付，租金，收款方。', '银行确认已入账 12万元')
  assert.equal(fragment.locator, '第 9 页')
  const legacyText = '-- 第 1/2 页 --\n归档事项。\n-- 第 2/2 页 --\n银行确认已入账12万元。'
  const legacy = [{ evidenceId: 'e', locator: '第 1 页', text: legacyText, summary: '', keywords: [] }]
  assert.equal(findBestEvidenceFragmentForParagraph({ evidenceFragments: legacy }, evidence, '付款事实。', '银行确认已入账12万元').locator, '第 2 页')
})

test('材料向量按工作区和模型复用，只重算变更片段且保持出站脱敏', async () => {
  const { createEvidencePassageEmbeddings } = await import('../src/integrations/embedding-service.ts')
  const requests = []
  const savedEnv = { AI_GATEWAY_MODE: env.AI_GATEWAY_MODE, EMBEDDING_BASE_URL: env.EMBEDDING_BASE_URL, EMBEDDING_MODEL: env.EMBEDDING_MODEL }
  const originalFetch = globalThis.fetch
  Object.assign(env, { AI_GATEWAY_MODE: 'direct', EMBEDDING_BASE_URL: 'https://embedding.example.invalid', EMBEDDING_MODEL: 'test-ranking-v1' })
  globalThis.fetch = async (_url, { body }) => {
    const { input } = JSON.parse(body)
    requests.push(input)
    return Response.json({ data: input.map((text, index) => ({ index, embedding: [text.length, 1] })) })
  }
  try {
    const a = '仓储说明', b = '付款凭证', c = '付款凭证修订版'
    assert.equal((await createEvidencePassageEmbeddings('account-a:case', [a, b])).length, 2)
    await createEvidencePassageEmbeddings('account-a:case', [a, c])
    await createEvidencePassageEmbeddings('account-b:case', [a])
    env.EMBEDDING_MODEL = 'test-ranking-v2'
    await createEvidencePassageEmbeddings('account-a:case', [a])
    assert.deepEqual(requests, [[a, b], [c], [a], [a]])
    const sensitive = '收件邮箱 secret@example.invalid，用于转交复印件。'
    for (let i = 0; i < 2; i++) await withModelRedaction(() => createEvidencePassageEmbeddings('account-a:case', [sensitive]))
    assert.equal(requests.length, 5)
    assert.ok(requests[4][0].includes('＊＊') && !requests[4][0].includes('secret@example.invalid'))
  } finally {
    Object.assign(env, savedEnv)
    globalThis.fetch = originalFetch
  }
})
