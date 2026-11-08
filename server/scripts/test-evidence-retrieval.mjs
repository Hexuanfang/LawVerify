import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildEvidenceChunkIndex,
  buildEvidenceChunks,
  expandChunkIndexes,
  searchEvidenceChunkIndex,
  selectEvidenceChunksForUnderstanding,
  splitEvidenceTextIntoPages,
} from '../src/intelligence/evidence-retrieval.ts'

const page = (index, body) => `----- 第 ${index} / 3 页 -----\n${body}`

test('PDF 页标记被识别，页码跟随内容块', () => {
  const text = [
    page(1, '甲方与乙方签订借款合同，借款金额五十万元整。'),
    page(2, '乙方于 2024 年 5 月 6 日归还十万元，双方对余款发生争议。'),
    page(3, '本案争议焦点为借款是否清偿以及利息计算标准。'),
  ].join('\n\n')

  const pages = splitEvidenceTextIntoPages(text)
  assert.equal(pages.length, 3)
  assert.equal(pages[0].page, 1)
  assert.match(pages[1].content, /归还十万元/)

  const chunks = buildEvidenceChunks(text)
  assert.ok(chunks.length >= 3)
  assert.ok(chunks.every((chunk) => chunk.page !== undefined))
  assert.equal(chunks[0].index, 0)
})

test('没有页标记的文本按整体切块，不丢内容', () => {
  const pages = splitEvidenceTextIntoPages('借款合同，金额五十万元。')
  assert.equal(pages.length, 1)
  assert.equal(pages[0].page, undefined)
  assert.match(pages[0].content, /借款合同/)
})

test('块级索引按检索词命中相关块', () => {
  const text = [
    '甲方与乙方签订借款合同，借款金额五十万元整。',
    '本案争议焦点为诉讼时效是否届满。',
    '双方在会议纪要中确认欠款金额与还款计划。',
  ].join('\n')
  const chunks = buildEvidenceChunks(text)
  const index = buildEvidenceChunkIndex(chunks)
  const hits = searchEvidenceChunkIndex(index, ['诉讼时效'], 5)
  assert.ok(hits.length > 0)
  assert.match(chunks[hits[0]].content, /诉讼时效/)
})

test('命中块带回相邻块', () => {
  assert.deepEqual(expandChunkIndexes([3], 8, 1), [2, 3, 4])
  assert.deepEqual(expandChunkIndexes([0], 8, 1), [0, 1])
  assert.deepEqual(expandChunkIndexes([7], 8, 1), [6, 7])
  assert.deepEqual(expandChunkIndexes([3], 8, 0), [3])
})

test('检索式理解只覆盖命中块，并记录覆盖情况', () => {
  const filler = '（本页为与争议无关的会议安排与通知事项的记录。）'.repeat(200)
  const text = [
    filler,
    '本案争议焦点为借款是否清偿以及利息计算标准。',
    filler,
  ].join('\n')

  const selection = selectEvidenceChunksForUnderstanding({
    text,
    queries: ['争议焦点 利息计算'],
    maxChars: 4000,
    maxChunks: 8,
  })

  assert.ok(selection.totalChunks > selection.coveredChunks, '只应覆盖部分块')
  assert.ok(selection.chunks.some((chunk) => chunk.content.includes('争议焦点')))
  assert.equal(selection.coveredChunkIndexes.length, selection.coveredChunks)

  const hitIndex = selection.coveredChunkIndexes.find((chunkIndex) =>
 selection.chunks.some((chunk) => chunk.index === chunkIndex && chunk.content.includes('争议焦点')))
  assert.ok(hitIndex !== undefined)
  assert.ok(selection.coveredChunkIndexes.includes(hitIndex - 1) || hitIndex === 0)
  assert.ok(selection.coveredChunkIndexes.includes(hitIndex + 1) || hitIndex === selection.totalChunks - 1)
})

test('已覆盖的块不会在增量检索中重复覆盖', () => {
  const text = [
    '本案争议焦点为借款是否清偿以及利息计算标准。',
    '双方在会议纪要中确认欠款金额与还款计划。',
    '甲方主张已经足额支付全部利息。',
  ].join('\n')

  const first = selectEvidenceChunksForUnderstanding({ text, queries: ['争议焦点'], maxChunks: 4 })
  assert.ok(first.coveredChunks > 0)

  const second = selectEvidenceChunksForUnderstanding({
    text,
    queries: ['争议焦点'],
    maxChunks: 4,
    excludeChunkIndexes: first.coveredChunkIndexes,
  })
  assert.equal(second.coveredChunks, 0)
  assert.ok(second.coveredChunkIndexes.every((chunkIndex) => !first.coveredChunkIndexes.includes(chunkIndex)))
})

test('空文本不会产生块', () => {
  const selection = selectEvidenceChunksForUnderstanding({ text: '', queries: ['争议焦点'] })
  assert.equal(selection.totalChunks, 0)
  assert.equal(selection.coveredChunks, 0)
  assert.deepEqual(selection.chunks, [])
})

test('检索词完全落空时按均匀间隔兜底采样，不放弃整份材料', () => {
  const text = Array.from({ length: 200 }, (_, index) =>
    `Clause ${index + 1}: the borrower shall repay the principal within thirty days.`).join('\n')

  const selection = selectEvidenceChunksForUnderstanding({
    text,
    queries: ['争议焦点', '合同纠纷'],
    maxChunks: 5,
    maxChars: 6000,
  })

  assert.ok(selection.totalChunks > 5)
  assert.ok(selection.coveredChunks > 0, '检索落空时也应覆盖一部分内容')
  assert.ok(selection.chunks.some((chunk) => chunk.content.includes('Clause')), '兜底采样应取到原文内容')
})
