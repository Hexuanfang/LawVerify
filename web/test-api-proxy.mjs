import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer, request } from 'node:http'
import { gzipSync } from 'node:zlib'
import test from 'node:test'
import { proxyApiRequest } from './api-proxy.mjs'

async function listen(server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return `http://127.0.0.1:${server.address().port}`
}

async function setup(t, handler, timeout) {
  const origin = createServer(handler)
  const base = await listen(origin)
  const proxy = createServer((req, res) => proxyApiRequest(req, res, base, timeout))
  const url = await listen(proxy)
  t.after(() => {
    origin.closeAllConnections()
    proxy.closeAllConnections()
    origin.close()
    proxy.close()
  })
  return url
}

function receive(url, options = {}, body) {
  return new Promise((resolve, reject) => {
    const req = request(url, options, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('error', reject)
      res.on('end', () => resolve({
        status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks),
      }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

test('streams the first chunk before the origin finishes, retaining file length', async (t) => {
  let finishOrigin
  let originFinished = false
  const url = await setup(t, (_req, res) => {
    res.writeHead(200, { 'Content-Length': '6' })
    res.write('abc')
    finishOrigin = () => { originFinished = true; res.end('def') }
  })
  await new Promise((resolve, reject) => {
    const req = request(url, (res) => {
      assert.equal(res.headers['content-length'], '6')
      const chunks = []
      res.on('data', (chunk) => {
        chunks.push(chunk)
        if (!originFinished) {
          assert.equal(chunk.toString(), 'abc')
          finishOrigin()
        }
      })
      res.on('error', reject)
      res.on('end', () => {
        assert.equal(Buffer.concat(chunks).toString(), 'abcdef')
        resolve()
      })
    })
    req.on('error', reject)
    req.end()
  })
})

test('preserves HEAD, Range, validators, and 416 responses', async (t) => {
  const url = await setup(t, (req, res) => {
    assert.equal(req.headers['if-range'], '"version-1"')
    res.setHeader('Accept-Ranges', 'bytes')
    res.setHeader('ETag', '"version-1"')
    if (req.headers.range === 'bytes=100-') {
      res.writeHead(416, { 'Content-Range': 'bytes */6', 'Content-Length': '0' })
      res.end()
    } else if (req.method === 'HEAD') {
      res.writeHead(200, { 'Content-Length': '6' })
      res.end()
    } else {
      assert.equal(req.headers.range, 'bytes=3-5')
      res.writeHead(206, { 'Content-Range': 'bytes 3-5/6', 'Content-Length': '3' })
      res.end('def')
    }
  })
  const headers = { 'If-Range': '"version-1"' }
  const part = await receive(url, { headers: { ...headers, Range: 'bytes=3-5' } })
  assert.equal(part.status, 206)
  assert.equal(part.headers['content-range'], 'bytes 3-5/6')
  assert.equal(part.headers['content-length'], '3')
  assert.equal(part.body.toString(), 'def')
  const head = await receive(url, { method: 'HEAD', headers })
  assert.equal(head.headers['content-length'], '6')
  assert.equal(head.body.length, 0)
  const invalid = await receive(url, { headers: { ...headers, Range: 'bytes=100-' } })
  assert.equal(invalid.status, 416)
  assert.equal(invalid.headers['content-range'], 'bytes */6')
})

test('preserves encoded bytes and forwards POST bodies and cookies unchanged', async (t) => {
  const body = Buffer.from('{"email":"test@example.com"}')
  const zipped = gzipSync(body)
  const url = await setup(t, async (req, res) => {
    assert.equal(req.method, 'POST')
    assert.equal(Number(req.headers['content-length']), body.length)
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    assert.deepEqual(Buffer.concat(chunks), body)
    res.writeHead(200, {
      'Content-Encoding': 'gzip', 'Content-Length': zipped.length,
      'Set-Cookie': ['session=a; HttpOnly', 'other=b; HttpOnly'],
      Connection: 'keep-alive, x-internal', 'X-Internal': 'private',
    })
    res.end(zipped)
  })
  const result = await receive(url, {
    method: 'POST', headers: { 'Content-Length': body.length, 'Content-Type': 'application/json' },
  }, body)
  assert.deepEqual(result.body, zipped)
  assert.equal(result.headers['content-length'], String(zipped.length))
  assert.equal(result.headers['content-encoding'], 'gzip')
  assert.equal(result.headers['set-cookie'].length, 2)
  assert.equal(result.headers['x-internal'], undefined)
})

test('an origin interruption cannot be reported as a completed download', async (t) => {
  const url = await setup(t, (_req, res) => {
    res.writeHead(200, { 'Content-Length': '100' })
    res.write('partial')
    setImmediate(() => res.destroy())
  })
  await assert.rejects(receive(url))
  const healthy = await setup(t, (_req, res) => res.end('healthy'))
  assert.equal((await receive(healthy)).body.toString(), 'healthy')
})

test('returns 502 when the origin never sends headers', async (t) => {
  const url = await setup(t, () => {}, 50)
  const result = await receive(url)
  assert.equal(result.status, 502)
  assert.equal(result.headers['cache-control'], 'no-store')
})

test('cancels the origin stream when the client cancels its download', async (t) => {
  let originClosed
  const closed = new Promise((resolve) => { originClosed = resolve })
  const url = await setup(t, (_req, res) => {
    res.writeHead(200, { 'Content-Length': '100' })
    res.write('partial')
    res.on('close', originClosed)
  })
  await new Promise((resolve, reject) => {
    const req = request(url, (res) => {
      res.once('data', () => { res.destroy(); resolve() })
      res.on('error', () => {})
    })
    req.on('error', reject)
    req.end()
  })
  await closed
})
