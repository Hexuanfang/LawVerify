import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { parsePdfOnDisk } from '../src/infrastructure/pdf-segments.ts'

const root = path.resolve(import.meta.dirname, '../../tmp')
const readArtifact = async file => JSON.parse(await readFile(file, 'utf8'))
const memoryError = () => Object.assign(new Error('memory limit'), { code: 'PARSER_MEMORY_LIMIT' })

async function fixture(pages, onRange, fullMode = 'low') {
  const directory = await mkdtemp(path.join(root, 'pdf-segment-test-'))
  const input = { action: 'parse', fileName: 'sample.pdf', sizeBytes: 1_000_000, mode: 'auto',
    inputPath: path.join(directory, 'input.pdf'), outputPath: path.join(directory, 'result.json') }
  const checkpoint = path.join(directory, 'progress.json')
  const calls = []
  const run = async job => {
    calls.push(job.pdfRange ?? job.action)
    if (job.action === 'pdf-info') return { pdfPages: pages, engineVersion: 'fixture' }
    if (!job.pdfRange && fullMode === 'memory') throw memoryError()
    if (!job.pdfRange && fullMode === 'low') return { pdfPages: pages, engineVersion: 'fixture' }
    const [start, end] = job.pdfRange ?? [1, pages]
    onRange?.(start, end)
    const blocks = Array.from({ length: end - start + 1 }, (_, i) => ({
      page: i + 1, text: '金额 123456.78', bbox: [1, 2, 3, 4], coordinateSpace: 'pdf',
      locator: `第 ${start + i} 页 · 第 1 张图`,
    }))
    await writeFile(job.outputPath, JSON.stringify({ schemaVersion: 1, engineVersion: 'fixture',
      pages: blocks.length, blocks, warnings: start > 1 ? [`第 ${start} 页 · 请核对`] : [],
      text: `【来源：第 5 页的合同】\n【来源：第 ${start} 页 · 原生文本】\n金额 123456.78`, reviewRequired: start > 1 }))
    return { pid: 1 }
  }
  return { calls, parse: (signal = new AbortController().signal) =>
    parsePdfOnDisk({ directory, input, checkpoint, readArtifact, run, signal }).then(() => readArtifact(input.outputPath)) }
}

test('低内存 PDF 每段最多 20 页，合并后保留原页码、文字、坐标和警告', async () => {
  const job = await fixture(45, undefined)
  const result = await job.parse()
  assert.deepEqual(job.calls, ['parse', 'parse', [1, 20], [21, 40], [41, 45]])
  assert.equal(result.pages, 45)
  assert.equal(result.blocks[20].locator, '第 21 页 · 第 1 张图')
  assert.deepEqual(result.blocks[44].bbox, [1, 2, 3, 4])
  assert.deepEqual(result.blocks.map(block => block.page), Array.from({ length: 45 }, (_, i) => i + 1))
  assert.match(result.text, /【来源：第 41 页 · 原生文本】\n金额 123456\.78/)
  assert.equal(result.text.split('【来源：第 5 页的合同】').length - 1, 3)
  assert.deepEqual(result.warnings, ['第 21 页 · 请核对', '第 41 页 · 请核对'])
  assert.equal(result.reviewRequired, true)
})

test('整份解析超限后分段，当前段超限只拆当前段，单页失败后从磁盘续跑', async () => {
  let failPage = true
  const job = await fixture(23, (start, end) => {
    if (start === 21 && (end > start || failPage)) throw memoryError()
  }, 'memory')
  await assert.rejects(job.parse(), { code: 'PARSER_MEMORY_LIMIT', message: '第 21 页解析达到本机内存上限。' })
  assert.deepEqual(job.calls, ['parse', 'pdf-info', [1, 20], [21, 23], [21, 22], [21, 21]])
  job.calls.length = 0
  failPage = false
  const result = await job.parse()
  assert.deepEqual(job.calls, ['pdf-info', [21, 21], [22, 22], [23, 23]])
  assert.equal(result.pages, 23)
})

test('可用内存足够时保留整份解析，取消信号阻止新分段', async () => {
  const job = await fixture(23, undefined, 'high')
  assert.equal((await job.parse()).pages, 23)
  assert.deepEqual(job.calls, ['parse'])
  const controller = new AbortController()
  const paused = await fixture(41, () => controller.abort())
  await assert.rejects(paused.parse(controller.signal), { name: 'AbortError' })
  assert.deepEqual(paused.calls, ['parse', 'parse', [1, 20]])
})
