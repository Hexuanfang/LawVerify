import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import jwt from 'jsonwebtoken'
import { Pool } from 'pg'
import { config } from '../config.js'
import { createApp } from '../app.js'
import { runMigrations } from '../infrastructure/migrations.js'
import { getPool, query } from '../infrastructure/postgres.js'
import { registerAccount } from '../commercial/auth-service.js'
import { reconcileAiRequests } from '../ai-request-store.js'

if (!config.DATABASE_URL) throw new Error('Gateway integration test requires PostgreSQL.')
const administrative = new Pool({ connectionString: config.DATABASE_URL })
const schema = `ai_test_${randomUUID().replace(/-/g, '')}`
const databaseUrl = new URL(config.DATABASE_URL)
databaseUrl.searchParams.set('options', `-c search_path=${schema},public`)
config.DATABASE_URL = databaseUrl.toString()
const originalFetch = globalThis.fetch
let failed = false
let upstreamCalls = 0
Object.assign(config, {
  AI_GATEWAY_ENABLED: true,
  LLM_BASE_URL: 'https://model.test.invalid/v1', LLM_API_KEY: 'test-secret', LLM_MODEL: 'test-model',
  EMBEDDING_BASE_URL: 'https://model.test.invalid/v1', EMBEDDING_API_KEY: 'test-secret', EMBEDDING_MODEL: 'test-embedding',
  YUANDIAN_MCP_URL: 'https://model.test.invalid/mcp', YUANDIAN_API_KEY: 'test-secret',
})
globalThis.fetch = async (input, init) => {
  if (!String(input).startsWith('https://model.test.invalid')) return originalFetch(input, init)
  upstreamCalls += 1
  const headers = new Headers(init?.headers)
  assert.equal(headers.get('authorization'), 'Bearer test-secret')
  if (String(input).endsWith('/audio/transcriptions')) {
    assert.ok(init?.body instanceof FormData)
    assert.equal(init.body.get('model'), 'test-speech')
    return Response.json({ text: '我代理被告。' })
  }
  const body = JSON.parse(String(init?.body))
  if (failed) return new Response('upstream failed', { status: 503 })
  if (String(input).endsWith('/mcp')) return new Response('{"jsonrpc":"2.0","id":1,"result":{}}',
    { headers: { 'content-type': 'not-a-media-type' } })
  if (String(input).endsWith('/embeddings')) return Response.json({
    data: body.input.map((_: string, index: number) => ({ index, embedding: Array(1024).fill(0.1) })),
  })
  if (body.stream) return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\r\n\r\ndata: [DONE]\r\n\r\n',
    { headers: { 'content-type': 'text/event-stream' } })
  assert.ok(['test-model', 'approved-model'].includes(body.model), 'only approved models reach provider')
  return Response.json({ choices: [{ message: { content: 'ok' } }] })
}
let server: ReturnType<ReturnType<typeof createApp>['listen']> | undefined
try {
  await administrative.query(`CREATE SCHEMA ${schema}`)
  await runMigrations()
  const session = await registerAccount({
    email: `gateway-${randomUUID()}@test.invalid`, password: 'test-password-123',
    ownerName: '测试律师', organizationName: '测试机构',
  })
  await query('UPDATE point_accounts SET balance_points=100 WHERE user_id=$1', [session.user.id])
  const app = createApp()
  server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server!.once('listening', resolve))
  const port = (server.address() as { port: number }).port
  const accountRequest = (path: string, token: string, body?: unknown) => originalFetch(
    `http://127.0.0.1:${port}/api/account/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  const login = async () => {
    const response = await accountRequest('login', '', { email: session.user.email, password: 'test-password-123' })
    assert.equal(response.status, 200)
    return (await response.json() as { data: { token: string } }).data.token
  }
  const webToken = await login()
  const desktopToken = await login()
  for (const token of [session.token, webToken, desktopToken]) {
    assert.equal((await accountRequest('profile', token)).status, 200, 'new login must not evict existing sessions')
  }
  const webBalance = await (await accountRequest('me', webToken)).json() as { data: { pointsBalance: number } }
  const desktopBalance = await (await accountRequest('me', desktopToken)).json() as { data: { pointsBalance: number } }
  assert.equal(webBalance.data.pointsBalance, desktopBalance.data.pointsBalance)
  assert.equal((await accountRequest('logout', webToken, {})).status, 200)
  assert.equal((await accountRequest('profile', webToken)).status, 401, 'logout revokes only the supplied session')
  assert.equal((await accountRequest('profile', desktopToken)).status, 200)
  const expiringToken = await login()
  const claims = jwt.decode(expiringToken) as { sessionId: string }
  await query("UPDATE account_sessions SET expires_at=NOW()-INTERVAL '1 second' WHERE id=$1", [claims.sessionId])
  assert.equal((await accountRequest('profile', expiringToken)).status, 401)
  const unregisteredToken = jwt.sign({
    ...jwt.decode(desktopToken) as Record<string, unknown>, sessionId: randomUUID(),
  }, config.JWT_SECRET)
  assert.equal((await accountRequest('profile', unregisteredToken)).status, 401)
  console.log('PASS: web/desktop simultaneous login, shared balance, independent logout, expiry and unknown-session rejection')
  const request = (path: string, payload: unknown, token = session.token, id = randomUUID()) => originalFetch(
    `http://127.0.0.1:${port}/api/ai/${path}`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'x-ai-request-id': id, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  const chat = { messages: [{ role: 'user', content: 'test' }] }
  assert.equal((await request('chat/completions', chat, '')).status, 401)
  const beforeRejected = upstreamCalls
  assert.equal((await request('chat/completions', { ...chat, model: 'attacker-model' })).status, 400)
  assert.equal(upstreamCalls, beforeRejected, 'unapproved models must not reach provider')
  config.LLM_CHAT_MODELS = 'approved-model'
  assert.equal((await request('chat/completions', { ...chat, model: 'approved-model' })).status, 200)
  const capabilitiesUrl = `http://127.0.0.1:${port}/api/ai/assistant/capabilities`
  const capabilities = await originalFetch(capabilitiesUrl, { headers: { Authorization: `Bearer ${session.token}` } })
  assert.deepEqual((await capabilities.json() as { models: Array<{ id: string }> }).models.map(m => m.id), ['test-model', 'approved-model'])
  Object.assign(config, { ASR_BASE_URL: 'https://model.test.invalid/v1', ASR_API_KEY: 'test-secret', ASR_MODEL: 'test-speech' })
  const speech = await originalFetch(`http://127.0.0.1:${port}/api/ai/audio/transcriptions`, {
    method: 'POST', headers: { Authorization: `Bearer ${session.token}`, 'x-ai-request-id': randomUUID(), 'Content-Type': 'audio/webm' },
    body: Buffer.from('test-audio'),
  })
  assert.equal(speech.status, 200, await speech.clone().text())
  assert.deepEqual(await speech.json(), { text: '我代理被告。' })
  const id = randomUUID()
  const ok = await request('chat/completions', chat, session.token, id)
  assert.equal(ok.status, 200, await ok.clone().text())
  assert.match(await ok.text(), /ok/)
  const previous = upstreamCalls
  assert.equal((await request('chat/completions', chat, session.token, id)).status, 409)
  assert.equal(upstreamCalls, previous, 'duplicate request must not invoke provider')
  const stream = await request('chat/completions', { ...chat, stream: true })
  assert.match(await stream.text(), /\[DONE\]/)
  const embedding = await request('embeddings', { input: ['test'] })
  assert.equal((await embedding.json() as { data: Array<{ embedding: number[] }> }).data[0].embedding.length, 1024)
  const mcp = await request('mcp/yuandian', { jsonrpc: '2.0', id: 1, method: 'tools/list' })
  assert.equal(mcp.status, 200)
  assert.match(mcp.headers.get('content-type')!, /application\/json/)
  assert.deepEqual((await mcp.json() as { result: unknown }).result, {})
  assert.equal((await request('chat/completions', { messages: [{ role: 'user', content: [
    { type: 'image_url', image_url: { url: 'http://127.0.0.1/private' } },
  ] }] })).status >= 400, true)
  failed = true
  assert.equal((await request('chat/completions', chat)).status, 502)
  const refunds = await query<{ count: string }>("SELECT count(*) FROM point_ledger_entries WHERE entry_type='refund'")
  assert.equal(Number(refunds.rows[0].count), 1)
  failed = false
  await query('UPDATE point_accounts SET balance_points=0 WHERE user_id=$1', [session.user.id])
  const beforeDenied = upstreamCalls
  assert.equal((await request('chat/completions', chat)).status, 400)
  assert.equal(upstreamCalls, beforeDenied)
  await reconcileAiRequests()
  const stale = await query<{ count: string }>("SELECT count(*) FROM ai_gateway_requests WHERE status='refund_pending'")
  assert.equal(Number(stale.rows[0].count), 0)
  console.log('PASS: PostgreSQL-isolated gateway auth, billing, duplicate rejection, stream, embeddings, URL validation and refund recovery')
} finally {
  globalThis.fetch = originalFetch
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()))
  await getPool().end()
  await administrative.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
  await administrative.end()
}
