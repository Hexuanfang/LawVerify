import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { config } from '../config.js'
import { requestChatProvider } from '../integrations/chat-provider.js'

function fixture(t: TestContext) {
  const originalConfig = { ...config }
  const originalFetch = globalThis.fetch
  t.after(() => { Object.assign(config, originalConfig); globalThis.fetch = originalFetch })
  Object.assign(config, {
    LLM_BASE_URL: 'https://primary.test.invalid/v1', LLM_API_KEY: 'primary-key', LLM_MODEL: 'primary-model',
    LLM_VISION_BASE_URL: 'https://fallback.test.invalid/v1', LLM_VISION_API_KEY: 'fallback-key', LLM_VISION_MODEL: 'fallback-model',
    LLM_TEXT_FALLBACK_ENABLED: true, LLM_TIMEOUT_MS: 120000,
  })
}

test('busy default model switches provider before a stream starts', async t => {
  fixture(t)
  const calls: string[] = []
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    calls.push(url)
    const body = JSON.parse(String(init?.body))
    if (url.includes('primary.')) return new Response('busy', { status: 503 })
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fallback-key')
    assert.equal(body.model, 'fallback-model')
    assert.equal(body.stream, true)
    return new Response('data: [DONE]\n\n')
  }
  assert.match(await (await requestChatProvider({ messages: [], stream: true }, false)).text(), /\[DONE\]/)
  assert.equal(calls.length, 2)
})

test('explicit model selection and vision requests never silently switch provider', async t => {
  fixture(t)
  let calls = 0
  globalThis.fetch = async () => { calls++; return new Response('busy', { status: 503 }) }
  await assert.rejects(requestChatProvider({}, false, 'primary-model'), /暂不可用/)
  assert.equal(calls, 1)
  await assert.rejects(requestChatProvider({}, true), /暂不可用/)
  assert.equal(calls, 2)
})

test('invalid credentials are not retried against another provider', async t => {
  fixture(t)
  let calls = 0
  globalThis.fetch = async () => { calls++; return new Response('invalid key', { status: 401 }) }
  await assert.rejects(requestChatProvider({}, false), /暂不可用/)
  assert.equal(calls, 1)
})

test('connection failure can fail over, but a successful or already started response is never replayed', async t => {
  fixture(t)
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    if (calls === 1) throw new TypeError('connection reset')
    return Response.json({ choices: [{ message: { content: 'ok' } }] })
  }
  const response = await requestChatProvider({}, false)
  assert.equal((await response.json()).choices[0].message.content, 'ok')
  assert.equal(calls, 2)
  await requestChatProvider({}, false)
  assert.equal(calls, 3)
})

test('missing fallback and invalid primary URL cannot bypass provider security checks', async t => {
  fixture(t)
  config.LLM_VISION_API_KEY = undefined
  let calls = 0
  globalThis.fetch = async () => { calls++; return new Response('busy', { status: 503 }) }
  await assert.rejects(requestChatProvider({}, false), /暂不可用/)
  assert.equal(calls, 1)
  config.LLM_BASE_URL = 'http://untrusted.test.invalid/v1'
  await assert.rejects(requestChatProvider({}, false), /HTTPS/)
  assert.equal(calls, 1)
})
