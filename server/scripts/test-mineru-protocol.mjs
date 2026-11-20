import assert from 'node:assert/strict'
import { test } from 'node:test'
import path from 'node:path'
import { createParserTestClient } from './parser-test-client.mjs'
import { createParserFixtures } from './parser-test-fixtures.mjs'

const root = path.resolve(import.meta.dirname, '../..')
const { request, parseFile } = createParserTestClient()
const samples = createParserFixtures()
const parseSample = name => parseFile(path.join(samples, name))

test('云端 MinerU 保留 PDF 正文、聊天发送方和失败隔离', async () => {
  const result = await parseSample('mixed.pdf')
  assert.equal(result.pages, 3)
  assert.match(result.text, /123456.78/)
  assert.ok(result.blocks.every(block => block.bbox.length === 4))

  const invalid = await request('bad.pdf', '%PDF-1.7 broken')
  await invalid.body?.cancel()
  assert.equal(invalid.status, 422)

  const chat = await parseSample('group.png')
  assert.equal(chat.chat.messages.length, 6)
  assert.equal(chat.chat.messages[5].display_name, '李四')
  assert.match(chat.text, /张三/)
  assert.match(chat.text, /本人侧/)

  const screenshots = await parseSample('screenshots.docx')
  assert.equal(screenshots.reviewRequired, false)
  assert.match(screenshots.blocks[0].text, /123456\.78/)
  assert.equal(screenshots.blocks[0].locator, '第 1 段 · 第 1 张图')
  const mixedWord = await parseSample('mixed.docx')
  assert.deepEqual(mixedWord.blocks.map(block => block.kind), ['paragraph', 'image', 'paragraph', 'table_cell'])
  assert.equal(mixedWord.blocks[3].columnSpan, 2)
  assert.match(mixedWord.html, /<table>.*colspan="2"/)
  assert.equal((await parseSample('plain.txt')).text, '普通文本证据')
  assert.equal((await parseSample('rich-text.rtf')).text, 'First paragraph\nSecond paragraph')
  const legacy = await parseSample('legacy.doc')
  assert.equal(legacy.text, '律师函\n见附件附件一。')
  assert.deepEqual(legacy.warnings, [])
  assert.equal((await parseSample('wps-prefix.doc')).text, '附件一：证据目录。')

  const samePage = await parseSample('same-page.pdf')
  assert.match(samePage.text, /Native text on image page/)
  assert.ok(samePage.blocks.some(block => block.page === 1 && /123456\.78/.test(block.text)))
  assert.equal(samePage.text.split('123456.78').length - 1, 1, '同页图片正文只出现一次')
  const graphics = await parseSample('graphics-only.pdf')
  assert.equal(graphics.reviewRequired, true, '只有图形的材料应进入人工审核')
  assert.equal(graphics.text.trim(), '', '内嵌图片的 base64 不应进入正文')
  for (const [name, phrase] of [['native-contract', '付款方'], ['mixed-same-page', '银行转账回单']]) {
    const parsed = await parseFile(path.join(root, 'server/eval/v2/assets', `${name}.pdf`))
    assert.equal(parsed.text.split(phrase).length - 1, 1, `${name} 不应重复追加已识别的正文`)
  }
})
