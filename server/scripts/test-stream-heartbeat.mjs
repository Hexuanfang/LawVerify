import assert from 'node:assert/strict'
import { test } from 'node:test'
import express from 'express'
import { streamHeartbeat } from '../src/app.ts'

async function listen(app) {
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  return { server, port: server.address().port }
}

test('普通响应不会被写入心跳', async (t) => {
  const app = express()
  app.use(streamHeartbeat(30))
  app.get('/plain', (_request, response) => { response.json({ ok: true }) })
  const { server, port } = await listen(app)
  t.after(() => server.close())
  const response = await fetch(`http://127.0.0.1:${port}/plain`)
  const text = await response.text()
  assert.equal(text, '{"ok":true}')
})

test('流式响应空闲时收到心跳注释', async (t) => {
  const app = express()
  app.use(streamHeartbeat(30))
  app.get('/stream', (_request, response) => {
    response.setHeader('Content-Type', 'text/event-stream')
    response.write('data: start\n\n')
  })
  const { server, port } = await listen(app)
  t.after(() => server.close())
  const controller = new AbortController()
  const response = await fetch(`http://127.0.0.1:${port}/stream`, { signal: controller.signal })
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  const deadline = Date.now() + 5000
  while (Date.now() < deadline && !text.includes(': heartbeat')) {
    const { value, done } = await reader.read()
    if (done) break
    text += decoder.decode(value, { stream: true })
  }
  controller.abort()
  assert.ok(text.includes('data: start'), '原始数据应当先送达')
  assert.ok(text.includes(': heartbeat'), '空闲时应当收到心跳注释')
})