import assert from 'node:assert/strict'
import { test } from 'node:test'
import { searchWorkspace, MAX_EVIDENCE_SCAN_CHARS } from '../src/search/workspace-search.ts'

function createState() {
  return {
    cases: [{ id: 'case-1', name: '甲乙买卖合同纠纷', description: '', createdAt: '', status: 'draft' }],
    evidences: [
      {
        id: 'e-1',
        caseId: 'case-1',
        number: 'E01',
        name: '购销合同',
        type: 'pdf',
        fileName: '证据1 购销合同.pdf',
        relativePath: '证据1 购销合同.pdf',
        uploadedAt: '',
        ocrText: '合同总价款为人民币120万元，分两期支付。',
      },
      {
        id: 'e-2',
        caseId: 'case-2',
        number: 'E01',
        name: '他案验收单',
        type: 'pdf',
        fileName: '证据1 他案验收单.pdf',
        relativePath: '证据1 他案验收单.pdf',
        uploadedAt: '',
        ocrText: '他案材料，与当前案件无关。',
      },
    ],
    certificates: [
      {
        id: 'cert-1',
        caseId: 'case-1',
        title: '民事起诉状',
        role: 'plaintiff',
        focus: '',
        paragraphIds: [],
        createdAt: '',
        paragraphs: [
          { id: 'p-1', text: '被告至今未支付第二期货款60万元。', verified: false },
        ],
      },
    ],
    knowledgeStatutes: [
      {
        id: 's-1',
        title: '中华人民共和国民法典',
        docType: '法律',
        articles: [
          { id: 'a-1', articleNumber: '第五百七十七条', content: '当事人一方不履行合同义务的，应当承担违约责任。' },
        ],
      },
    ],
    knowledgeCases: [
      {
        id: 'k-1',
        title: '某某买卖合同纠纷案',
        caseNumber: '(2021)京01民终1号',
        courtName: '北京市第一中级人民法院',
        issueSummary: '买卖合同违约金过高',
        holdingSummary: '违约金数额过高的，法院可予适当减少。',
        keywords: [],
        focusTags: [],
        excerpts: [],
      },
    ],
  }
}

test('材料名命中', () => {
  const { results } = searchWorkspace(createState(), '购销合同')
  const evidence = results.find(result => result.scope === 'evidence')
  assert.ok(evidence)
  assert.equal(evidence.target.evidenceId, 'e-1')
  assert.match(evidence.title, /E01/)
})

test('中文无空格正文命中', () => {
  const { results } = searchWorkspace(createState(), '人民币120万元')
  assert.ok(results.some(result => result.scope === 'evidence' && result.target.evidenceId === 'e-1'))
})

test('文书段落命中', () => {
  const { results } = searchWorkspace(createState(), '第二期货款')
  const paragraph = results.find(result => result.scope === 'paragraph')
  assert.ok(paragraph)
  assert.equal(paragraph.target.paragraphId, 'p-1')
  assert.equal(paragraph.target.certificateId, 'cert-1')
})

test('法条命中', () => {
  const { results } = searchWorkspace(createState(), '违约责任')
  const statute = results.find(result => result.scope === 'statute')
  assert.ok(statute)
  assert.equal(statute.target.statuteId, 's-1')
})

test('本地案例命中', () => {
  const { results } = searchWorkspace(createState(), '违约金数额过高')
  const entry = results.find(result => result.scope === 'case')
  assert.ok(entry)
  assert.equal(entry.target.knowledgeCaseId, 'k-1')
})

test('跨案件隔离：限定 caseId 后不返回其他案件材料', () => {
  const { results } = searchWorkspace(createState(), '证据1', { caseId: 'case-1' })
  assert.equal(results.some(result => result.target.evidenceId === 'e-2'), false)

  const all = searchWorkspace(createState(), '他案验收单')
  assert.ok(all.results.some(result => result.target.evidenceId === 'e-2'))
})

test('范围过滤：只查材料时不返回段落与法条', () => {
  const { results } = searchWorkspace(createState(), '购销合同', { scopes: ['evidence'] })
  assert.ok(results.every(result => result.scope === 'evidence'))
})

test('空查询与无命中', () => {
  assert.deepEqual(searchWorkspace(createState(), '   ').results, [])
  assert.deepEqual(searchWorkspace(createState(), 'zzzz不存在关键词qqqq').results, [])
})

test('超长材料只检索前 2 万字并给出提示', () => {
  const state = createState()
  state.evidences[0].ocrText = `${'合同总价款为人民币120万元。'.repeat(2000)}`
  assert.ok(state.evidences[0].ocrText.length > MAX_EVIDENCE_SCAN_CHARS)

  const { results, truncated } = searchWorkspace(state, '购销合同')
  assert.equal(truncated, true)
  const evidence = results.find(result => result.scope === 'evidence')
  assert.match(evidence.snippet, /正文仅检索前 2 万字/)
})

test('结果数量受 limit 限制', () => {
  const state = createState()
  state.evidences = Array.from({ length: 10 }, (_, index) => ({
    ...state.evidences[0],
    id: `e-x${index}`,
    number: `E${String(index + 1).padStart(2, '0')}`,
  }))
  const { results } = searchWorkspace(state, '购销合同', { limit: 3 })
  assert.equal(results.length, 3)
})
