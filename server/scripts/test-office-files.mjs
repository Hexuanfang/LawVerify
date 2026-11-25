import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Document, Packer, Paragraph, TextRun } from 'docx'
import { env } from '../src/config/env.ts'

const dataDir = fileURLToPath(new URL(`../../tmp/local-document-${randomUUID()}`, import.meta.url))
env.WORKSPACE_DATA_DIR = dataDir
const { officeFormat, officePath, officeRoot, parseOfficeBytes } = await import('../src/office/files.ts')

test('本地导入文书后可保存正文并下载更新后的原格式文件', async () => {
  await mkdir(dataDir, { recursive: true })
  const { createApp } = await import('../src/app.ts')
  const { readWorkspace, writeWorkspace } = await import('../src/store.ts')
  const http = createApp().app.listen(0, '127.0.0.1')
  try {
    await new Promise((resolve, reject) => { http.once('listening', resolve); http.once('error', reject) })
    const base = `http://127.0.0.1:${http.address().port}/api`
    const workspace = await readWorkspace()
    workspace.cases = [{ id: 'local-document-case', name: '文书测试', status: 'draft', createdAt: '2026-11-19' }]
    await writeWorkspace(workspace)
    const docx = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('原始正文')] }] }))
    for (const [format, source] of [['docx', docx], ['txt', Buffer.from('原始正文')], ['md', Buffer.from('\uFEFF原始正文\r\n')]]) {
      const upload = new FormData()
      upload.set('caseId', 'local-document-case')
      upload.set('file', new Blob([source]), `测试.${format}`)
      const imported = await fetch(`${base}/documents/import`, { method: 'POST', body: upload })
      assert.equal(imported.status, 200)
      const { certificate } = await imported.json()
      if (format === 'md') {
        const original = await fetch(`${base}/documents/${certificate.id}/download`)
        assert.deepEqual(Buffer.from(await original.arrayBuffer()), source)
      }
      const expectedContent = certificate.paragraphs.map(({ id, text, richText }) => ({ id, text, richText }))
      const paragraphs = [{ ...expectedContent[0], text: '修改后的正文', richText: '<p>修改后的正文</p>' }]
      const saved = await fetch(`${base}/certificates/${certificate.id}/content`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedContent, paragraphs }),
      })
      assert.equal(saved.status, 200)
      const download = await fetch(`${base}/documents/${certificate.id}/download`)
      assert.equal(download.status, 200)
      assert.match(download.headers.get('Content-Disposition'), new RegExp(`\\.${format}$`))
      assert.equal((await parseOfficeBytes(Buffer.from(await download.arrayBuffer()), format)).text.trim(), '修改后的正文')
    }
    assert.equal((await readdir(officeRoot())).length, 12, '三个文书各应有两版文件和基线')
    const deletion = await fetch(`${base}/cases/local-document-case`, { method: 'DELETE' })
    assert.equal(deletion.status, 200)
    assert.deepEqual(await readdir(officeRoot()), [], '删除案件应回收历版文书副本和基线')
  } finally {
    await new Promise(resolve => http.close(resolve))
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('DOCX 编辑副本保留原件，提交只改格式的版本并拒绝过期或损坏的文件', async () => {
  const { createApp } = await import('../src/app.ts')
  const { readWorkspace, writeWorkspace } = await import('../src/store.ts')
  const http = createApp().app.listen(0, '127.0.0.1')
  const docx = (text, formatting) => Packer.toBuffer(new Document({ sections: [{ children: [
    new Paragraph({ children: [new TextRun({ text, ...formatting })] }),
  ] }] }))
  try {
    await new Promise((resolve, reject) => { http.once('listening', resolve); http.once('error', reject) })
    const base = `http://127.0.0.1:${http.address().port}/api`
    const workspace = await readWorkspace()
    workspace.cases = [{ id: 'docx-edit-case', name: '文书测试', status: 'draft', createdAt: '2026-11-19' }]
    await writeWorkspace(workspace)

    const original = await docx('原始正文')
    const upload = new FormData()
    upload.set('caseId', 'docx-edit-case')
    upload.set('file', new Blob([original]), '测试.docx')
    const imported = await fetch(`${base}/documents/import`, { method: 'POST', body: upload })
    assert.equal(imported.status, 200)
    const { certificate } = await imported.json()
    const originalFile = certificate.officeFile
    const editSource = `${base}/documents/${certificate.id}/edit-source`
    const initial = await fetch(editSource)
    assert.equal(initial.status, 200)
    assert.equal(initial.headers.get('Content-Type'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    assert.equal(initial.headers.get('X-LawVerify-Office-Version'), originalFile.sha256)
    assert.deepEqual(Buffer.from(await initial.arrayBuffer()), original)

    const expectedContent = certificate.paragraphs.map(({ id, text, richText }) => ({ id, text, richText }))
    const changed = [{ ...expectedContent[0], text: '更新正文', richText: '<p>更新正文</p>' }]
    assert.equal((await fetch(`${base}/certificates/${certificate.id}/content`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedContent, paragraphs: changed }),
    })).status, 200)
    const overlay = await fetch(editSource)
    assert.equal(overlay.status, 200)
    assert.equal(overlay.headers.get('X-LawVerify-Office-Version'), originalFile.sha256)
    assert.equal((await parseOfficeBytes(Buffer.from(await overlay.arrayBuffer()), 'docx')).text, '更新正文')
    const reviewed = await readWorkspace()
    assert.deepEqual(reviewed.certificates[0].officeFile, originalFile)
    reviewed.certificates[0].paragraphs[0].verified = true
    reviewed.certificates[0].paragraphs[0].note = '复核记录'
    reviewed.cases[0].status = 'ready'
    await writeWorkspace(reviewed)

    const submit = (bytes, expectedFileVersion = originalFile.sha256) => {
      const form = new FormData()
      form.set('file', new Blob([bytes]), '测试.docx')
      form.set('content', JSON.stringify({ expectedFileVersion, expectedContent: changed, paragraphs: changed }))
      return fetch(editSource, { method: 'PUT', body: form })
    }
    const invalid = await submit(Buffer.from('无效的 Word 文件'))
    assert.equal(invalid.status, 422)
    assert.equal((await invalid.json()).error.code, 'OFFICE_INVALID_DOCX')
    const formatted = await docx('更新正文', { bold: true })
    const saved = await submit(formatted)
    assert.equal(saved.status, 200)
    const { workspace: savedWorkspace } = await saved.json()
    const edited = savedWorkspace.certificates[0]
    const editedFile = edited.officeFile
    assert.notEqual(editedFile.sha256, originalFile.sha256)
    assert.equal(editedFile.version, originalFile.version + 1)
    assert.equal(edited.paragraphs[0].verified, true)
    assert.equal(edited.paragraphs[0].note, '复核记录')
    assert.equal(savedWorkspace.cases[0].status, 'ready')
    const retry = await submit(formatted)
    assert.equal(retry.status, 200)
    assert.deepEqual((await retry.json()).workspace.certificates[0].officeFile, editedFile)
    const stale = await submit(await docx('更新正文', { italics: true }))
    assert.equal(stale.status, 409)
    assert.equal((await stale.json()).error.code, 'DOCUMENT_CONFLICT')

    const current = await fetch(editSource)
    assert.equal(current.headers.get('X-LawVerify-Office-Version'), editedFile.sha256)
    assert.deepEqual(Buffer.from(await current.arrayBuffer()), formatted)
    const downloaded = await fetch(`${base}/documents/${certificate.id}/download`)
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), formatted)
    assert.deepEqual(await readFile(officePath(originalFile.id)), original)
    assert.equal((await readdir(officeRoot())).length, 4)
  } finally {
    await new Promise(resolve => http.close(resolve))
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('下载无原件的文书后，已打开的编辑器仍可首次保存', async () => {
  const { createApp } = await import('../src/app.ts')
  const { readWorkspace, writeWorkspace } = await import('../src/store.ts')
  const http = createApp().app.listen(0, '127.0.0.1')
  try {
    await new Promise((resolve, reject) => { http.once('listening', resolve); http.once('error', reject) })
    const base = `http://127.0.0.1:${http.address().port}/api`
    const workspace = await readWorkspace()
    workspace.cases = [{ id: 'generated-doc-case', name: '草稿测试', status: 'draft', createdAt: '2026-11-19' }]
    await writeWorkspace(workspace)
    const imported = await fetch(`${base}/certificates/import`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ caseId: 'generated-doc-case', title: '草稿', sourceFileName: '草稿.docx', content: '草稿正文' }),
    })
    assert.equal(imported.status, 200)
    const { certificate } = await imported.json()
    assert.equal(certificate.officeFile, undefined)

    const documentUrl = `${base}/documents/${certificate.id}`
    const download = await fetch(`${documentUrl}/download`)
    assert.equal(download.status, 200)
    assert.match(download.headers.get('Content-Disposition'), /\.docx/u)
    const bytes = Buffer.from(await download.arrayBuffer())
    assert.equal((await parseOfficeBytes(bytes, 'docx')).text, '草稿正文')
    assert.equal((await readWorkspace()).certificates[0].officeFile, undefined)

    const paragraphs = certificate.paragraphs.map(({ id, text, richText }) => ({ id, text, richText }))
    const form = new FormData()
    form.set('file', new Blob([bytes]), '草稿.docx')
    form.set('content', JSON.stringify({ expectedFileVersion: 'none', expectedContent: paragraphs, paragraphs }))
    const saved = await fetch(`${documentUrl}/edit-source`, { method: 'PUT', body: form })
    assert.equal(saved.status, 200)
    assert.equal((await saved.json()).workspace.certificates[0].officeFile.version, 1)
    assert.equal((await readdir(officeRoot())).length, 2)
  } finally {
    await new Promise(resolve => http.close(resolve))
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('文书接受 Word、TXT 和 Markdown，扩展名忽略大小写', () => {
  assert.equal(officeFormat('诉状.DOCX'), 'docx')
  assert.equal(officeFormat('诉状.doc'), 'doc')
  assert.equal(officeFormat('说明.txt'), 'txt')
  assert.equal(officeFormat('说明.MD'), 'md')
  assert.equal(officeFormat('说明.markdown'), 'markdown')
  for (const file of ['a.pdf', 'a.md.exe', 'a.docx.exe', '../a.docx'])
    assert.throws(() => officeFormat(file))
})

test('TXT 保留换行并允许清空，拒绝二进制内容', async () => {
  assert.equal((await parseOfficeBytes(Buffer.from('\uFEFF甲\r\n乙'), 'txt')).text, '甲\r\n乙')
  assert.equal((await parseOfficeBytes(Buffer.alloc(0), 'txt')).text, '')
  await assert.rejects(parseOfficeBytes(Buffer.from([0, 255]), 'txt'))
})

test('DOCX 提取正文，拒绝伪装文件', async () => {
  const bytes = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('第一段'), new Paragraph('第二段')] }] }))
  assert.match((await parseOfficeBytes(bytes, 'docx')).text, /第一段/)
  await assert.rejects(parseOfficeBytes(Buffer.from('伪造 DOCX'), 'docx'))
})

test('Markdown 导入提取标题、段落和表格坐标，转义原始 HTML', async () => {
  const source = '## 证据清单\r\n说明\r\n\r\n| 证据名称 | 证明目的 |\r\n| --- | --- |\r\n| 合同 | <img src=x> |'
  const { paragraphs } = await parseOfficeBytes(Buffer.from(source), 'markdown')
  assert.deepEqual(paragraphs.map(item => item.text), ['证据清单', '说明', '证据名称\t证明目的\n合同\t<img src=x>'])
  assert.equal(paragraphs[0].richText, '<h2>证据清单</h2>')
  assert.match(paragraphs[2].richText, /<table>.*&lt;img src=x&gt;.*<\/table>/u)
  assert.doesNotMatch(paragraphs[2].richText, /<img/u)
  await assert.rejects(parseOfficeBytes(Buffer.from([0, 255]), 'md'))
})

test('Windows 安装包保留后端使用的 mammoth ZIP/XML 工具', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../app/package.json', import.meta.url), 'utf8'))
  assert.ok(manifest.dependencies.mammoth)
  assert.equal(manifest.build.win.files.some(pattern => pattern.startsWith('!node_modules/') && pattern.includes('mammoth')), false)
})
