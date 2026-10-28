const { app, session } = require('electron')
const assert = require('node:assert/strict')
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createAccountRequestHandler } = require('./account-network.cjs')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'lawverify-account-proxy-'))
app.setPath('userData', temporary)
app.disableHardwareAcceleration()

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return server.address().port
}
let proxy, local
app.whenReady().then(async () => {
  const calls = []
  proxy = http.createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    calls.push({ url: request.url, body, authorization: request.headers.authorization })
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"success":true,"data":{"token":"isolated-test-token"}}')
  })
  local = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"local":true}')
  })
  try {
    const proxyPort = await listen(proxy)
    const localPort = await listen(local)
    await session.defaultSession.setProxy({ mode: 'direct' })
    const accountSession = session.fromPartition('isolated-account-test')
    await accountSession.setProxy({ mode: 'fixed_servers', proxyRules: `127.0.0.1:${proxyPort}`, proxyBypassRules: '<-loopback>' })
    const target = 'http://lawverify-account-test.invalid'
    // This host intentionally has no DNS entry; it is reachable only via the proxy.
    await assert.rejects(fetch(`${target}/api/account/login`, { signal: AbortSignal.timeout(3000) }))
    const handler = createAccountRequestHandler({
      fetch: (url, init) => accountSession.fetch(url, init), baseUrl: target, isTrustedSender: () => true,
    })
    const body = '{"email":"fixture@example.test","password":"isolated-test-password"}'
    const result = await handler({}, { path: '/api/account/login', method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer isolated-test-token' }, body })
    assert.equal(result.status, 200)
    assert.equal(JSON.parse(result.body).data.token, 'isolated-test-token')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, `${target}/api/account/login`)
    assert.equal(calls[0].body, body)
    assert.equal(calls[0].authorization, 'Bearer isolated-test-token')
    const localResponse = await session.defaultSession.fetch(`http://127.0.0.1:${localPort}/api/health`)
    assert.equal((await localResponse.json()).local, true)
    assert.equal(calls.length, 1, 'Local material requests must not enter the cloud proxy')
    await new Promise(resolve => proxy.close(resolve))
    const unavailable = await handler({}, { path: '/api/account/login', method: 'POST', headers: {}, body })
    assert.equal(unavailable.status, 0)
    assert.equal(calls.length, 1, 'Never retry a failed login automatically')
    console.log('Electron account networking: proxy-only login, preserved JSON/Bearer, direct localhost, bounded failure and no mutation retries passed')
    app.exit(0)
  } catch (error) {
    console.error(error.stack)
    app.exit(1)
  } finally {
    proxy?.closeAllConnections()
    proxy?.close()
    local?.closeAllConnections()
    local?.close()
  }
})
app.on('will-quit', () => {
  try { fs.rmSync(temporary, { recursive: true, force: true }) } catch {}
})
