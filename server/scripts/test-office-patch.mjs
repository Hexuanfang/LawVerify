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

test('完整有序的正文基线可定位需要更新的重复段落', async () => {
  const bytes = await Packer.toBuffer(new Document({ sections: [{ children: [
    new Paragraph('相同'), new Paragraph(''), new Paragraph('相同'),
  ] }] }))
  const first = { id: 'a', text: '相同' }
  const last = { id: 'b', text: '相同' }
  for (const prefix of [[first], [first, { id: 'blank', text: '' }]]) {
    const target = [...prefix, { id: 'new', text: '插入段落' }, { ...last, text: '修改第二处' }]
    const patched = await patchOfficeDocx(bytes, [...prefix, last], target)
    assert.equal((await parseOfficeBytes(patched, 'docx')).text, '相同\n\n\n\n插入段落\n\n修改第二处')
  }
})

test('完整的表格和列表快照可局部改写，跨边界或不完整的快照返回冲突', async () => {
  const row = (...texts) => new TableRow({ children: texts.map(text => new TableCell({ children: [new Paragraph(text)] })) })
  const bytes = await Packer.toBuffer(new Document({ sections: [{ children: [
    new Table({ rows: [row('证据名称', '证明目的'), row('合同', '证实付款')] }),
    new Paragraph({ text: '第一项', bullet: { level: 0 } }), new Paragraph({ text: '第二项', bullet: { level: 0 } }),
    new Paragraph('结束'),
  ] }] }))
  const table = { id: 'table', text: '证据名称\t证明目的\n合同\t证实付款', richText: '<table><tr><td>合同</td></tr></table>' }
  const list = { id: 'list', text: '第一项\n第二项', richText: '<ul><li>第一项</li><li>第二项</li></ul>' }
  const end = { id: 'end', text: '结束' }
  const base = [table, list, end]
  const nextTable = { ...table, text: table.text.replace('证实付款', '证明付款日期') }
  const nextList = { ...list, text: list.text.replace('第二项', '新的第二项') }
  const patched = await patchOfficeDocx(bytes, base, [nextTable, nextList, end])
  assert.equal((await parseOfficeBytes(patched, 'docx')).text,
    '证据名称\n\n证明目的\n\n合同\n\n证明付款日期\n\n第一项\n\n新的第二项\n\n结束')
  const zip = await openArrayBuffer(patched)
  assert.match(await zip.read('word/document.xml', 'utf8'), /<w:tbl>[\s\S]*<\/w:tbl>[\s\S]*<w:numPr>/u)
  const cross = { ...table, text: table.text.replace('合同\t证实付款', '买卖合同及付款') }
  await assert.rejects(patchOfficeDocx(bytes, base, [cross, list, end]), error => error.code === 'OFFICE_PATCH_CONFLICT')
  const both = { ...table, text: table.text.replace('合同\t证实付款', '新合同\t付款日期') }
  await assert.rejects(patchOfficeDocx(bytes, base, [both, list, end]), error => error.code === 'OFFICE_PATCH_CONFLICT')
  await assert.rejects(patchOfficeDocx(bytes, [table, list], [nextTable, list]), error => error.code === 'OFFICE_PATCH_CONFLICT')
})

test('可在顶层表格之前补写正文，表格内部插入仍返回冲突', async () => {
  const bytes = await Packer.toBuffer(new Document({ sections: [{ children: [
    new Paragraph('正文'), new Table({ rows: [new TableRow({ children: [
      new TableCell({ children: [new Paragraph('第一格')] }), new TableCell({ children: [new Paragraph('第二格')] }),
    ] })] }),
  ] }] }))
  const [body, first, second] = [{ id: 'a', text: '正文' }, { id: 'b', text: '第一格' }, { id: 'c', text: '第二格' }]
  const extra = { id: 'new', text: '补写正文' }
  const base = [body, first, second]
  const patched = await patchOfficeDocx(bytes, base, [body, extra, first, second])
  assert.equal((await parseOfficeBytes(patched, 'docx')).text, '正文\n\n补写正文\n\n第一格\n\n第二格')
  const zip = await openArrayBuffer(patched)
  assert.match(await zip.read('word/document.xml', 'utf8'), /补写正文<\/w:t><\/w:r><\/w:p><w:tbl>/u)
  await assert.rejects(patchOfficeDocx(bytes, base, [body, first, extra, second]), error => error.code === 'OFFICE_PATCH_CONFLICT')
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
