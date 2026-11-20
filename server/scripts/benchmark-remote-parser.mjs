import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createParserTestClient } from './parser-test-client.mjs'
import { createParserFixtures } from './parser-test-fixtures.mjs'

const project = path.resolve(import.meta.dirname, '../..')
const { request, parseFile } = createParserTestClient()
const samples = createParserFixtures()
const directory = await mkdtemp(path.join(project, 'tmp/remote-parser-evaluation-'))
const expected = JSON.parse(await readFile(path.join(samples, '../expected.json'), 'utf8'))
const files = ['plain.txt', 'legacy.doc', 'rich-text.rtf', 'text.pdf', 'scan.pdf', 'mixed.pdf', 'table.pdf',
  'single.png', 'group.png', 'long.png', 'screenshots.docx', 'mixed.docx', 'graphics-only.pdf']
const normalize = value => String(value).normalize('NFKC').replace(/\s/g, '')

function checks(name, result) {
  const chat = expected.cases.find(item => item.file === name)
  if (chat) return {
    messages: result.chat?.messages?.length === chat.messages.length,
    body: chat.messages.every(message => normalize(result.text).includes(normalize(message.text))),
    sides: chat.messages.every((message, i) => result.chat?.messages[i]?.side === message.side),
    source: result.chat?.source === name && result.chat.messages?.every(message => message.source === name) === true,
  }
  if (name === 'plain.txt') return { text: result.text === '普通文本证据' }
  if (name === 'legacy.doc') return { text: result.text === '律师函\n见附件附件一。' }
  if (name === 'rich-text.rtf') return { text: result.text === 'First paragraph\nSecond paragraph' }
  if (name === 'graphics-only.pdf') return { empty: result.text.trim() === '', review: result.reviewRequired === true }
  return { amount: normalize(result.text).includes('123456.78'),
    structure: name.endsWith('.pdf') ? result.pages > 0 && result.blocks.length > 0 : result.blocks.length > 0 }
}

const report = { createdAt: new Date().toISOString(), samples, directory, runs: [],
  caveats: ['合成样本单次顺序测量', 'HTTP 耗时含鉴权、上传和下载', '结果不能代表真实案卷总体准确率'] }
try {
  for (const [index, fileName] of files.entries()) {
    const remoteStart = performance.now()
    const remote = await parseFile(path.join(samples, fileName))
    const remoteMs = Math.round(performance.now() - remoteStart)
    await writeFile(path.join(directory, `${index}-remote.json`), JSON.stringify(remote))
    const item = { fileName, remoteMs, remoteChecks: checks(fileName, remote), remoteEngine: remote.engineVersion }
    report.runs.push(item)
    await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify(item))
  }
  report.summary = {
    files: report.runs.length,
    remotePassed: report.runs.filter(item => Object.values(item.remoteChecks).every(Boolean)).length,
    remoteTotalMs: report.runs.reduce((sum, item) => sum + item.remoteMs, 0),
  }
  const invalid = await request('bad.pdf', '%PDF-1.7 broken')
  await invalid.body?.cancel()
  const recovered = await request('plain.txt', '失败后恢复')
  report.robustness = { corruptPdfStatus: invalid.status, recoveryStatus: recovered.status,
    recovered: recovered.ok && (await recovered.json()).text === '失败后恢复' }
  if (!recovered.ok) await recovered.body?.cancel()
} finally {
  await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2))
  console.log(`报告 ${path.join(directory, 'report.json')}`)
}
