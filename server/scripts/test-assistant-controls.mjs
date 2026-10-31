import assert from 'node:assert/strict'
import { test } from 'node:test'
import { env } from '../src/config/env.ts'
import { assistantOptionsSchema, assistantInstructions } from '../src/intelligence/assistant-options.ts'
import { createChatCompletion, getAssistantCapabilities, transcribeAssistantAudio, withAssistantModel } from '../src/integrations/llm-service.ts'

test('assistant model catalog, request isolation, skill rules and transcription', async t => {
  const original = { ...env }
  const originalFetch = globalThis.fetch
  t.after(() => { Object.assign(env, original); globalThis.fetch = originalFetch })
  Object.assign(env, { AI_GATEWAY_MODE: 'direct', LLM_BASE_URL: 'https://test.invalid/v1',
    LLM_API_KEY: 'test-key', LLM_MODEL: 'default', LLM_CHAT_MODELS: ' alternate,default,alternate ',
    ASR_BASE_URL: undefined, ASR_API_KEY: undefined, ASR_MODEL: undefined })
  assert.deepEqual((await getAssistantCapabilities()).models.map(m => m.id), ['default', 'alternate'])
  assert.equal((await getAssistantCapabilities()).voice, false)
  await assert.rejects(transcribeAssistantAudio(Buffer.from('test'), 'audio/webm'), /尚未启用/)
  assert.throws(() => assistantOptionsSchema.parse({ agent: 'unknown' }))
  assert.throws(() => assistantOptionsSchema.parse({ skill: 'unknown' }))
  assert.match(assistantInstructions({ agent: 'evidence', skill: 'evidence_gaps' }), /证明目的/)
  assert.match(assistantInstructions({ agent: 'strategy', skill: 'timeline' }), /缺失时间不得推定/)
  const chatBodies = []
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/audio/transcriptions')) {
      assert.ok(init.body instanceof FormData)
      assert.equal(init.body.get('model'), 'speech-model')
      assert.equal(init.body.get('language'), 'zh')
      assert.equal(init.body.get('file').type, 'audio/webm')
      return Response.json({ text: '  我代理被告。  ' })
    }
    const body = JSON.parse(init.body)
    chatBodies.push(body)
    return Response.json({ choices: [{ message: { content: 'ok' } }] })
  }
  const chat = () => createChatCompletion({ messages: [{ role: 'user', content: 'test' }] })
  await assert.rejects(withAssistantModel('unapproved', chat), /不可用/)
  assert.equal(chatBodies.length, 0)
  await Promise.all([withAssistantModel('alternate', chat), chat()])
  assert.deepEqual(chatBodies.map(b => b.model).sort(), ['alternate', 'default'])
  await chat()
  assert.equal(chatBodies.at(-1).model, 'default', 'request-scoped model must not leak')
  Object.assign(env, { ASR_BASE_URL: 'https://test.invalid/v1', ASR_API_KEY: 'speech-key', ASR_MODEL: 'speech-model' })
  assert.equal((await getAssistantCapabilities()).voice, true)
  assert.deepEqual(await transcribeAssistantAudio(Buffer.from('test'), 'audio/webm'), { text: '我代理被告。' })
  const { createApp } = await import('../src/app.ts')
  const { app } = createApp()
  const server = app.listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}/api/assistant`
  const capabilities = await originalFetch(`${base}/capabilities`)
  assert.equal(capabilities.status, 200)
  assert.equal((await capabilities.json()).voice, true)
  const form = new FormData()
  form.set('file', new Blob(['recorded-audio'], { type: 'audio/webm' }), 'speech.webm')
  const speech = await originalFetch(`${base}/transcriptions`, { method: 'POST', body: form })
  assert.equal(speech.status, 200, await speech.clone().text())
  assert.deepEqual(await speech.json(), { text: '我代理被告。' })
  const invalid = new FormData()
  invalid.set('file', new Blob(['not audio'], { type: 'text/plain' }), 'file.txt')
  assert.equal((await originalFetch(`${base}/transcriptions`, { method: 'POST', body: invalid })).status, 400)
  globalThis.fetch = async () => Response.json({ text: ' ' })
  await assert.rejects(transcribeAssistantAudio(Buffer.from('test'), 'audio/webm'), /未识别到语音/)
})
