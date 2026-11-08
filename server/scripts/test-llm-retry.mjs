import assert from 'node:assert/strict'
import { test } from 'node:test'

const { env } = await import('../src/config/env.ts')
env.AI_GATEWAY_MODE = 'direct'
env.LLM_BASE_URL = 'http://127.0.0.1:9/v1'
env.LLM_API_KEY = 'test-key'
env.LLM_MODEL = 'test-model'
env.LLM_RETRY_BASE_DELAY_MS = 1

const { createChatCompletion } = await import('../src/integrations/llm-service.ts')

function okResponse(content) {
  return {
    ok: true,
    status: 200,
    body: { cancel: async () => {} },
    json: async () => ({ choices: [{ message: { content } }] }),
  }
}

function errorResponse(status) {
  return {
    ok: false,
    status,
    body: { cancel: async () => {} },
    json: async () => ({}),
  }
}

async function withFetch(handler, action) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (...args) => {
    calls.push(args)
    return handler(calls.length)
  }
  try {
    await action(calls)
  } finally {
    globalThis.fetch = original
  }
}

test('上游限流时退避重试并最终成功', async () => {
  await withFetch((attempt) => attempt < 3 ? errorResponse(429) : okResponse('整理结果'), async (calls) => {
    const completion = await createChatCompletion({ messages: [{ role: 'user', content: '整理' }] })
    assert.equal(completion.content, '整理结果')
    assert.equal(calls.length, 3, '限流时应当重试到第三次')
  })
})

test('限流持续存在时给出带状态码的错误', async () => {
  await withFetch(() => errorResponse(429), async (calls) => {
    await assert.rejects(
      createChatCompletion({ messages: [{ role: 'user', content: '整理' }] }),
      /429/,
    )
    assert.equal(calls.length, 3, '重试次数应有上限')
  })
})

test('鉴权失败不重试，直接报出状态码', async () => {
  await withFetch(() => errorResponse(401), async (calls) => {
    await assert.rejects(
      createChatCompletion({ messages: [{ role: 'user', content: '整理' }] }),
      /401/,
    )
    assert.equal(calls.length, 1, '鉴权失败重试没有意义')
  })
})