import assert from 'node:assert/strict'
import { test } from 'node:test'
import { linkageMaterialFingerprint } from '../src/intelligence/case-agent.ts'
import { selectEvidenceChunksForUnderstanding } from '../src/intelligence/evidence-retrieval.ts'

const evidence = (id, overrides = {}) => ({
  id,
  caseId: 'case',
  number: id,
  name: id,
  type: 'pdf',
  fileName: `${id}.pdf`,
  uploadedAt: '2026-01-01T00:00:00.000Z',
  ocrText: '',
  ...overrides,
})

const insight = (evidenceId, version) => ({
  id: `insight-${evidenceId}`,
  caseId: 'case',
  evidenceId,
  version,
  summary: '',
  keyFacts: [],
  entities: [],
  timelineEvents: [],
  amounts: [],
  positions: [],
  issues: [],
  sourceFragmentIds: [],
  confidence: 0.7,
  status: 'ready',
  updatedAt: '2026-01-01T00:00:00.000Z',
})

test('材料指纹在材料增删或重新理解后变化', () => {
  const base = linkageMaterialFingerprint([evidence('a')], [insight('a', 1)])
  assert.equal(base, linkageMaterialFingerprint([evidence('a')], [insight('a', 1)]), '材料不变时指纹稳定')

  const added = linkageMaterialFingerprint([evidence('a'), evidence('b')], [insight('a', 1), insight('b', 1)])
  assert.notEqual(base, added, '新增材料后指纹必须变化')

  const removed = linkageMaterialFingerprint([evidence('b')], [insight('b', 1)])
  assert.notEqual(base, removed, '删除材料后指纹必须变化')

  const reanalyzed = linkageMaterialFingerprint([evidence('a')], [insight('a', 2)])
  assert.notEqual(base, reanalyzed, '材料重新理解后指纹必须变化')
})

test('材料顺序不影响指纹', () => {
  const left = linkageMaterialFingerprint([evidence('a'), evidence('b')], [insight('a', 1), insight('b', 1)])
  const right = linkageMaterialFingerprint([evidence('b'), evidence('a')], [insight('b', 1), insight('a', 1)])
  assert.equal(left, right)
})

test('新证据的具体事实能在旧大材料里反查到相关内容', () => {
  const filler = '（本页为与争议无关的会议安排与通知事项的记录。）'.repeat(200)
  const text = [
    filler,
    '双方于 2024 年 3 月 15 日确认还款十万元，并在收据上签字。',
    filler,
  ].join('\n')

  const selection = selectEvidenceChunksForUnderstanding({
    text,
    queries: ['2024 年 3 月 15 日', '十万元'],
    maxChars: 4000,
    maxChunks: 8,
  })

  assert.ok(selection.chunks.some((chunk) => chunk.content.includes('2024 年 3 月 15 日')))
})

test('已覆盖的块在反查时不会被重复覆盖', () => {
  const text = [
    '双方于 2024 年 3 月 15 日确认还款十万元。',
    fillerBlock(),
  ].join('\n')

  const first = selectEvidenceChunksForUnderstanding({ text, queries: ['还款十万元'], maxChunks: 4 })
  assert.ok(first.coveredChunks > 0)

  const second = selectEvidenceChunksForUnderstanding({
    text,
    queries: ['还款十万元'],
    maxChunks: 4,
    excludeChunkIndexes: first.coveredChunkIndexes,
  })
  assert.equal(second.coveredChunks, 0)
})

function fillerBlock() {
  return '（本页为与争议无关的会议安排与通知事项的记录。）'.repeat(200)
}
