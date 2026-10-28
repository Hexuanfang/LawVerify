import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createApp } from '../app.js'
import { config } from '../config.js'
import { getReleaseSha256 } from '../release-checksum.js'
import { buildReleaseDownloadUrl, getLatestPublicRelease, resolveReleaseDownloadAsset } from '../release-service.js'

const baseIndex = process.argv.indexOf('--base')
const explicitBase = baseIndex >= 0 ? process.argv[baseIndex + 1] : undefined
const server = explicitBase ? null : createApp().listen(0, '127.0.0.1')
if (server) await once(server, 'listening')
const address = server?.address()
const base = explicitBase || `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
const resumeOnly = process.argv.includes('--resume-only')

async function get(url: string, options: RequestInit = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(600_000) })
}

async function consume(response: Response, hash: ReturnType<typeof createHash>) {
  assert.ok(response.body)
  let size = 0
  for await (const chunk of response.body) {
    hash.update(chunk)
    size += chunk.length
  }
  return size
}

try {
  const temporary = await mkdtemp(path.join(tmpdir(), 'lawverify-checksum-'))
  try {
    const file = path.join(temporary, 'sample.exe')
    await writeFile(file, 'first')
    const first = await getReleaseSha256(file)
    assert.equal(first, createHash('sha256').update('first').digest('hex'))
    assert.deepEqual(await Promise.all([getReleaseSha256(file), getReleaseSha256(file)]), [first, first])
    await writeFile(file, 'other')
    const future = new Date(Date.now() + 2000)
    await utimes(file, future, future)
    assert.equal(await getReleaseSha256(file), createHash('sha256').update('other').digest('hex'))
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
  console.log('PASS checksum cache and same-size file invalidation')

  const latest = await getLatestPublicRelease()
  assert.ok(latest, 'A real installer is required')
  const asset = await resolveReleaseDownloadAsset(latest.id)
  assert.equal(
    buildReleaseDownloadUrl(latest.id, latest.sha256, asset.fileName, 'https://downloads.example.com/releases/'),
    `https://downloads.example.com/releases/${latest.sha256}/${asset.fileName}`,
  )
  const file = await stat(asset.filePath)
  const endpoint = `${base}/api/web/releases/${latest.id}`
  const metadata = await get(`${base}/api/web/releases/latest`)
  assert.equal(metadata.status, 200)
  const payload = await metadata.json() as { data: { id: string; sha256: string; downloadUrl: string } }
  assert.equal(payload.data.id, latest.id)
  assert.equal(payload.data.sha256, latest.sha256)
  const downloadEndpoint = config.RELEASE_DOWNLOAD_BASE_URL
    ? payload.data.downloadUrl
    : `${base}${new URL(payload.data.downloadUrl).pathname}`
  const checksum = await get(`${endpoint}/checksum`)
  assert.equal(checksum.status, 200)
  assert.equal(await checksum.text(), `${latest.sha256}  ${asset.fileName}\n`)
  console.log('PASS real release metadata and downloadable SHA256')

  const head = await get(downloadEndpoint, { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(Number(head.headers.get('content-length')), file.size)
  assert.equal(head.headers.get('accept-ranges'), 'bytes')
  assert.ok(head.headers.get('cache-control')?.includes('no-transform'))
  const etag = head.headers.get('etag')
  assert.ok(etag)
  if (!config.RELEASE_DOWNLOAD_BASE_URL) assert.equal(etag, `"${latest.sha256}"`)
  console.log(`PASS HEAD file length ${file.size}, Range support and validator`)

  const changed = await get(downloadEndpoint, {
    headers: { Range: 'bytes=0-0', 'If-Range': '"different-installer"' },
  })
  assert.equal(changed.status, 200)
  assert.equal(Number(changed.headers.get('content-length')), file.size)
  await changed.body?.cancel()
  console.log('PASS changed installer validator rejects unsafe continuation')

  if (!resumeOnly) {
    const response = await get(downloadEndpoint)
    assert.equal(response.status, 200)
    const hash = createHash('sha256')
    assert.equal(await consume(response, hash), file.size)
    assert.equal(hash.digest('hex'), latest.sha256)
    console.log('PASS full installer download SHA256 matches the original')
  }

  const resumedHash = createHash('sha256')
  const split = Math.min(65536, file.size - 1)
  const firstPart = await get(downloadEndpoint, { headers: { Range: `bytes=0-${split - 1}` } })
  assert.equal(firstPart.status, 206)
  assert.equal(firstPart.headers.get('content-range'), `bytes 0-${split - 1}/${file.size}`)
  assert.equal(Number(firstPart.headers.get('content-length')), split)
  assert.equal(await consume(firstPart, resumedHash), split)
  const secondPart = await get(downloadEndpoint, {
    headers: { Range: `bytes=${split}-`, 'If-Range': etag },
  })
  assert.equal(secondPart.status, 206)
  assert.equal(secondPart.headers.get('content-range'), `bytes ${split}-${file.size - 1}/${file.size}`)
  assert.equal(await consume(secondPart, resumedHash), file.size - split)
  assert.equal(resumedHash.digest('hex'), latest.sha256)
  console.log('PASS resumed installer SHA256 matches the original')

  const invalid = await get(downloadEndpoint, { headers: { Range: `bytes=${file.size}-` } })
  assert.equal(invalid.status, 416)
  assert.equal(invalid.headers.get('content-range'), `bytes */${file.size}`)
  await invalid.arrayBuffer()
  const missing = await get(`${base}/api/web/releases/does-not-exist/download`)
  assert.equal(missing.status, 404)
  await missing.arrayBuffer()
  const wrongHash = await get(`${endpoint}/files/${'0'.repeat(64)}/${asset.fileName}`)
  assert.equal(wrongHash.status, 404)
  await wrongHash.arrayBuffer()
  const staticHead = await get(`${endpoint}/files/${latest.sha256}/${asset.fileName}`, { method: 'HEAD' })
  assert.equal(staticHead.status, 200)
  assert.ok(staticHead.headers.get('cache-control')?.includes('immutable'))
  console.log('PASS invalid ranges and missing releases')
} finally {
  server?.closeAllConnections()
  server?.close()
}
