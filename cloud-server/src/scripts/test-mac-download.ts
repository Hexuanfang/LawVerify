import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { stat } from 'node:fs/promises'
import { createApp } from '../app.js'
import { listPublicReleases, resolveReleaseDownloadAsset } from '../release-service.js'

const index = process.argv.indexOf('--base')
const externalBase = index >= 0 ? process.argv[index + 1] : undefined
const server = externalBase ? null : createApp().listen(0, '127.0.0.1')
if (server) await once(server, 'listening')
const address = server?.address()
const base = externalBase ?? `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
const full = process.argv.includes('--full')
const resume = process.argv.includes('--resume')
const archIndex = process.argv.indexOf('--arch')
const selectedArch = archIndex >= 0 ? process.argv[archIndex + 1] : undefined
assert.ok(!selectedArch || ['arm64', 'x64'].includes(selectedArch), 'Invalid architecture')

async function get(url: string, init: RequestInit = {}, timeout = 30_000) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeout) })
}

try {
  const local = (await listPublicReleases()).filter((item) => item.platform === 'darwin' && item.channel === 'test')
  assert.equal(local.length, 2, 'Two real Mac test packages are required')
  const metadata = await get(`${base}/api/web/releases`)
  assert.equal(metadata.status, 200)
  const payload = await metadata.json() as { data: { items: typeof local } }
  for (const release of local.filter((item) => !selectedArch || item.arch === selectedArch)) {
    const published = payload.data.items.find((item) => item.id === release.id)
    assert.equal(published?.sha256, release.sha256)
    assert.equal(published?.channel, 'test')
    const latest = await get(`${base}/api/web/releases/latest?platform=darwin&arch=${release.arch}`)
    assert.equal(latest.status, 200)
    const update = await latest.json() as { data: { channel: string } | null }
    assert.ok(!update.data || update.data.channel === 'stable', 'Test packages must not become stable updates')
    const asset = await resolveReleaseDownloadAsset(release.id)
    const size = (await stat(asset.filePath)).size
    const url = externalBase ? release.downloadUrl : `${base}/api/web/releases/${release.id}/download`
    const head = await get(url, { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal(Number(head.headers.get('content-length')), size)
    assert.equal(head.headers.get('accept-ranges'), 'bytes')
    const checksum = await get(`${base}/api/web/releases/${release.id}/checksum`)
    assert.equal(checksum.status, 200)
    assert.equal(await checksum.text(), `${release.sha256}  ${asset.fileName}\n`)
    const range = await get(url, { headers: { Range: 'bytes=0-1023' } })
    assert.equal(range.status, 206)
    assert.equal((await range.arrayBuffer()).byteLength, 1024)
    if (full) {
      const hash = createHash('sha256')
      let received = 0
      if (resume) {
        const etag = head.headers.get('etag')
        assert.ok(etag, 'Safe continuation requires an ETag')
        while (received < size) {
          const end = Math.min(received + 8 * 1024 * 1024, size) - 1
          for (let attempt = 1; ; attempt++) {
            try {
              const response = await get(url, { headers: {
                Range: `bytes=${received}-${end}`, 'If-Range': etag,
              } }, 120_000)
              assert.equal(response.status, 206)
              assert.equal(response.headers.get('content-range'), `bytes ${received}-${end}/${size}`)
              const bytes = Buffer.from(await response.arrayBuffer())
              assert.equal(bytes.length, end - received + 1)
              hash.update(bytes)
              received += bytes.length
              console.log(`DOWNLOAD ${release.arch} ${Math.round(received / size * 100)}%`)
              break
            } catch (error) {
              if (attempt >= 3 || error instanceof assert.AssertionError) throw error
              console.log(`RETRY ${release.arch} at byte ${received}`)
            }
          }
        }
      } else {
        const response = await get(url, {}, 600_000)
        assert.equal(response.status, 200)
        assert.ok(response.body)
        for await (const chunk of response.body) { hash.update(chunk); received += chunk.length }
      }
      assert.equal(received, size)
      assert.equal(hash.digest('hex'), release.sha256)
    }
    console.log(`PASS ${release.arch}: metadata, stable isolation, HEAD, Range, SHA256${full ? ', full download' : ''}${resume ? ' with safe continuation' : ''}`)
  }
} finally {
  server?.closeAllConnections()
  server?.close()
}
