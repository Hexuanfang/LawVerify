import assert from 'node:assert/strict'
import { test } from 'node:test'
import { reviewSelection } from './documentSelection.ts'

test('重复原句使用 SuperDoc 段落定位，跨单元格选区保留正文偏移', () => {
  const targets = new Map([
    ['first', [{ blockId: 'a', text: '同一句。' }]],
    ['second', [{ blockId: 'b', text: '证据' }, { blockId: 'c', text: '同一句。', separator: '\t', offset: 2 }]],
  ])
  const result = reviewSelection({ kind: 'text', segments: [{ blockId: 'c', range: { start: 2, end: 6 } }] }, targets,
    [{ id: 'first', text: '同一句。' }, { id: 'second', text: '证据\t同一句。' }], [])
  assert.deepEqual(result.anchor, { paragraphId: 'second', start: 3, quote: '同一句。' })
})

test('正文改动后不会将选区关联到旧核验句子', () => {
  const result = reviewSelection({ kind: 'text', segments: [{ blockId: 'a', range: { start: 0, end: 4 } }] },
    new Map([['first', [{ blockId: 'a', text: '新正文。' }]]]), [{ id: 'first', text: '旧正文。' }], [])
  assert.equal(result.anchor, undefined)
})
