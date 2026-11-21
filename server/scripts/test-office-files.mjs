import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Document, Packer, Paragraph } from 'docx'
import { env } from '../src/config/env.ts'

const dataDir = fileURLToPath(new URL(`../../tmp/local-document-${randomUUID()}`, import.meta.url))
env.WORKSPACE_DATA_DIR = dataDir
const { officeFormat, officeRoot, parseOfficeBytes } = await import('../src/office/files.ts')

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
