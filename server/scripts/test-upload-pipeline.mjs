import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { env } from '../src/config/env.ts'

const directory = mkdtempSync(path.join(os.tmpdir(), 'lawverify-upload-'))
env.WORKSPACE_DATA_DIR = directory
env.KNOWLEDGE_RAG_MODE = 'local'

const { boundedFileStorage } = await import('../src/middleware/bounded-upload.ts')
const { storeObjectFromPath, readObject, readObjectPath } = await import('../src/infrastructure/object-storage.ts')
const { withDocumentSession } = await import('../src/infrastructure/document-jobs.ts')

function pdfFixture(pages = 1) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${3 + i * 2} 0 R`).join(' ')}] /Count ${pages} >>`,
  ]
  for (let i = 0; i < pages; i += 1) {
    const text = `BT /F1 16 Tf 30 100 Td (Page ${i + 1}) Tj ET`
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 ${3 + pages * 2} 0 R >> >> /Contents ${4 + i * 2} 0 R >>`)
    objects.push(`<< /Length ${text.length} >>\nstream\n${text}\nendstream`)
  }
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  let output = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(output))
    output += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = Buffer.byteLength(output)
  output += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`
  for (const offset of offsets.slice(1)) output += `${String(offset).padStart(10, '0')} 00000 n \n`
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  return Buffer.from(output)
}

function uploadThroughStorage(content, fileName = 'material.bin') {
  return new Promise((resolve, reject) => {
    const storage = boundedFileStorage()
    const stream = Readable.from([content])
    const file = {
      fieldname: 'files',
      originalname: fileName,
      encoding: '7bit',
      mimetype: 'application/octet-stream',
      stream,
      buffer: Buffer.alloc(0),
      size: 0,
      destination: '',
      filename: '',
    }
    storage._handleFile({ headers: {} }, file, (error, info) => {
      if (error) reject(error)
      else resolve(info)
    })
  })
}

test('上传按文件落盘，内容与哈希都与原件一致', async () => {
  const content = Buffer.from('原告主张被告欠付货款人民币 500000 元。'.repeat(200))
  const uploaded = await uploadThroughStorage(content, '借条.txt')

  assert.equal(uploaded.size, content.length)
  assert.equal(uploaded.contentHash, createHash('sha256').update(content).digest('hex'))
  assert.ok(existsSync(uploaded.path), '上传后原件应落在临时目录')
  assert.deepEqual(readFileSync(uploaded.path), content)
})

test('原件从临时目录搬进存储目录后内容不变、临时文件被清理', async () => {
  const content = Buffer.from('合同编号 LX-2024-001，双方就货款事宜达成一致。')
  const uploaded = await uploadThroughStorage(content, '合同.txt')
  const tempPath = uploaded.path

  const stored = await storeObjectFromPath({
    path: uploaded.path,
    size: uploaded.size,
    originalname: '合同.txt',
    mimetype: 'text/plain',
    contentHash: uploaded.contentHash,
  }, { bucket: 'evidence', fileName: '合同.txt' })

  assert.equal(stored.contentHash, uploaded.contentHash)
  assert.ok(stored.key.startsWith('evidence/'))
  assert.equal(existsSync(tempPath), false, '搬移后临时文件应被清理')
  assert.deepEqual(await readObject(stored.key), content)
  assert.deepEqual(readFileSync(readObjectPath(stored.key)), content)
})

test('原件解析按路径读取，几百页文件不必在主进程留一份 buffer', async () => {
  const content = pdfFixture(3)
  const uploaded = await uploadThroughStorage(content, '卷宗.pdf')
  const stored = await storeObjectFromPath({
    path: uploaded.path,
    size: uploaded.size,
    originalname: '卷宗.pdf',
    mimetype: 'application/pdf',
    contentHash: uploaded.contentHash,
  }, { bucket: 'evidence', fileName: '卷宗.pdf' })

  const filePath = readObjectPath(stored.key)
  const text = await withDocumentSession(filePath, async session => {
    assert.equal(await session.request('info'), 3)
    return session.request('text')
  })
  assert.match(text, /Page 1/)
  assert.match(text, /Page 3/)
})

test('上传临时文件在搬移后被清理，不会一直堆积', async () => {
  const content = Buffer.from('临时文件清理验证')
  const uploaded = await uploadThroughStorage(content, '临时.txt')
  const tempDir = path.join(env.WORKSPACE_DATA_DIR, 'upload-tmp')
  assert.ok(existsSync(tempDir))
  assert.ok(statSync(uploaded.path).size > 0)

  await storeObjectFromPath({
    path: uploaded.path,
    size: uploaded.size,
    originalname: '临时.txt',
    mimetype: 'text/plain',
    contentHash: uploaded.contentHash,
  }, { bucket: 'evidence', fileName: '临时.txt' })

  assert.equal(existsSync(uploaded.path), false)
})

test('写入存储目录的原件可以直接读回字节', () => {
  const target = path.join(directory, 'direct.bin')
  writeFileSync(target, Buffer.from('直接写入'))
  assert.deepEqual(readFileSync(target), Buffer.from('直接写入'))
})
