import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { once } from 'node:events'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { createParserResourceRouter } from '../parser-resource-download.ts'

test('解析资源接口支持完整下载、HEAD、Range，只分发固定哈希资源', async () => {
  const root = await mkdtemp(path.resolve(import.meta.dirname, '../../../tmp/parser-resource-http-'))
  const data = Buffer.from('parser-resource-download-fixture')
  const sha256 = createHash('sha256').update(data).digest('hex')
  await writeFile(path.join(root, `${sha256}.tar.gz`), data)
  await writeFile(path.join(root, 'private.json'), 'private')
  const app = express()
  app.use('/api/web/parser-resources', createParserResourceRouter(root))
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}/api/web/parser-resources`
  try {
    const url = `${base}/${sha256}.tar.gz`
    const full = await fetch(url)
    assert.equal(full.status, 200)
    assert.deepEqual(Buffer.from(await full.arrayBuffer()), data)
    assert.match(full.headers.get('cache-control'), /immutable/)
    assert.match(full.headers.get('cache-control'), /no-transform/)
    const head = await fetch(url, { method: 'HEAD' })
    assert.equal(Number(head.headers.get('content-length')), data.length)
    assert.equal((await head.arrayBuffer()).byteLength, 0)
    const range = await fetch(url, { headers: { Range: 'bytes=3-8' } })
    assert.equal(range.status, 206)
    assert.deepEqual(Buffer.from(await range.arrayBuffer()), data.subarray(3, 9))
    assert.equal((await fetch(`${base}/private.json`)).status, 404)
    assert.equal((await fetch(`${base}/${'0'.repeat(64)}.tar.gz`)).status, 404)
    assert.equal((await fetch(`${base}/`)).status, 404)
    assert.equal((await fetch(`${base}/..%5cprivate.json`)).status, 404)
    assert.equal((await fetch(url, { headers: { Range: 'bytes=9999-' } })).status, 416)
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
})
