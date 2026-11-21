import assert from 'node:assert/strict'
import test from 'node:test'
import { extractRawText } from 'mammoth'
import { caseCitations, describeCaseReportRow, exportCaseResearchReport } from './caseResearchReport.ts'
import type { KnowledgeCase } from '../types.ts'
import type { ReviewElement } from './model.ts'

test('案例报告只纳入文书关联及显式选入结果，同案号跨来源合并', () => {
  const entry = { id: 'stored', title: '文书关联案例', caseNumber: '（2025）京01民终1号', excerpts: [] } as unknown as KnowledgeCase
  const alternate = { ...entry, id: 'alt', caseNumber: '(2025) 京01民终1号' }
  const extra = { id: 'extra', title: '补充案例', caseNumber: '（2024）京01民终2号', excerpts: [] } as unknown as KnowledgeCase
  const element = { verdict: 'fail', sources: [{ st: 'l3', targetId: 'stored', name: entry.title }] } as unknown as ReviewElement
  assert.deepEqual(caseCitations([element], [entry, extra]).map(row => row.entry?.id), ['stored'])
  const rows = caseCitations([element], [entry], [alternate, extra])
  assert.deepEqual(rows.map(row => row.entry?.id), ['stored', 'extra'])
  assert.equal(rows[0].citations[0].element.verdict, 'fail')
  assert.equal(rows[1].citations.length, 0)
})

test('案例报告沿用已核同案关系、保留各审级出处并排除不可引用的结构化结果', () => {
  const first = { id: 'one', title: '一审', caseNumber: '（2022）京0108民初28号', excerpts: [] } as unknown as KnowledgeCase
  const second = { ...first, id: 'two', title: '二审', caseNumber: '（2023）京01民终17号' }
  const documents = [first, second].map(entry => ({ id: entry.id, caseNumber: entry.caseNumber, provider: 'fixture', url: `https://example.invalid/case/${entry.id}` }))
  const element = (entry: KnowledgeCase, allowCitation: boolean) => ({ verdict: allowCitation ? 'warn' : 'fail',
    caseVerification: { groupId: '(2022)京0108民初28号', caseNumber: entry.caseNumber, allowCitation, documents },
    sources: [{ st: 'l3', targetId: entry.id, name: entry.title }],
  }) as unknown as ReviewElement
  const rows = caseCitations([element(second, true), element(first, true)], [first, second], [first])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].citations.length, 2)
  assert.deepEqual(rows[0].documents.map(item => item.url), documents.map(item => item.url))
  assert.equal(caseCitations([element(second, false)], [first, second]).length, 0)
})

test('报告补充案例按归并前案号去重，不收录已被判定不可引用的同案检索结果', () => {
  const linked = { id: 'linked', title: '关联案例', caseNumber: '（2022）京0108民初28号', excerpts: [] } as unknown as KnowledgeCase
  const blocked = { id: 'blocked', title: '不可引用案例', caseNumber: '（2023）京01民终17号', excerpts: [] } as unknown as KnowledgeCase
  const other = { id: 'other', title: '待核检索案例', caseNumber: '（2024）京01民终18号', excerpts: [] } as unknown as KnowledgeCase
  const elements = [
    { verdict: 'warn', caseVerification: { groupId: 'linked-group', caseNumber: linked.caseNumber, allowCitation: true },
      sources: [{ st: 'l3', targetId: linked.id, name: linked.title }] },
    { verdict: 'fail', caseVerification: { caseNumber: blocked.caseNumber, allowCitation: false, documents: [
      { caseNumber: '（2023）京0108民初19号', url: 'https://example.invalid/prior' },
    ] }, sources: [] },
  ] as unknown as ReviewElement[]
  const supplemental = [
    { ...linked, id: 'linked-alias', caseNumber: '(2022) 京0108民初28号' },
    { ...blocked, id: 'blocked-alias', caseNumber: '(2023) 京01民终17号' },
    { ...blocked, id: 'blocked-prior', caseNumber: '(2023) 京0108民初19号' },
    other,
  ]
  assert.deepEqual(caseCitations(elements, [linked], supplemental).map(row => row.entry?.id), ['linked', 'other'])
})

test('已选候选没有实际文书关联时仍作为检索线索入报告', () => {
  const entry = { id: 'candidate', title: '候选案例', caseNumber: '（2024）京01民终18号' } as KnowledgeCase
  const element = { caseVerification: { caseNumber: entry.caseNumber, allowCitation: true }, sources: [] } as unknown as ReviewElement
  assert.deepEqual(caseCitations([element], [], [entry]).map(row => row.entry?.id), [entry.id])
})

test('实际导出的 DOCX 保留预览中的来源与核验状态', async () => {
  const linked = { id: 'linked', title: '关联案例', caseNumber: '（2024）京01民终18号', sourceUrl: 'https://example.invalid/linked' } as KnowledgeCase
  const selected = { id: 'selected', title: '选入案例', caseNumber: '（2024）京01民终19号', sourceUrl: 'https://example.invalid/selected',
    holdingSummary: '搜索结果摘要。' }
  const element = { verdict: 'warn', verified: false, quote: '存在同类争议。', sources: [
    { st: 'l3', targetId: linked.id, name: linked.title, loc: '裁判理由第 1 段', quote: '关联裁判内容。' },
  ] } as unknown as ReviewElement
  const rows = caseCitations([element], [linked], [selected])
  const preview = rows.map(describeCaseReportRow)
  assert.deepEqual(preview.map(item => `${item.source} · ${item.status}`), [
    '文书关联 · 黄·待核对 · 待人工审阅', '补充检索 · 待核对 · 仅作检索线索',
  ])
  assert.ok(preview[1].details.some(item => item.text.includes('检索摘要（裁判要旨，待核）')))

  let bytes: Promise<ArrayBuffer> | undefined
  const anchor = { href: '', download: '', click() { bytes = fetch(this.href).then(response => response.arrayBuffer()) } }
  const before = Object.getOwnPropertyDescriptor(globalThis, 'document')
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => anchor } })
  try {
    await exportCaseResearchReport({ caseName: '回归测试案件', query: '测试检索条件' }, rows)
  } finally {
    if (before) Object.defineProperty(globalThis, 'document', before)
    else Reflect.deleteProperty(globalThis, 'document')
  }
  assert.equal(anchor.download, '案例检索报告-回归测试案件.docx')
  assert.ok(bytes, '导出应下载 DOCX')
  const { value } = await extractRawText({ buffer: Buffer.from(await bytes) })
  for (const item of preview) {
    for (const marker of [item.title, item.caseNumber, `${item.source} · ${item.status}`, ...item.details.flatMap(detail => [detail.text, detail.url])]) {
      if (marker) assert.ok(value.includes(marker), `DOCX 缺少预览中的 ${marker}`)
    }
  }
  for (const marker of ['检索任务', '补充检索关键词：测试检索条件', '检索结果概览', '逐案摘录', '核验声明']) {
    assert.ok(value.includes(marker), `DOCX 缺少 ${marker}`)
  }
})

test('已核案例呈现案由、四要素比对、裁判要旨与文书回查状态', () => {
  const entry = { id: 'linked', title: '关联案例', caseNumber: '（2024）京01民终18号', cause: '民间借贷纠纷',
    holdingSummary: '确认还款义务。' } as KnowledgeCase
  const documents = [{ id: entry.id, caseNumber: entry.caseNumber, provider: 'fixture', url: 'https://example.invalid/judgment' }]
  const element = { quote: '引用声明', verdict: 'warn', sources: [{ st: 'l3', name: entry.title, targetId: entry.id }],
    declaration: { checks: { C3: { reason: '案由匹配。主体匹配。关键事实待核。争议未匹配。' } } },
    caseVerification: { allowCitation: true, detailOutcome: 'found', effect: 'effective', match: 'analogous', documents },
  } as unknown as ReviewElement
  const [row] = caseCitations([element], [entry])
  const preview = describeCaseReportRow(row)
  for (const marker of ['民间借贷纠纷', '主体匹配', '关键事实待核', '争议未匹配', '确认还款义务', '已取得裁判原文']) {
    assert.ok(preview.details.some(detail => detail.text.includes(marker)) || preview.documentStatus.includes(marker), marker)
  }
})
