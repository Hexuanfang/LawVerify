import assert from 'node:assert/strict'
import test from 'node:test'
import { runRetrievalSkill } from '../src/assistant/retrieval.ts'
import { createLegalCaseAdapter } from '../src/integrations/legal-case.ts'
import { createLegalStatuteAdapter } from '../src/integrations/legal-statute.ts'

const emptyWorkspace = { evidences: [], evidenceFragments: [], knowledgeStatutes: [], knowledgeCases: [] }
const caseId = 'case-a'
const articleText = '借款人应当按照约定的期限返还借款。'
const statute = {
  id: 'civil-675', law_name: '中华人民共和国民法典', article_number: '第六百七十五条',
  validity: 'VALID', effective_date: '2021-01-01', version: '2020', text: articleText,
  url: 'https://flk.npc.gov.cn/detail2.html?ZmY4MDgwODE=',
}
const number = '（2023）京0105民初123号'
const passage = '借款期限届满后，借款人应按约偿还本金。'
const judgment = {
  id: 'detail-case-1', case_number: number, name: '某借贷纠纷民事判决书', court: '北京市朝阳区人民法院',
  judgment_date: '2023-07-09', effect: 'effective', level: 'ordinary', cause: '民间借贷',
  legal_relationship: '借贷关系', party_roles: ['借款人'], key_facts: ['借条约定了期限'], issues: ['借款期限届满后是否应偿还本金'],
  rules: ['按约偿还本金'], procedure: '一审', url: 'https://rmfyalk.court.gov.cn/case/detail-1',
  body: `北京市朝阳区人民法院\n民事判决书\n${number}\n本院认为：${passage}\n判决如下：被告应偿还借款本金。`,
}

function checkContext(type, quote, index) {
  return {
    id: `context-${index}`, type, quote, verdict: 'pass', reason: '', conf: null, checks: {},
    sources: type === 'E-FACT' ? [{ tier: 'l1', id: 'receipt', name: '借条' }] : [],
    location: { paragraphId: `paragraph-${index}`, paragraphIndex: index, start: 0, end: quote.length },
  }
}

const declarations = [
  checkContext('E-FACT', '本案系民间借贷，借款人书写的借条约定了期限。', 0),
  checkContext('E-FOCUS', '借款期限届满后是否应偿还本金？', 1),
]

test('类案语义检索并行核验不同案号，保持原检索顺序及详情状态', async () => {
  const rows = [judgment, ...[124, 125].map(suffix => {
    const nextNumber = number.replace('123号', `${suffix}号`)
    return { ...judgment, id: `detail-case-${suffix}`, case_number: nextNumber,
      body: judgment.body.replace(number, nextNumber), url: `https://rmfyalk.court.gov.cn/case/detail-${suffix}` }
  })]
  let active = 0
  let peak = 0
  const caseAdapter = createLegalCaseAdapter('local-fixture', async request => {
    if (request.action === 'semantic') return { items: rows }
    if (request.action === 'keyword') {
      peak = Math.max(peak, ++active)
      await new Promise(resolve => setImmediate(resolve))
      active--
      return { items: rows.filter(row => row.case_number === request.case_number) }
    }
    return request.id === rows[1].id ? { outcome: 'timeout' } : { items: rows.filter(row => row.id === request.id) }
  })
  const result = await runRetrievalSkill('case-mcp', { caseId, query: '民间借贷偿还本金', workspace: emptyWorkspace, declarations, caseAdapter })
  assert.equal(peak, rows.length)
  assert.deepEqual(result.cards.map(card => card.caseVerification.caseNumber), rows.map(row => row.case_number))
  assert.deepEqual(result.cards.map(card => card.status), ['verified', 'pending', 'verified'])
})

test('法条语义检索并行核对不同条文，保留仍待核的结果', async () => {
  const rows = [statute, { ...statute, id: 'civil-676', article_number: '第六百七十六条' }]
  let active = 0
  let peak = 0
  const statuteAdapter = createLegalStatuteAdapter(async request => {
    if (request.action === 'semantic') return { items: rows }
    if (request.action === 'search_article') {
      peak = Math.max(peak, ++active)
      await new Promise(resolve => setImmediate(resolve))
      active--
      return { items: rows.filter(row => row.article_number === request.article_number) }
    }
    return request.id === rows[1].id ? { outcome: 'timeout' } : { items: rows.filter(row => row.id === request.id) }
  })
  const result = await runRetrievalSkill('statute-mcp', {
    caseId, query: '民间借贷偿还本金', factDate: '2023-02-01', workspace: emptyWorkspace, statuteAdapter,
  })
  assert.equal(peak, rows.length)
  assert.deepEqual(result.cards.map(card => card.label), rows.map(row => `《${row.law_name}》${row.article_number}`))
  assert.deepEqual(result.cards.map(card => card.status), ['verified', 'pending'])
})

test('卷内检索提供当前案件材料的原始摘录、定位和材料引用', async () => {
  const input = {
    caseId, query: '退还12000元', workspace: {
      ...emptyWorkspace,
      evidences: [{ id: 'receipt', caseId, name: '银行回单', ocrText: '' }, { id: 'other-receipt', caseId: 'case-b', name: '其他案件回单' }],
      evidenceFragments: [
        { evidenceId: 'other-receipt', caseId: 'case-b', locator: '第 1 页', text: '退还12000元。' },
        { evidenceId: 'receipt', caseId: 'case-b', locator: '第 3 页', text: '退还12000元。' },
        { evidenceId: 'receipt', caseId, locator: '第 2 页', text: '经办人：张某。\n已退还12000元。' },
      ],
    },
  }
  const result = await runRetrievalSkill('inbox-search', input)
  assert.equal(result.status, 'verified')
  assert.equal(result.cards.length, 1)
  assert.deepEqual(result.cards[0].output, {
    type: 'citation-card', material_name: '银行回单', loc: '第 2 页', excerpt: '已退还12000元。',
  })
  assert.equal(result.cards[0].evidenceLink?.evidenceId, 'receipt')
  assert.equal(result.cards[0].source?.quote, '已退还12000元。')
})

test('卷内材料只有摘要和相似金额时不生成引用', async () => {
  const result = await runRetrievalSkill('inbox-search', {
    caseId, query: '退还12000', workspace: {
      ...emptyWorkspace, evidences: [{ id: 'receipt', caseId, name: '银行回单', summaryText: '已退还12000元。', ocrText: '仅退还120000元。' }],
    },
  })
  assert.equal(result.status, 'empty')
  assert.deepEqual(result.cards, [])
})

test('法条由详情核实原文和事实日版本，按真实索引 ID 取详情', async () => {
  const calls = []
  const statuteAdapter = createLegalStatuteAdapter(async request => {
    calls.push(request)
    return request.action === 'article_detail' ? { items: [statute] } : { items: [{ ...statute, text: '不应进入引用的摘要' }] }
  })
  const result = await runRetrievalSkill('statute-mcp', {
    caseId, query: '《民法典》第675条', factDate: '2023-02-01', workspace: emptyWorkspace, statuteAdapter,
  })
  assert.deepEqual(calls, [
    { action: 'search_article', law_name: '民法典', article_number: '第675条', refer_date: '2023-02-01' },
    { action: 'article_detail', id: 'civil-675', refer_date: '2023-02-01' },
  ])
  assert.equal(result.status, 'verified')
  assert.deepEqual(result.cards[0].output, {
    type: 'citation-card', law_name: '中华人民共和国民法典', article_number: '第六百七十五条',
    validity: 'VALID', text: articleText, url: statute.url,
  })
  assert.equal(result.cards[0].source?.version, '2020')
  assert.match(result.cards[0].citationText, /借款人应当按照约定的期限返还借款。/u)
  assert.equal(result.cards[0].reference, undefined)
})

test('法条详情只读摘要、错误、无回查链接或时点不适用时不生成引用', async () => {
  const failures = [
    { outcome: 'forbidden' }, { items: [{ ...statute, text: undefined, summary: articleText }] },
    { items: [{ ...statute, url: undefined }] }, { items: [{ ...statute, effective_date: '2024-01-01' }] },
    { items: [{ ...statute, article_number: '第六百七十六条' }] },
  ]
  for (const detail of failures) {
    const statuteAdapter = createLegalStatuteAdapter(async request => request.action === 'article_detail' ? detail : { items: [statute] })
    const result = await runRetrievalSkill('statute-mcp', {
      caseId, query: '《民法典》第675条', factDate: '2023-02-01', workspace: emptyWorkspace, statuteAdapter,
    })
    assert.equal(result.status, 'pending')
    assert.equal(result.cards[0].status, 'pending')
    assert.equal(result.cards[0].output, undefined)
    assert.equal(result.cards[0].citationText, undefined)
    assert.equal(result.cards[0].source, undefined)
  }
})

test('法条语义命中在精确索引为空时仍按原始 ID 拉详情', async () => {
  const statuteAdapter = createLegalStatuteAdapter(async request => {
    if (request.action === 'semantic') return { items: [statute] }
    return { items: request.action === 'article_detail' && request.id === statute.id ? [statute] : [] }
  })
  const result = await runRetrievalSkill('statute-mcp', {
    caseId, query: '借款返还期限', factDate: '2023-02-01', workspace: emptyWorkspace, statuteAdapter,
  })
  assert.equal(result.status, 'verified')
  assert.equal(result.cards[0].source?.quote, articleText)
})

test('法条按事实日选择本地历史版本并仅关联原版本的条款', async () => {
  const former = '借款人应在约定日期偿还借款。'
  const localStatute = {
    id: 'historical-document', title: statute.law_name, docType: '法律', issuer: '全国人民代表大会', effectiveStatus: 'repealed',
    effectiveDate: '2017-01-01', publishDate: '2016-08-01', revisionDate: '2021-01-01', version: '2017', keywords: [],
    sourceProvider: 'npc_flk', sourceDocumentId: 'archive-1', sourceUrl: 'https://flk.npc.gov.cn/detail2.html?archive-1',
    sourceVerifiedAt: '2025-01-02', articles: [{ id: 'former-article', documentId: 'historical-document', articleNumber: statute.article_number,
      content: former, plainText: former, aliases: [], topicTags: [] }],
  }
  const currentStatute = {
    ...localStatute, id: 'current-document', sourceDocumentId: 'archive-2', sourceUrl: statute.url, effectiveStatus: 'effective',
    effectiveDate: '2021-01-01', publishDate: '2020-05-28', revisionDate: undefined, version: '2020',
    articles: [{ ...localStatute.articles[0], id: 'current-article', documentId: 'current-document', content: articleText, plainText: articleText }],
  }
  const result = await runRetrievalSkill('statute-mcp', {
    caseId, query: '《民法典》第675条', factDate: '2019-02-01', workspace: { ...emptyWorkspace, knowledgeStatutes: [localStatute, currentStatute] },
  })
  assert.equal(result.status, 'verified')
  assert.equal(result.cards[0].output?.validity, 'REPEALED')
  assert.equal(result.cards[0].source?.quote, former)
  assert.equal(result.cards[0].reference?.targetId, 'former-article')
})

test('被废止条文的替代依据需经 T4 独立核对原文和适用事实', async () => {
  const legalText = '当事人一方不履行合同义务，应当承担违约责任。'
  const old = { ...statute, id: 'old', law_name: '合同法', article_number: '第一百零七条', text: legalText,
    validity: 'REPEALED', effective_date: '1999-10-01', repeal_date: '2021-01-01' }
  const updated = { ...statute, id: 'new', law_name: '民法典', article_number: '第五百七十七条', text: legalText }
  const relevantFacts = [checkContext('E-FACT', '2023年3月15日签订借款合同，被告到期未履行还款义务。', 0),
    checkContext('E-CLAIM', '请求被告承担违约责任。', 1)]
  for (const replacementText of [legalText, undefined]) {
    const statuteAdapter = createLegalStatuteAdapter(async request => ({ items: [request.id === 'old' || request.law_name === '合同法'
      ? old : { ...updated, text: replacementText }] }))
    const result = await runRetrievalSkill('statute-mcp', {
      caseId, query: '《合同法》第107条', workspace: emptyWorkspace, statuteAdapter, declarations: relevantFacts,
    })
    assert.equal(result.status, replacementText ? 'verified' : 'pending')
    assert.equal(result.cards[0].output?.article_number, replacementText ? '第五百七十七条' : undefined)
    assert.equal(result.cards[0].source?.id, replacementText ? 'new' : undefined)
  }
})

test('案例由全文确认案号和原文并复用 T5 事实比对', async () => {
  const calls = []
  const caseAdapter = createLegalCaseAdapter('fixture', async request => {
    calls.push(request.action)
    return { items: request.action === 'detail' ? [judgment] : [{ ...judgment, body: undefined }] }
  })
  const workspace = { ...emptyWorkspace, knowledgeCases: [{ id: judgment.id, title: judgment.name, caseNumber: number, courtName: judgment.court,
    sourceUrl: judgment.url, excerpts: [{ id: 'matching-excerpt', locator: '本院认为', content: passage }] }] }
  const result = await runRetrievalSkill('case-mcp', { caseId, query: '民间借贷', workspace, caseAdapter, declarations })
  assert.equal(calls[0], 'semantic')
  assert.equal(calls.at(-1), 'detail')
  assert.equal(result.status, 'verified')
  assert.equal(result.cards[0].source?.locator, '本院认为')
  assert.equal(result.cards[0].source?.quote, passage)
  assert.equal(result.cards[0].reference?.targetId, 'matching-excerpt')
  assert.deepEqual(result.cards[0].output, {
    type: 'citation-card', case_number: number, court: judgment.court, judgment_date: '2023-07-09',
    gist: passage, hit_level: '严格命中', url: judgment.url,
  })
})

test('案例零命中、详情失败、摘要与无效裁判均缺少可采纳引用', async () => {
  const responses = [
    { search: { items: [] }, status: 'empty' },
    { detail: { outcome: 'forbidden' }, status: 'pending' },
    { detail: { items: [{ ...judgment, body: undefined, gist: passage }] }, status: 'pending' },
    { detail: { items: [{ ...judgment, effect: 'vacated' }] }, status: 'pending' },
    { detail: { items: [{ ...judgment, relies_on_repealed_law: true }] }, status: 'pending' },
  ]
  for (const { search, detail, status } of responses) {
    const caseAdapter = createLegalCaseAdapter('fixture', async request => request.action === 'detail' ? detail : (search ?? { items: [judgment] }))
    const result = await runRetrievalSkill('case-mcp', { caseId, query: '民间借贷', workspace: emptyWorkspace, caseAdapter, declarations })
    assert.equal(result.status, status)
    assert.ok(result.cards.every(card => !card.citationText && !card.source && !card.output && !card.reference))
    assert.ok(result.cards.every(card => !card.caseVerification?.allowCitation))
  }
})
