import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Document, Footer, Header, Packer, Paragraph, Table, TableCell, TableRow, TextRun } from 'docx'
import { openArrayBuffer } from 'mammoth/lib/zipfile.js'
import { patchOfficeDocx } from '../src/office/patch.ts'
import { parseOfficeBytes } from '../src/office/files.ts'

async function original() {
  return Packer.toBuffer(new Document({ sections: [{
    headers: { default: new Header({ children: [new Paragraph('原页眉')] }) },
    footers: { default: new Footer({ children: [new Paragraph('原页脚')] }) },
    children: [new Paragraph({ children: [new TextRun({ text: '前缀', bold: true }), new TextRun('待改文字'), new TextRun({ text: '后缀', italics: true })] }),
      new Table({ rows: [new TableRow({ children: [new TableCell({ children: [new Paragraph('表格原文')] })] })] }),
      new Paragraph('末段')],
  }] }))
}

test('外部段落修改复用原 DOCX，保留页眉页脚、表格和其他包内文件', async () => {
  const bytes = await original()
  const base = [{ id: 'a', text: '前缀待改文字后缀' }, { id: 'b', text: '表格原文' }, { id: 'c', text: '末段' }]
  const target = [{ id: 'a', text: '前缀新的文字后缀' }, base[1], base[2]]
  const patched = await patchOfficeDocx(bytes, base, target)
  const text = (await parseOfficeBytes(patched, 'docx')).text
  assert.match(text, /前缀新的文字后缀/)
  assert.match(text, /表格原文/)
  const before = await openArrayBuffer(bytes)
  const after = await openArrayBuffer(patched)
  for (const part of ['word/header1.xml', 'word/footer1.xml', 'word/styles.xml', 'word/_rels/document.xml.rels'])
    assert.equal(await after.read(part, 'utf8'), await before.read(part, 'utf8'))
  const xml = await after.read('word/document.xml', 'utf8')
  assert.match(xml, /<w:tbl>/)
  assert.match(xml, /<w:b\/>/)
  assert.match(xml, /<w:i\/>/)
})

test('正文中间插入新段落、删除文字与换行均可保存', async () => {
  const bytes = await original()
  const base = [{ id: 'a', text: '前缀待改文字后缀' }, { id: 'b', text: '表格原文' }, { id: 'c', text: '末段' }]
  const target = [base[0], base[1], { id: 'new', text: '新增第一行\n新增第二行' }, { id: 'c', text: '' }]
  const patched = await patchOfficeDocx(bytes, base, target)
  const text = (await parseOfficeBytes(patched, 'docx')).text
  assert.match(text, /新增第一行\n新增第二行/)
  assert.doesNotMatch(text, /末段/)
})

test('重复段落或段落重排不能静默覆盖原件', async () => {
  const bytes = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('相同'), new Paragraph('相同')] }] }))
  await assert.rejects(patchOfficeDocx(bytes, [{ id: 'a', text: '相同' }], [{ id: 'a', text: '新的' }]), error => error.code === 'OFFICE_PATCH_CONFLICT')
  await assert.rejects(patchOfficeDocx(await original(), [{ id: 'a', text: '前缀待改文字后缀' }, { id: 'c', text: '末段' }],
    [{ id: 'c', text: '末段' }, { id: 'a', text: '前缀待改文字后缀' }]), error => error.code === 'OFFICE_PATCH_CONFLICT')
})

test('正文与文本框段落独立提取，修改外层正文保留文本框文字', async () => {
  const bytes = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('正文')] }] }))
  const zip = await openArrayBuffer(bytes)
  const xml = await zip.read('word/document.xml', 'utf8')
  zip.write('word/document.xml', xml.replace('</w:p>', '<w:r><w:drawing><w:txbxContent><w:p><w:r><w:t>框内文字</w:t></w:r></w:p></w:txbxContent></w:drawing></w:r></w:p>'))
  const source = Buffer.from(await zip.toArrayBuffer())
  assert.equal((await parseOfficeBytes(source, 'docx')).text, '正文\n\n框内文字')
  const patched = await patchOfficeDocx(source, [{ id: 'a', text: '正文' }, { id: 'b', text: '框内文字' }],
    [{ id: 'a', text: '新的正文' }, { id: 'b', text: '框内文字' }])
  assert.equal((await parseOfficeBytes(patched, 'docx')).text, '新的正文\n\n框内文字')
})
