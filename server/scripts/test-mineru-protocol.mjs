import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { PythonWorkerPool } from '../src/infrastructure/python-workers.ts'
import { createParserFixtures } from './parser-test-fixtures.mjs'

const root = path.resolve(import.meta.dirname, '../..')
const python = process.env.LAWVERIFY_TEST_PYTHON
const modelHome = process.env.LAWVERIFY_MINERU_HOME
if (!python || !modelHome) throw new Error('需要 LAWVERIFY_TEST_PYTHON 和 LAWVERIFY_MINERU_HOME')
const samples = createParserFixtures(python)

test('真实 MinerU 常驻协议保留 PDF 正文、聊天发送方和失败隔离', async () => {
  const dir = await mkdtemp(path.join(root, 'tmp/mineru-protocol-'))
  const pool = new PythonWorkerPool({ python, script: path.join(root, 'server/python/worker.py'), size: 1,
    workerEnv: { LAWVERIFY_PARSER_ROOT: dir, LAWVERIFY_MINERU_HOME: modelHome, MINERU_MODEL_ONNX_DEVICE: process.env.LAWVERIFY_TEST_PARSER_DEVICE || 'cpu',
      LAWVERIFY_PARSER_BUNDLED: process.env.LAWVERIFY_TEST_BUNDLED || '0' } })
  try {
    const first = await pool.run({ action: 'parse', inputPath: path.join(samples, 'mixed.pdf'),
      outputPath: path.join(dir, 'mixed.json') })
    const result = JSON.parse(await readFile(first.outputPath, 'utf8'))
    if (process.env.LAWVERIFY_EXPECT_PARSER_DEVICE) assert.equal(first.device, process.env.LAWVERIFY_EXPECT_PARSER_DEVICE)
    if (process.env.LAWVERIFY_EXPECT_PARSER_DEVICE === 'gpu' && process.platform === 'win32') assert.ok(first.providers.includes('DmlExecutionProvider'))
    assert.equal(result.pages, 3)
    if (process.env.LAWVERIFY_TEST_BUNDLED === '1') assert.ok((await readFile(path.join(dir, 'mineru/models/MinerU-4_models_onnx/OCR/paddleocr/ch_PP-OCRv6_small_rec_infer.onnx'))).byteLength > 0)
    assert.match(result.text, /123456.78/)
    assert.ok(result.blocks.every(block => block.bbox.length === 4))
    await writeFile(path.join(dir, 'bad.pdf'), '%PDF-1.7 broken')
    await assert.rejects(pool.run({ action: 'parse', inputPath: path.join(dir, 'bad.pdf'), outputPath: path.join(dir, 'bad.json') }))
    const next = await pool.run({ action: 'parse', inputPath: path.join(samples, 'group.png'),
      outputPath: path.join(dir, 'group.json') })
    assert.equal(next.pid, first.pid)
    const chat = JSON.parse(await readFile(next.outputPath, 'utf8'))
    assert.equal(chat.chat.messages.length, 6)
    assert.equal(chat.chat.messages[5].display_name, '李四')
    assert.match(chat.text, /张三/)
    assert.match(chat.text, /本人侧/)
    async function parseSample(name) {
      const { outputPath } = await pool.run({ action: 'parse', inputPath: path.join(samples, name),
        outputPath: path.join(dir, `${name}.json`) })
      return JSON.parse(await readFile(outputPath, 'utf8'))
    }
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
      const { outputPath } = await pool.run({ action: 'parse',
        inputPath: path.join(root, 'server/eval/v2/assets', `${name}.pdf`), outputPath: path.join(dir, `${name}.json`) })
      const parsed = JSON.parse(await readFile(outputPath, 'utf8'))
      assert.equal(parsed.text.split(phrase).length - 1, 1, `${name} 不应重复追加已识别的正文`)
    }
  } finally { await pool.close() }
})
