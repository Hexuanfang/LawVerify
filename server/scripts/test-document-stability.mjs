import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { Document, Packer, Paragraph } from 'docx'
import { parseDocument } from '../src/infrastructure/document-jobs.ts'
import { closePythonWorkers } from '../src/infrastructure/python-workers.ts'
import { env } from '../src/config/env.ts'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { notifyWorkspaceChanged, subscribeWorkspaceChanges } from '../src/infrastructure/workspace-events.ts'
import { boundedMemoryStorage, maxUploadBatchBytes, reserveUpload } from '../src/middleware/bounded-upload.ts'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'

env.WORKSPACE_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'document-stability-'))
after(closePythonWorkers)

function pdfFixture(pages = 2) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${3 + i * 2} 0 R`).join(' ')}] /Count ${pages} >>`,
  ]
  for (let i = 0; i < pages; i++) {
    const text = `BT /F1 16 Tf 30 100 Td (Page ${i + 1}) Tj ET`
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 ${3 + pages * 2} 0 R >> >> /Contents ${4 + i * 2} 0 R >>`)
    objects.push(`<< /Length ${text.length} >>\nstream\n${text}\nendstream`)
  }
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  let output = '%PDF-1.4\n'
  const offsets = [0]
  for (const [i, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(output))
    output += `${i + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = Buffer.byteLength(output)
  output += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`
  for (const offset of offsets.slice(1)) output += `${String(offset).padStart(10, '0')} 00000 n \n`
  output += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  return Buffer.from(output)
}

test('Word parsing runs outside the event loop', async () => {
  const buffer = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('Stability document text')] }] }))
  let ticked = false
  setImmediate(() => { ticked = true })
  const { text } = await parseDocument(buffer, 'stability.docx')
  assert.match(text, /Stability document text/)
  assert.equal(ticked, true)
})

test('PDF parsing preserves text and block page numbers', async () => {
  const result = await parseDocument(pdfFixture(), 'pages.pdf')
  assert.equal(result.pages, 2)
  assert.match(result.text, /Page 1/)
  assert.match(result.text, /Page 2/)
  assert.ok(result.blocks.some(block => block.page === 2 && /Page 2/.test(block.text)))
})

test('corrupted files fail locally and a subsequent valid job still succeeds', async () => {
  await assert.rejects(parseDocument(Buffer.from('invalid archive'), 'bad.docx'), error => error.code === 'PARSE_FAILED')
  assert.equal((await parseDocument(pdfFixture(1), 'valid.pdf')).pages, 1)
})

test('workspace events remain account-isolated and unsubscribe cleanly', () => {
  let a = 0, b = 0
  const stopA = subscribeWorkspaceChanges('A@example.com', () => a++)
  const stopB = subscribeWorkspaceChanges('b@example.com', () => b++)
  notifyWorkspaceChanged('a@example.com')
  assert.equal(a, 1)
  assert.equal(b, 0)
  stopA()
  notifyWorkspaceChanged('a@example.com')
  assert.equal(a, 1)
  stopB()
})

test('workspace subscriptions reject unbounded clients', () => {
  const subscriptions = Array.from({ length: 8 }, () => subscribeWorkspaceChanges('cap', () => {}))
  assert.equal(subscribeWorkspaceChanges('cap', () => {}), null)
  subscriptions.forEach(stop => stop())
  const recovered = subscribeWorkspaceChanges('cap', () => {})
  assert.equal(typeof recovered, 'function')
  recovered()
})

test('upload storage bounds aggregate bytes even without Content-Length', async () => {
  const storage = boundedMemoryStorage()
  const request = {}
  const chunk = Buffer.alloc(16 * 1024 * 1024)
  const stream = Readable.from(Array.from({ length: Math.ceil(maxUploadBatchBytes / chunk.length) + 1 }, () => chunk))
  await assert.rejects(new Promise((resolve, reject) => {
    storage._handleFile(request, { stream }, (error, result) => error ? reject(error) : resolve(result))
  }), error => error.code === 'UPLOAD_BATCH_TOO_LARGE')
  const result = await new Promise((resolve, reject) => {
    storage._handleFile({}, { stream: Readable.from([Buffer.from('safe upload')]) }, (error, result) => error ? reject(error) : resolve(result))
  })
  assert.equal(result.buffer.toString(), 'safe upload')
})

test('upload reservations reject excess concurrency and release once', () => {
  const request = { header: () => undefined }
  const responses = Array.from({ length: 3 }, () => new EventEmitter())
  const results = []
  responses.forEach(response => reserveUpload(request, response, error => results.push(error)))
  assert.equal(results[0], undefined)
  assert.equal(results[1], undefined)
  assert.equal(results[2].code, 'UPLOAD_BUSY')
  responses[0].emit('finish')
  responses[0].emit('close')
  const replacement = new EventEmitter()
  reserveUpload(request, replacement, error => assert.equal(error, undefined))
  responses[1].emit('close')
  replacement.emit('close')
})
