import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { request } from 'node:http'
import path from 'node:path'
import { setTimeout } from 'node:timers/promises'

const issuer = process.env.PARSER_TEST_ISSUER_URL || 'http://127.0.0.1:8792'
const parser = process.env.PARSER_TEST_SERVICE_URL || 'http://127.0.0.1:8791'
const samples = process.env.PARSER_TEST_SAMPLES
const status = async () => (await fetch(`${parser}/health`)).json()
async function waitPending(count) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await status()).pending === count) return
    await setTimeout(30)
  }
  assert.fail(`在途任务未达到预期的 ${count} 件`)
}

const headers = token => ({ Authorization: `Bearer ${token}` })
const fetchTicket = session => fetch(`${issuer}/api/account/parser-ticket`, {
  method: 'POST', headers: headers(session), signal: AbortSignal.timeout(5000),
})
async function register(label) {
  const response = await fetch(`${issuer}/api/account/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(5000),
    body: JSON.stringify({ email: `${randomUUID()}@example.com`, organizationName: `压测组织 ${label}`, password: randomUUID() }),
  })
  assert.equal(response.status, 200)
  const { data: { token: session } } = await response.json()
  const ticket = await fetchTicket(session)
  assert.equal(ticket.status, 200)
  assert.equal(ticket.headers.get('cache-control'), 'no-store')
  return { session, token: (await ticket.json()).data.token }
}

const target = (name = 'same.txt') => `${parser}/parse?fileName=${name}`
const send = (token, body, name) => fetch(target(name), {
  method: 'POST', headers: headers(token), body, signal: AbortSignal.timeout(45000),
})
function holdUpload(token, bytes) {
  let resolve
  let reject
  const response = new Promise((yes, no) => { resolve = yes; reject = no })
  const req = request(target(), { method: 'POST', headers: { ...headers(token), 'Content-Length': bytes } }, res => {
    res.resume()
    resolve(res.statusCode)
    req.destroy()
  })
  req.once('error', reject)
  response.catch(() => {})
  req.write('x')
  return { response, close: () => req.destroy() }
}

const [a, b] = [await register('A'), await register('B')]
assert.notEqual(a.token, b.token)
const ids = new Set()
async function verifyText(token, text, response = send(token, text)) {
  response = await response
  assert.equal(response.status, 200)
  assert.equal((await response.json()).text, text)
  const id = response.headers.get('x-parser-task-id')
  assert.match(id, /^[0-9a-f-]{36}$/)
  assert.equal(ids.has(id), false)
  ids.add(id)
}

const wrong = await fetchTicket('invalid')
assert.equal(wrong.status, 401)
const [payload, signature] = a.token.split('.')
const claims = JSON.parse(Buffer.from(payload, 'base64url').toString())
const forged = Buffer.from(JSON.stringify({ ...claims, sub: randomUUID() })).toString('base64url')
for (const token of [`${forged}.${signature}`, a.session]) assert.equal((await send(token, 'invalid')).status, 401)

let holds = []
let burstRejected = 0
let burstAccepted = 0
try {
  holds = [holdUpload(a.token, 100), holdUpload(a.token, 100)]
  await waitPending(2)
  const overflow = await send(a.token, 'A 查验限流')
  assert.equal(overflow.status, 429)
  assert.equal(overflow.headers.get('retry-after'), '2')
  assert.equal((await overflow.json()).error.code, 'PARSER_ACCOUNT_LIMIT')
  await verifyText(b.token, 'B 仍可处理')
  holds.forEach(item => item.close())
  await waitPending(0)

  holds = [holdUpload(a.token, 700000)]
  await waitPending(1)
  const accountBytes = await send(a.token, Buffer.alloc(400000, 65))
  assert.equal(accountBytes.status, 429)
  assert.equal((await accountBytes.json()).error.code, 'PARSER_ACCOUNT_UPLOAD_LIMIT')
  const byteLimit = await send(b.token, Buffer.alloc(400000, 65))
  assert.equal(byteLimit.status, 429)
  assert.equal((await byteLimit.json()).error.code, 'PARSER_UPLOAD_LIMIT')
  holds[0].close()
  await waitPending(0)
  await verifyText(a.token, 'A 断连后恢复')

  for (let wave = 0; wave < 10; wave++) {
    await Promise.all([['A', a], ['B', b]].flatMap(([label, account]) => [0, 1].map(i =>
      verifyText(account.token, `组织 ${label} · 第 ${wave + 1} 批 · 材料 ${i + 1}`))))
  }
  await waitPending(0)
  holds = [holdUpload(a.token, 100), holdUpload(b.token, 100)]
  await waitPending(2)
  const burst = Array.from({ length: 32 }, (_, i) => {
    const token = i % 2 ? a.token : b.token
    const text = `并发峰值 ${i}`
    return send(token, text).then(async response => {
      if (response.status === 429) {
        assert.equal((await response.json()).error.code, 'PARSER_ACCOUNT_LIMIT')
        burstRejected++
      } else {
        await verifyText(token, text, response)
        burstAccepted++
      }
    })
  })
  await Promise.all(burst)
  assert.equal(burstAccepted + burstRejected, 32)
  assert.ok(burstAccepted >= 2 && burstRejected > 0)
  holds.forEach(item => item.close())
  await waitPending(0)
  if (samples) {
    const [native, mixed] = await Promise.all(['text.pdf', 'mixed.pdf'].map(file => readFile(path.join(samples, file))))
    const results = await Promise.all([[a.token, native], [b.token, mixed]].map(async ([token, input]) => {
      const response = await send(token, input, 'same.pdf')
      assert.equal(response.status, 200)
      return response.json()
    }))
    assert.deepEqual(results.map(item => item.pages), [1, 3])
    assert.ok(results.every(item => item.text.includes('123456.78')))
  }
  holds = [holdUpload(a.token, 100)]
  await waitPending(1)
  assert.equal(await holds[0].response, 504)
  await waitPending(0)
  await verifyText(b.token, 'B 超时后恢复')
} finally {
  holds.forEach(item => item.close())
}
await waitPending(0)
const logout = await fetch(`${issuer}/api/account/logout`, { method: 'POST', headers: headers(a.session) })
assert.equal(logout.status, 200)
assert.equal((await fetchTicket(a.session)).status, 401)
console.log(JSON.stringify({ sameNameTextMatched: ids.size, sameNamePdfsMatched: samples ? 2 : 0,
  burstAccepted, burstRejected,
  rejectedTamperedAndSession: true, account429: true, bytes429: true, uploadAbortRecovered: true,
  upload504Recovered: true, revokedSession401: true, pending: 0 }))
