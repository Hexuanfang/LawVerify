import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { env } from '../dist/config/env.js'
import { closeDocumentParser, parseDocument, runDocumentParsing, warmupDocumentParser } from '../dist/infrastructure/document-jobs.js'

env.WORKSPACE_DATA_DIR = await mkdtemp(path.resolve(import.meta.dirname, '../../tmp/local-parsing-'))
env.LAWVERIFY_PYTHON = process.env.LAWVERIFY_TEST_PYTHON || env.LAWVERIFY_PYTHON
after(closeDocumentParser)

test('本机解析无需登录或网络，预热后可解析中文文件', async t => {
  const originalFetch = globalThis.fetch
  const originalUrl = env.PARSER_SERVICE_URL
  env.PARSER_SERVICE_URL = 'https://parser.invalid'
  globalThis.fetch = () => assert.fail('材料解析发出了网络请求')
  t.after(() => { globalThis.fetch = originalFetch; env.PARSER_SERVICE_URL = originalUrl })
  await warmupDocumentParser()
  assert.equal((await parseDocument(Buffer.from('本机解析成功'), '测试.txt')).text, '本机解析成功')
})

test('解析失败保留旧产物并清理临时输出', async () => {
  const root = path.join(env.WORKSPACE_DATA_DIR, 'parsing')
  const input = path.join(root, 'input.doc')
  const output = path.join(root, 'result.json')
  await writeFile(input, 'invalid document')
  await writeFile(output, 'existing')
  await assert.rejects(runDocumentParsing(input, output, '测试.doc'), { code: 'PARSE_FAILED', statusCode: 422 })
  assert.equal(await readFile(output, 'utf8'), 'existing')
  assert.deepEqual((await readdir(root)).filter(name => name.startsWith('.parse-')), [])
})
