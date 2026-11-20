import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createServer, request as httpRequest } from 'node:http'
import { setTimeout } from 'node:timers/promises'
import { createParserServer } from '../../python-workers/http-service.mjs'
import { generateKeyPairSync, sign } from 'node:crypto'
import { createParserAuthenticator } from '../../python-workers/parser-auth.mjs'
import { createParserTestClient } from './parser-test-client.mjs'

test('远程测试客户端为每份材料获取短时凭证并上传原件', async t => {
  const calls = []
  let issued = 0
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://parser')
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    calls.push([request.method, url.pathname, url.searchParams.get('fileName'), request.headers.authorization, Buffer.concat(chunks).toString()])
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify(url.pathname.endsWith('/parser-ticket')
      ? { data: { token: `ticket${++issued}.signature` } }
      : { text: 'parsed' }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  const base = `http://127.0.0.1:${server.address().port}`
  const client = createParserTestClient({ PARSER_SERVICE_URL: `${base}/office/`, CLOUD_API_BASE_URL: base, PARSER_TEST_SESSION_TOKEN: 'test-session' })
  for (const name of ['合成.txt', 'second.txt']) {
    const result = await client.request(name, 'synthetic text')
    assert.equal(result.status, 200)
    assert.deepEqual(await result.json(), { text: 'parsed' })
  }
  assert.deepEqual(calls, [
    ['POST', '/api/account/parser-ticket', null, 'Bearer test-session', ''],
    ['POST', '/office/parse', '合成.txt', 'Bearer ticket1.signature', 'synthetic text'],
    ['POST', '/api/account/parser-ticket', null, 'Bearer test-session', ''],
    ['POST', '/office/parse', 'second.txt', 'Bearer ticket2.signature', 'synthetic text'],
  ])
})

test('解析 HTTP 服务鉴权、流式上传、大小限制及失败清理', async t => {
  const root = await mkdtemp(path.resolve(import.meta.dirname, '../../tmp/parser-http-'))
  const calls = []
  const pool = { async run(input) {
    calls.push(input)
    const text = await readFile(input.inputPath, 'utf8')
    if (text === 'bad') throw Object.assign(new Error('私有路径 /private/source'), { code: 'PARSE_FAILED' })
    await writeFile(input.outputPath, JSON.stringify({ schemaVersion: 1, text, blocks: [], warnings: [], pages: 0 }))
  } }
  const server = createParserServer({ pool, root, token: 'test-token', maxBytes: 16, maxPending: 1 })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  const base = `http://127.0.0.1:${server.address().port}`
  const send = (body, token = 'test-token', query = 'fileName=example.txt') => fetch(`${base}/parse?${query}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' }, body,
  })
  assert.equal((await fetch(`${base}/health`)).status, 200)
  assert.equal((await send('hello', 'invalid')).status, 401)
  assert.equal(calls.length, 0)
  assert.equal((await send('hello', 'test-token', 'fileName=../../x.txt')).status, 400)
  const ok = await send('hello')
  assert.equal(ok.status, 200)
  assert.equal((await ok.json()).text, 'hello')
  assert.equal((await send('x'.repeat(17))).status, 413)
  const failed = await send('bad')
  assert.equal(failed.status, 422)
  assert.doesNotMatch(await failed.text(), /private/)
  assert.equal((await send('again')).status, 200)
  assert.deepEqual(await readdir(root), [])
})

test('签名模式只接收正确用途和有效期的账号凭证', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const authenticate = createParserAuthenticator({ token: 'old-token', publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') })
  const now = Math.floor(Date.now() / 1000)
  const ticket = overrides => {
    const payload = Buffer.from(JSON.stringify({ v: 1, aud: 'lawverify:parse', sub: 'u1', org: 'o1', iat: now, exp: now + 120, ...overrides })).toString('base64url')
    return `Bearer ${payload}.${sign(null, Buffer.from(payload), privateKey).toString('base64url')}`
  }
  assert.deepEqual(authenticate(ticket()), { userId: 'u1', organizationId: 'o1' })
  for (const invalid of [ticket({ aud: 'elsewhere' }), ticket({ iat: now - 120, exp: now - 1 }),
    ticket({ exp: now + 121 }), ticket({ iat: now + 30 }), 'Bearer old-token']) assert.equal(authenticate(invalid), null)
})

test('过载请求快速拒绝，上传断连后清理临时目录并继续服务', async t => {
  const root = await mkdtemp(path.resolve(import.meta.dirname, '../../tmp/parser-http-interrupt-'))
  let release
  const gate = new Promise(resolve => { release = resolve })
  const pool = { async run(input) {
    await gate
    await writeFile(input.outputPath, '{}')
  } }
  const server = createParserServer({ pool, root, token: 'test-token', maxPending: 1, timeoutMs: 2000 })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  const base = `http://127.0.0.1:${server.address().port}`
  const send = () => fetch(`${base}/parse?fileName=x.txt`, { method: 'POST', headers: { Authorization: 'Bearer test-token' }, body: 'x' })
  const pending = send()
  for (let i = 0; i < 100 && (await readdir(root)).length === 0; i++) await setTimeout(10)
  assert.equal((await send()).status, 429)
  release()
  assert.equal((await pending).status, 200)
  const interrupted = httpRequest(`${base}/parse?fileName=x.txt`, {
    method: 'POST', headers: { Authorization: 'Bearer test-token', 'Content-Length': '100' },
  })
  interrupted.on('error', () => {})
  interrupted.write('x')
  for (let i = 0; i < 100 && (await readdir(root)).length === 0; i++) await setTimeout(10)
  interrupted.destroy()
  for (let i = 0; i < 100 && (await readdir(root)).length; i++) await setTimeout(10)
  assert.deepEqual(await readdir(root), [])
  assert.equal((await send()).status, 200)
})
