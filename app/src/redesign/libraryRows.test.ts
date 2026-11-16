import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createLawCursor, readLawBatch, sameLawRows } from './libraryRows.ts'
import type { KnowledgeStatuteDocument } from '../types'

function statutes() {
  return ['A', 'B'].map(letter => ({ id: 'duplicated-document-id', title: letter, issuer: '', effectiveDate: '', effectiveStatus: 'effective', articles: Array.from({ length: 50 }, (_, index) => ({ id: 'reused-article-id', articleNumber: `第${index + 1}条`, plainText: `${letter} 正文 ${index}`, content: '' })) })) as unknown as KnowledgeStatuteDocument[]
}
test('分批读取首40条与后续内容，不重复或漏条', () => {
  const cursor = createLawCursor(statutes(), '')
  const first = readLawBatch(cursor), second = readLawBatch(cursor), third = readLawBatch(cursor)
  assert.equal(first.rows.length, 40)
  assert.equal(second.rows.length, 40)
  assert.equal(third.rows.length, 20)
  assert.equal(first.hasMore, true)
  assert.equal(third.hasMore, false)
  assert.equal(new Set([...first.rows, ...second.rows, ...third.rows].map(row => row.key)).size, 100)
  assert.equal(readLawBatch(cursor).rows.length, 0)
})
test('搜索覆盖未加载的条文，分类和搜索游标彼此独立', () => {
  const data = statutes()
  const initial = createLawCursor(data, '')
  readLawBatch(initial)
  const search = readLawBatch(createLawCursor(data, 'B 第50条'))
  assert.equal(search.rows.length, 1)
  assert.equal(search.rows[0].description, 'B 正文 49')
  assert.equal(readLawBatch(initial).rows[0].title, 'A 第41条')
  assert.equal(readLawBatch(createLawCursor(data, '不存在')).hasMore, false)
})
test('没有搜索条件时只访问首批所需条文', () => {
  const data = statutes()
  let touched = 0
  data[0].articles.forEach(article => Object.defineProperty(article, 'plainText', { get() { touched++; return '正文' } }))
  const cursor = createLawCursor(data, '')
  assert.equal(touched, 0)
  readLawBatch(cursor)
  assert.equal(touched, 41, '首批只构建40条与1条后续标记')
})

test('不变的刷新快照保留加载进度，正文或顺序变化需要重新读取', () => {
  const data = statutes(), copy = structuredClone(data)
  assert.equal(sameLawRows(data, copy), true)
  copy[0].articles[0].plainText = '新正文'
  assert.equal(sameLawRows(data, copy), false)
  assert.equal(sameLawRows(data, [...data].reverse()), false)
})
