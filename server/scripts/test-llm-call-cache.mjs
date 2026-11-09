import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

process.env.WORKSPACE_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'lawverify-llm-cache-'))

const { withLlmCallCache, getLlmCallCacheHitCount, resetLlmCallCacheHitCount } = await import('../src/infrastructure/llm-call-cache.ts')

resetLlmCallCacheHitCount()

let calls = 0
const run = async () => {
  calls += 1
  return { result: 'ok' }
}

const first = await withLlmCallCache('demo', { paragraphIds: ['p1'] }, run)
assert.equal(first.reused, false)
assert.equal(calls, 1)

const second = await withLlmCallCache('demo', { paragraphIds: ['p1'] }, run)
assert.equal(second.reused, true, '相同请求应命中缓存')
assert.equal(calls, 1, '命中缓存时不应再次调用模型')
assert.deepEqual(second.value, { result: 'ok' })

const changed = await withLlmCallCache('demo', { paragraphIds: ['p2'] }, run)
assert.equal(changed.reused, false, '请求内容变化应重新调用模型')
assert.equal(calls, 2)

assert.equal(getLlmCallCacheHitCount(), 1, '命中次数应被统计')

console.log('llm call cache ok')
