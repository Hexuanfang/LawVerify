import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { env } from '../src/config/env.ts'

const dir = mkdtempSync(path.join(os.tmpdir(), 'lawverify-cloud-transport-'))
env.WORKSPACE_DATA_DIR = dir
env.AI_GATEWAY_MODE = 'cloud'
env.CLOUD_API_BASE_URL = 'https://gateway.test.invalid'
env.LLM_API_KEY = undefined
env.LLM_BASE_URL = undefined
env.EMBEDDING_API_KEY = undefined
const { runWithWorkspaceAccount } = await import('../src/store.ts')
const { rememberCloudAiToken } = await import('../src/integrations/cloud-ai.ts')
const { createChatCompletion, createChatCompletionStream, isLlmConfigured } = await import('../src/integrations/llm-service.ts')
const { createEmbedding } = await import('../src/integrations/embedding-service.ts')
const original = globalThis.fetch
const calls = []
test('secret-free cloud transport authenticates per account, preserves stream and rejects interruptions', async t => {
  t.after(() => { globalThis.fetch = original; rmSync(dir, { recursive: true, force: true }) })
  let interrupted = false
  globalThis.fetch = async (input, init) => {
    calls.push(String(input))
    assert.ok(String(input).startsWith('https://gateway.test.invalid/api/ai/'))
    const headers = new Headers(init.headers)
    assert.equal(headers.get('authorization'), 'Bearer session-only-token')
    assert.match(headers.get('x-ai-request-id'), /^[a-f0-9-]{36}$/)
    const payload = JSON.parse(init.body)
    assert.equal(payload.model, undefined)
    assert.equal(payload.apiKey, undefined)
    if (String(input).endsWith('/embeddings')) return Response.json({ data: [{ index: 0, embedding: [0.1, 0.2] }] })
    if (!payload.stream) return Response.json({ choices: [{ message: { content: 'ok' } }] })
    const encoder = new TextEncoder()
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"first"}}]}\r\n'))
        controller.enqueue(encoder.encode('\r\ndata: {"choices":[{"delta":{"content":"second"}}]}\n\n'))
        if (!interrupted) controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      },
    }))
  }
  assert.equal(isLlmConfigured(), true)
  await runWithWorkspaceAccount('one@test.invalid', async () => {
    await assert.rejects(createChatCompletion({ messages: [{ role: 'user', content: 'test' }] }), /登录/)
    rememberCloudAiToken('session-only-token')
    assert.equal((await createChatCompletion({ messages: [{ role: 'user', content: 'test' }] })).content, 'ok')
    const chunks = []
    for await (const chunk of createChatCompletionStream({ messages: [{ role: 'user', content: 'test' }] })) chunks.push(chunk)
    assert.deepEqual(chunks, ['first', 'second'])
    assert.deepEqual(await createEmbedding('test'), [0.1, 0.2])
    interrupted = true
    await assert.rejects(async () => {
      for await (const _ of createChatCompletionStream({ messages: [{ role: 'user', content: 'test' }] })) {}
    }, /中断/)
  })
  await runWithWorkspaceAccount('two@test.invalid', async () => {
    await assert.rejects(createChatCompletion({ messages: [{ role: 'user', content: 'test' }] }), /登录/)
  })
  assert.equal(calls.length, 4)
})
