import assert from 'node:assert/strict'
import test from 'node:test'
import { createYuandianStatuteAdapter } from '../../src/integrations/yuandian-statute.ts'
import { extractDeclarations } from '../../src/intelligence/verification/extract.ts'
import { verifyLegalDeclarations } from '../../src/intelligence/verification/legal.ts'

const result = { article_id: 'fixture-675', article_number: '675', regulation_name: '中华人民共和国民法典',
  regulation_id: 'fixture-civil-code-edition', content: '借款人应当按照约定的期限返还借款。',
  url: 'https://example.invalid/legal/articles/675', validity_status: '现行有效', effective_date: '2021-01-01', primary_effect_level: '法律' }
const detail = { structuredContent: { success: true, status: 'success', data: result } }
const title = '中华人民共和国民法典'
const article = '第六百七十五条'

test('元典语义、精确搜索和按 ID 详情严格使用公布的 schema', async () => {
  const calls = []
  const adapter = createYuandianStatuteAdapter(async (name, args) => {
    calls.push([name, args])
    if (name.includes('semantic')) return { structuredContent: { success: true, results: { law_article_list: [result] } } }
    if (name.includes('search')) return { structuredContent: { success: true, results: [result] } }
    return detail
  })
  assert.deepEqual((await adapter.search({ action: 'semantic', query: '借款期限', top_k: 5 })).items.map(item => item.id), ['fixture-675'])
  const search = await adapter.search({ action: 'search_article', law_name: title, article_number: article })
  assert.deepEqual(search.items, [{ id: 'fixture-675', law_name: title, article_number: '第675条' }])
  const found = await adapter.detail({ law_name: title, article_number: article, id: search.items[0].id })
  assert.deepEqual(calls, [
    ['yuandian_semantic_search_legal_articles', { query: '借款期限', limit: 5, rewrite_enabled: false }],
    ['yuandian_search_legal_articles', { regulation_name: title, keyword: article, top_k: 5 }],
    ['yuandian_get_legal_article_detail', { article_id: 'fixture-675' }],
  ])
  assert.equal(found.item.text, result.content)
  assert.equal(found.item.version, result.regulation_id)
  assert.equal(found.item.doc_type, '法律')
})

test('事实日必须通过法名加条号查询，不能用不切换版本的 article_id', async () => {
  const calls = []
  const adapter = createYuandianStatuteAdapter(async (name, args) => { calls.push([name, args]); return detail })
  const text = `2023年3月15日交付借款。依据《${title}》${article}：“${result.content}”`
  const document = { id: 'yuandian-dated', docKey: 'qs', paragraphs: [{ id: 'p', text }] }
  const { declarations } = extractDeclarations(document)
  const checked = await verifyLegalDeclarations(document, declarations, { knowledgeCases: [], knowledgeStatutes: [] }, adapter)
  const law = checked.find(item => item.type === 'E-LAW')
  assert.deepEqual(calls, [['yuandian_get_legal_article_detail', {
    regulation_name: title, article_number: article, reference_date: '2023-03-15',
  }]])
  assert.equal(law.checks.B1.outcome, 'pass')
  assert.equal(law.statuteVerification.confidence, 'MEDIUM')
  assert.equal(law.checks.B2.outcome, 'warn')
})

test('元典业务错误不会变成权威查无，临时访问链接不进入来源', async () => {
  const locator = { law_name: title, article_number: article }
  const permissionError = { isError: true, structuredContent: { success: false, message: '已暂停您的接口调用权限24小时。' } }
  const get = response => createYuandianStatuteAdapter(async () => response)
  assert.equal((await get(permissionError).detail(locator)).outcome, 'forbidden')
  assert.equal((await get({ structuredContent: { success: false, status: 'not_found' } }).detail(locator)).outcome, 'unavailable')
  assert.equal((await get({ structuredContent: { success: true, data: { ...result, url: `${result.url}?token=fixture` } } }).detail(locator)).outcome, 'unverified-detail')
  assert.equal((await get({ structuredContent: { success: true, data: { ...result, share_expires_at: '2026-11-19' } } }).detail(locator)).outcome, 'unverified-detail')
})

test('法名和条号详情明确无内容才判查无，搜索零结果与无 ID 返回独立处理', async () => {
  const adapter = createYuandianStatuteAdapter(async name => ({ structuredContent: name.includes('detail')
    ? { success: true, status: 'success', message: '未查询到相关内容' } : { success: true, results: [] } }))
  const locator = { law_name: title, article_number: article }
  assert.equal((await adapter.detail(locator)).outcome, 'authoritative-not-found')
  assert.equal((await adapter.detail({ ...locator, id: 'stale' })).outcome, 'empty-response')
  assert.equal((await adapter.search({ action: 'search_article', ...locator })).outcome, 'no-candidates')
})
