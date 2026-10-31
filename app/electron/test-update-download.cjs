const assert = require('node:assert/strict')
const { test } = require('node:test')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { downloadInstaller } = require('./update-download.cjs')

const bytes = Buffer.from('isolated installer download fixture')
const sha256 = createHash('sha256').update(bytes).digest('hex')

async function withDownload(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lawverify-update-'))
  const targetPath = path.join(directory, 'installer.dmg')
  const tempPath = `${targetPath}.part`
  const options = {
    fetch: async () => new Response(bytes, { headers: { 'content-length': String(bytes.length) } }),
    url: 'https://update.example.test/installer.dmg', version: '0.1.58', sha256,
    resolveTarget: () => ({ targetPath, tempPath }),
  }
  try { await run(options, targetPath, tempPath) }
  finally { fs.rmSync(directory, { recursive: true, force: true }) }
}

test('downloads, reports progress and replaces only after SHA256 verification', async () => {
  await withDownload(async (options, target, partial) => {
    const progress = []
    fs.writeFileSync(target, 'previous verified installer')
    assert.equal(await downloadInstaller({ ...options, onProgress: event => progress.push(event) }), target)
    assert.deepEqual(fs.readFileSync(target), bytes)
    assert.equal(fs.existsSync(partial), false)
    assert.equal(progress.at(-1).progress, 100)
  })
})

test('corrupt downloads preserve previous installer and remove partial data', async () => {
  await withDownload(async (options, target, partial) => {
    fs.writeFileSync(target, 'previous verified installer')
    await assert.rejects(downloadInstaller({ ...options, sha256: '0'.repeat(64) }), /完整性/)
    assert.equal(fs.readFileSync(target, 'utf8'), 'previous verified installer')
    assert.equal(fs.existsSync(partial), false)
  })
})

test('truncated and empty downloads are rejected', async () => {
  await withDownload(async (options, target, partial) => {
    await assert.rejects(downloadInstaller({ ...options,
      fetch: async () => new Response(bytes, { headers: { 'content-length': String(bytes.length + 1) } }),
    }), /不完整/)
    await assert.rejects(downloadInstaller({ ...options, fetch: async () => new Response('') }), /不完整/)
    assert.equal(fs.existsSync(target), false)
    assert.equal(fs.existsSync(partial), false)
  })
})

test('HTTP failures and missing checksums never create an installer', async () => {
  await withDownload(async (options, target) => {
    await assert.rejects(downloadInstaller({ ...options, fetch: async () => new Response('', { status: 503 }) }), /503/)
    await assert.rejects(downloadInstaller({ ...options, sha256: '' }), /校验/)
    assert.equal(fs.existsSync(target), false)
  })
})

test('header timeout ends an unresponsive download request', async () => {
  await withDownload(async (options) => {
    await assert.rejects(downloadInstaller({ ...options, headerTimeoutMs: 20,
      fetch: (_url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      }),
    }), /超时/)
  })
})

test('idle timeout closes stalled body and removes partial installer', async () => {
  await withDownload(async (options, target, partial) => {
    await assert.rejects(downloadInstaller({ ...options, idleTimeoutMs: 20,
      fetch: async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes) } })),
    }), /超时/)
    assert.equal(fs.existsSync(target), false)
    assert.equal(fs.existsSync(partial), false)
  })
})

test('unknown content length still verifies downloaded bytes', async () => {
  await withDownload(async (options, target) => {
    assert.equal(await downloadInstaller({ ...options, fetch: async () => new Response(bytes) }), target)
    assert.deepEqual(fs.readFileSync(target), bytes)
  })
})
