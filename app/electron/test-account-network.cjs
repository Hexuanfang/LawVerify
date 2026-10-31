const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createAccountRequestHandler, ACCOUNT_BASE_URL } = require('./account-network.cjs')
const trusted = { sender: 'trusted' }
const login = { path: '/api/account/login', method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: '{"email":"fixture@example.test","password":"fixture-password"}' }
const handler = (fetch, report) => createAccountRequestHandler({ fetch, report, isTrustedSender: e => e === trusted })

test('账户请求固定到官网，通过原生网络发送 JSON 和 Authorization', async () => {
  let sent
  const request = handler(async (url, init) => {
    sent = { url, init }
    return new Response('{"success":true,"data":{"token":"fixture-token"}}')
  })
  const result = await request(trusted, { ...login, headers: { ...login.headers, authorization: 'Bearer fixture-token', cookie: 'must-not-send', host: 'evil.example' } })
  assert.equal(result.status, 200)
  assert.equal(sent.url, `${ACCOUNT_BASE_URL}/api/account/login`)
  assert.equal(sent.init.body, login.body)
  assert.equal(sent.init.headers.get('authorization'), 'Bearer fixture-token')
  assert.equal(sent.init.headers.get('cookie'), null)
  assert.equal(sent.init.headers.get('host'), null)
  assert.equal(sent.init.credentials, 'omit')
  assert.equal(sent.init.redirect, 'error')
  assert.ok(sent.init.signal instanceof AbortSignal)
})

test('凭据错误与服务故障保留各自状态，不伪装成网络失败', async () => {
  for (const status of [401, 403, 429, 503]) {
    const request = handler(async () => new Response('{"success":false,"error":{"code":"fixture-error"}}', { status }))
    assert.equal((await request(trusted, login)).status, status)
  }
})

test('拒绝外部页面、任意目标、管理接口、路径绕过及过大请求', async () => {
  const request = handler(() => { throw new Error('Validation must happen before networking') })
  await assert.rejects(request({}, login), /Untrusted/)
  for (const path of ['https://evil.example/api/account/login', '//evil.example/api/account/login', '/api/admin/users',
    '/api/account/../../admin/users', '/api/account\\login', '/api/account/login#fragment']) {
    await assert.rejects(request(trusted, { ...login, path }))
  }
  await assert.rejects(request(trusted, { ...login, body: 'x'.repeat(2 * 1024 * 1024 + 1) }), /limit/)
})

test('网络故障不重试登录或订单，诊断不记录密码、令牌和响应正文', async () => {
  let calls = 0
  const logs = []
  const request = handler(async () => {
    calls++
    throw Object.assign(new Error('secret-password'), { cause: { code: 'ENOTFOUND', message: 'secret-token' } })
  }, (event, details) => logs.push({ event, ...details }))
  const result = await request(trusted, login)
  assert.equal(calls, 1)
  assert.equal(result.status, 0)
  assert.equal(result.code, 'ENOTFOUND')
  assert.ok(!JSON.stringify(logs).includes('secret'))
  assert.ok(!JSON.stringify(logs).includes('fixture-password'))
})

test('响应大小受限，并发请求超过上限时即时返回 429', async () => {
  const large = handler(async () => new Response('x'.repeat(4 * 1024 * 1024 + 1)))
  assert.equal((await large(trusted, login)).code, 'ACCOUNT_RESPONSE_TOO_LARGE')
  let finish
  const gate = new Promise(resolve => { finish = resolve })
  const request = handler(async () => { await gate; return new Response('{}') })
  const pending = Array.from({ length: 8 }, () => request(trusted, login))
  assert.equal((await request(trusted, login)).status, 429)
  finish()
  assert.ok((await Promise.all(pending)).every(r => r.status === 200))
})
