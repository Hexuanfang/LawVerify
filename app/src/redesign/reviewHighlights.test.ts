import assert from 'node:assert/strict'
import { test } from 'node:test'
import { reviewTextTargets } from './reviewHighlights.ts'

test('核验高亮定位到原句所在的块及偏移，正文改动后失效', () => {
  const blocks = [
    { blockId: 'first-row', text: '已还款', offset: 2 },
    { blockId: 'second-cell', text: '已还款', separator: '\t' },
    { blockId: 'next-row', text: '已确认', separator: '\n', offset: 1 },
  ]
  const original = '已还款\t已还款\n已确认'
  assert.deepEqual(reviewTextTargets(original, '还款\n已确', 5, 10, blocks), [
    { kind: 'text', blockId: 'second-cell', range: { start: 1, end: 3 } },
    { kind: 'text', blockId: 'next-row', range: { start: 1, end: 3 } },
  ])
  assert.deepEqual(reviewTextTargets(original, '已还款', 0, 3, blocks), [
    { kind: 'text', blockId: 'first-row', range: { start: 2, end: 5 } },
  ])
  assert.deepEqual(reviewTextTargets(original, '已还款', 0, 3,
    [blocks[0], blocks[1], { ...blocks[2], text: '未确认' }]), [])
  assert.deepEqual(reviewTextTargets(original, '已确认', 0, 3, blocks), [])
})
