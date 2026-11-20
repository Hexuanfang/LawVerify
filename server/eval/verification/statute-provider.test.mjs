import assert from 'node:assert/strict'
import test from 'node:test'
import { createLegalStatuteAdapter } from '../../src/integrations/legal-statute.ts'

const locator = { law_name: '测试法', article_number: '第一条', refer_date: '2020-05-11' }
const detail = {
  ...locator, id: 'article-2020', text: '测试条文。', url: 'https://example.invalid/law/2020/1',
  validity: 'REPEALED', version: '2020', effective_date: '2020-01-01', repeal_date: '2021-01-01',
}
const adapterFor = response => createLegalStatuteAdapter(async () => response)

test('检索只给详情候选；取原文时使用候选 ID 和事实日', async () => {
  const requests = []
  const adapter = createLegalStatuteAdapter(async request => {
    requests.push(request)
    return { items: [detail] }
  })
  const { items } = await adapter.search({ action: 'semantic', query: '测试事由', top_k: 5 })
  assert.deepEqual(items, [{ id: 'article-2020', law_name: '测试法', article_number: '第一条' }])
  const exact = await adapter.search({ action: 'search_article', ...locator })
  assert.deepEqual(exact.items, items)
  const result = await adapter.detail({ ...locator, id: items[0].id })
  assert.deepEqual(requests, [
    { action: 'semantic', query: '测试事由', top_k: 5 },
    { action: 'search_article', ...locator },
    { action: 'article_detail', id: 'article-2020', refer_date: '2020-05-11' },
  ])
  assert.equal(result.outcome, 'found')
  assert.deepEqual(result.item, {
    id: 'article-2020', law_name: '测试法', article_number: '第一条', text: '测试条文。',
    url: 'https://example.invalid/law/2020/1', validity: 'REPEALED', version: '2020',
    effective_date: '2020-01-01', repeal_date: '2021-01-01',
  })
  assert.ok(Number.isFinite(Date.parse(result.checkedAt)))
})

test('只有详情可返回权威查无，空结果和失败保留查询状态', async () => {
  const missing = adapterFor({ outcome: 'authoritative-not-found' })
  assert.equal((await missing.detail(locator)).outcome, 'authoritative-not-found')
  assert.equal((await missing.search({ action: 'search_article', ...locator })).outcome, 'no-candidates')
  assert.equal((await adapterFor({ items: [] }).detail(locator)).outcome, 'empty-response')
  assert.equal((await adapterFor({ outcome: 'forbidden' }).detail(locator)).outcome, 'forbidden')
  const timeout = createLegalStatuteAdapter(async () => { throw new DOMException('timeout', 'TimeoutError') })
  assert.equal((await timeout.detail(locator)).outcome, 'timeout')
})

test('详情缺正文、仅有摘要、缺来源或返回了其他 ID 均不能引用', async () => {
  for (const invalid of [
    { ...detail, text: '官方原文已定位' },
    { ...detail, text: undefined, summary: '测试摘要' },
    { ...detail, url: undefined },
    { ...detail, url: 'https://example.invalid/' },
    { ...detail, id: 'other-version' },
  ]) {
    const result = await adapterFor({ items: [invalid] }).detail({ ...locator, id: 'article-2020' })
    assert.equal(result.outcome, 'unverified-detail')
    assert.equal(result.item, undefined)
  }
})
