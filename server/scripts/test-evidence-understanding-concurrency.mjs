import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

process.env.WORKSPACE_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'lawverify-evidence-understanding-'))

const { mapWithConcurrency, mapSettledWithConcurrency } = await import('../src/infrastructure/concurrency.ts')
const { withLlmCallCache } = await import('../src/infrastructure/llm-call-cache.ts')

// 1. 限流并发：并发度不得超过 limit，且结果顺序与输入一致。
{
  let active = 0
  let peak = 0
  const items = Array.from({ length: 9 }, (_, index) => index)
  const results = await mapWithConcurrency(items, 3, async (item) => {
    active += 1
    peak = Math.max(peak, active)
    await new Promise((resolve) => setTimeout(resolve, 20))
    active -= 1
    return item * 2
  })
  assert.equal(peak, 3, `并发峰值应为 3，实际 ${peak}`)
  assert.deepEqual(results, items.map((item) => item * 2), '结果顺序应与输入一致')
}

// 2. 单项失败不影响其它项，且失败位置为 undefined。
{
  const results = await mapWithConcurrency([1, 2, 3], 2, async (item) => {
    if (item === 2) throw new Error('boom')
    return item
  })
  assert.equal(results[0], 1)
  assert.equal(results[1], undefined, '失败位置应为空')
  assert.equal(results[2], 3, '失败不应影响其它任务')
}

// 3. settled 版本保留真实错误，供上层透传。
{
  const results = await mapSettledWithConcurrency([1, 2], 2, async (item) => {
    if (item === 2) throw new Error('模型服务暂不可用')
    return item
  })
  assert.equal(results[0].ok, true)
  assert.equal(results[1].ok, false)
  assert.equal(results[1].error.message, '模型服务暂不可用')
}

// 4. 并发写缓存不丢条目：多次并发写入不同键后，全部可命中。
{
  const keys = Array.from({ length: 6 }, (_, index) => ({ index }))
  await Promise.all(keys.map((payload) => withLlmCallCache('evidence-understanding-demo', payload, async () => {
    await new Promise((resolve) => setTimeout(resolve, 10))
    return { value: payload.index }
  })))
  for (const payload of keys) {
    const hit = await withLlmCallCache('evidence-understanding-demo', payload, async () => {
      throw new Error('不应再次调用模型')
    })
    assert.equal(hit.reused, true, `并发写入后键 ${payload.index} 应仍可命中`)
    assert.equal(hit.value.value, payload.index)
  }
}

// 5. 缓存键必须只由内容决定：易变字段（随机 id、版本号、时间戳）变化时仍应命中。
{
  const buildKeyPayload = (insightId, version, updatedAt) => ({
    model: 'MiniMax-M3.1-Flash',
    position: { party: '原告', role: 'plaintiff', goals: ['追讨欠款'], admissions: [], disputes: ['是否还款'], boundaries: [] },
    memory: { summary: '借款纠纷', parties: ['张三'], disputeFocuses: ['还款事实'] },
    evidences: [{
      id: 'evidence-1',
      number: 'E01',
      name: '借款合同',
      insight: {
        id: insightId,
        version,
        updatedAt,
        summary: '张三与李四签订借款合同',
        keyFacts: ['借款50万元'],
        status: 'ready',
      },
    }],
  })
  const strip = (payload) => ({
    model: payload.model,
    position: payload.position,
    memory: payload.memory,
    evidences: payload.evidences.map((item) => ({
      id: item.id,
      number: item.number,
      name: item.name,
      insight: item.insight ? {
        summary: item.insight.summary,
        keyFacts: item.insight.keyFacts,
        status: item.insight.status,
      } : null,
    })),
  })

  let calls = 0
  const first = await withLlmCallCache('case-strategy-demo', strip(buildKeyPayload('insight-a', 1, '2026-01-01T00:00:00Z')), async () => {
    calls += 1
    return { content: 'ok' }
  })
  assert.equal(first.reused, false)

  const second = await withLlmCallCache('case-strategy-demo', strip(buildKeyPayload('insight-b', 7, '2026-02-02T00:00:00Z')), async () => {
    calls += 1
    return { content: 'ok' }
  })
  assert.equal(second.reused, true, '仅随机 id / 版本号 / 时间戳变化时不应重新调用模型')
  assert.equal(calls, 1)

  const changed = await withLlmCallCache('case-strategy-demo', strip({
    ...buildKeyPayload('insight-c', 8, '2026-03-03T00:00:00Z'),
    evidences: [{
      id: 'evidence-1',
      number: 'E01',
      name: '借款合同',
      insight: {
        id: 'insight-c',
        version: 8,
        updatedAt: '2026-03-03T00:00:00Z',
        summary: '张三与李四签订借款合同并已部分还款',
        keyFacts: ['借款50万元', '已还款10万元'],
        status: 'ready',
      },
    }],
  }), async () => {
    calls += 1
    return { content: 'ok' }
  })
  assert.equal(changed.reused, false, '内容变化时应重新调用模型')
  assert.equal(calls, 2)
}

console.log('evidence understanding concurrency and cache ok')
