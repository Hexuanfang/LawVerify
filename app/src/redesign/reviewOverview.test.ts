import assert from 'node:assert/strict'
import test from 'node:test'
import { documentBadge, groupReview, linkedAuthorities } from './reviewOverview.ts'
import type { ReviewElement, Source } from './model.ts'
import type { AppState } from '../types.ts'

const source = (id: string): Source => ({ st: 'l3', targetId: id, name: id, loc: '裁判要旨', quote: '摘录' })
const item = (verdict: ReviewElement['verdict'], verified = false, sources: Source[] = []): ReviewElement => ({
  id: verdict, paragraphId: verdict, certificateId: 'doc', quote: '声明', start: 0, end: 2,
  src: sources[0]?.st ?? 'l0', type: '事实声明', verdict, conf: null, reason: '核验说明', sources, note: '', verified,
  original: { id: verdict, text: '声明', verified },
})

test('红灯、待核验和预警按先后顺序进入待办', () => {
  const elements = [item('warn'), item('pass', true), item('note', true), item('pending'), item('fail', true), item('miss')]
  const result = groupReview(elements)
  assert.deepEqual(result.todo.map(row => row.verdict), ['fail', 'miss', 'pending', 'warn'])
  assert.equal(result.processed, 2)
  assert.deepEqual(documentBadge(elements), { tone: 'fail', count: 3, label: '3 项待处理' })
  assert.deepEqual(documentBadge([item('warn')]), { tone: 'warn', count: 0, label: '有预警' })
  assert.equal(documentBadge([]), null)
})

test('已忽略黄灯进入处理进度，仍保留在预警分组', () => {
  const accepted = { ...item('warn'), ignored: true }
  const groups = groupReview([accepted, item('pending')])
  assert.deepEqual(groups.warnings, [accepted])
  assert.deepEqual(groups.todo.map(row => row.verdict), ['pending'])
  assert.equal(groups.processed, 1)
})

test('关联依据合并重复条目并保留不同出处', () => {
  const common = source('case')
  const rows = [item('warn', false, [common]), item('pass', true, [common, { ...common, loc: '裁判结果' }, source('case2')])]
  assert.deepEqual(linkedAuthorities(rows).map(row => row.locations.map(item => [item.source.targetId, item.source.loc])), [
    [['case', '裁判要旨'], ['case', '裁判结果']], [['case2', '裁判要旨']],
  ])
})

test('关联依据按法条版本及裁判归档，保留不同出处与手动、MCP 来源', () => {
  const law = (id: string): Source => ({ st: 'l2', targetId: id, name: '同名法条', loc: '第一条', quote: '条文' })
  const first = source('case-entry')
  const second = { ...source('case-excerpt'), loc: '判项' }
  const rows = [item('warn', false, [first, law('old-law'), law('new-law')]), item('pass', true, [second, { ...first, reason: '人工挂靠出处' }])]
  const workspace = {
    knowledgeCases: [{ id: first.targetId, caseNumber: '（2025）京01民终1号', sourceType: 'MCP', excerpts: [{ id: second.targetId }] }],
    knowledgeStatutes: ['old', 'new'].map(version => ({ id: version, title: '同名法条', version, effectiveDate: version,
      articles: [{ id: `${version}-law`, articleNumber: '第一条' }] })),
  } as unknown as AppState
  const groups = linkedAuthorities(rows, workspace)
  assert.equal(groups.length, 3)
  assert.deepEqual(groups[0].locations.map(({ source, manual, mcp }) => [source.loc, manual, mcp]), [
    ['裁判要旨', true, true], ['判项', false, true],
  ])
  assert.deepEqual(groups.slice(1).map(group => group.version), ['old', 'new'])
})
