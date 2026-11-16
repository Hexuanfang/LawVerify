import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { env } from '../src/config/env.ts'

const directory = mkdtempSync(path.resolve(import.meta.dirname, '../../tmp/retired-office-'))
env.WORKSPACE_DATA_DIR = path.join(directory, 'data')
env.STORAGE_LOCAL_ROOT = path.join(directory, 'storage')
env.FRONTEND_DIST_DIR = path.join(directory, 'frontend')
env.KNOWLEDGE_RAG_MODE = 'local'
const { createApp, closeParsingWorkers } = await import('../src/app.ts')

test('文书服务独立启动，已退役的 Office 接口返回 404', async (t) => {
  const { app } = createApp()
  const server = app.listen(0, '127.0.0.1')
  t.after(async () => {
    await closeParsingWorkers()
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  })
  await new Promise(resolve => server.once('listening', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const request = (url, method = 'GET') => fetch(`${base}${url}`, {
    method,
    signal: AbortSignal.timeout(5000),
  })

  assert.equal((await request('/api/v1/system/health')).status, 200)
  for (const [url, method] of [
    ['/api/v1/integrations/collabora/status', 'GET'],
    ['/api/v1/integrations/collabora/certificates/test/session', 'POST'],
    ['/api/v1/wopi/files/certificate-test', 'GET'],
    ['/api/v1/wopi/files/certificate-test/contents', 'GET'],
    ['/api/v1/wopi/files/certificate-test/contents', 'POST'],
  ]) {
    const response = await request(url, method)
    assert.equal(response.status, 404, `${method} ${url}`)
    assert.match(response.headers.get('content-type'), /application\/json/)
  }
  const response = await request('/api/v1/system/readiness')
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.data.capabilities.workspace, true)
  assert.equal(Object.hasOwn(body.data.capabilities, 'collabora'), false)
})
