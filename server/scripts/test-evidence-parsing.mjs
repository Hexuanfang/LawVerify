import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdtemp, mkdir, copyFile, writeFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import { once } from 'node:events'
import { createParserFixtures } from './parser-test-fixtures.mjs'

const root = path.resolve(import.meta.dirname, '../..')
const directory = await mkdtemp(path.join(root, 'tmp/evidence-parsing-'))
const samples = createParserFixtures()
const account = 'parsing-test@example.invalid'
const { env } = await import('../dist/config/env.js')
Object.assign(env, { WORKSPACE_DATA_DIR: path.join(directory, 'data'), APP_DATA_ROOT: directory,
  APP_RUNTIME_ROOT: path.join(root, 'server'), STORAGE_LOCAL_ROOT: 'storage',
  LAWVERIFY_PYTHON: process.env.LAWVERIFY_TEST_PYTHON || env.LAWVERIFY_PYTHON,
  KNOWLEDGE_RAG_MODE: 'local', LLM_BASE_URL: '', LLM_API_KEY: '', LLM_MODEL: '' })
const { readWorkspace, writeWorkspace, runWithWorkspaceAccount } = await import('../dist/store.js')
const { ensureEvidenceParsed, approveEvidenceParsing, getEvidenceParsing } = await import('../dist/evidence-parsing.js')
const { runExclusiveWorkspaceMutation } = await import('../dist/infrastructure/workspace-lock.js')
const { closeDocumentParser } = await import('../dist/infrastructure/document-jobs.js')
const { createApp } = await import('../dist/app.js')
after(closeDocumentParser)

await mkdir(path.join(directory, 'storage'), { recursive: true })
await copyFile(path.join(samples, 'mixed.pdf'), path.join(directory, 'storage/source'))
await writeFile(path.join(directory, 'storage/bad.pdf'), '%PDF-1.7 broken')
await copyFile(path.join(samples, 'group.png'), path.join(directory, 'storage/source.png'))

test('文书解析 HTTP 入口使用 Python 解析无后缀的上传暂存文件', async () => {
  const server = createApp().app.listen(0, '127.0.0.1')
  try {
    await once(server, 'listening')
    const input = new FormData()
    input.set('file', new Blob([await readFile(path.join(samples, 'mixed.docx'))],
      { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }), 'mixed.docx')
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/documents/parse`, {
      method: 'POST', body: input,
    })
    const body = await response.json()
    assert.equal(response.status, 200, JSON.stringify(body))
    assert.match(body.text, /图片前[\s\S]*123456\.78[\s\S]*图片后/)
    assert.match(body.html, /<table>.*colspan="2"/)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})

test('解析结果、人工修复、账号隔离与原件替换保护', async () => {
  await runWithWorkspaceAccount(account, async () => {
    const workspace = await readWorkspace()
    workspace.cases = [{ id: 'case-parser', name: '解析测试', description: '', createdAt: '2026-11-16', status: 'draft' }]
    workspace.evidences = ['good', 'bad', 'stale'].map(id => ({ id, caseId: 'case-parser', type: 'pdf',
      name: id, number: id, fileName: `${id}.pdf`, storageKey: id === 'bad' ? 'bad.pdf' : 'source',
      uploadedAt: '2026-11-16', contentHash: id, ocrText: '', summaryStatus: 'idle' }))
    await writeWorkspace(workspace)
    const good = await ensureEvidenceParsed('good')
    assert.equal(good.parsing.status, 'ready')
    assert.match(good.ocrText, /123456.78/)
    const detail = await getEvidenceParsing('good')
    assert.equal(detail.result.pages, 3)
    assert.equal((await ensureEvidenceParsed('good')).parsing.revision, good.parsing.revision)
    const bad = await ensureEvidenceParsed('bad')
    assert.equal(bad.parsing.status, 'failed')
    const reviewRevision = bad.parsing.revision
    await assert.rejects(approveEvidenceParsing('bad', 'old-revision', '人工修复的正文'), /已变化/)
    await approveEvidenceParsing('bad', reviewRevision, '人工修复的正文，金额1000元。')
    await assert.rejects(approveEvidenceParsing('bad', reviewRevision, '另一个窗口的过期正文'), /已变化/)
    const reviewed = await ensureEvidenceParsed('bad')
    assert.equal(reviewed.parsing.status, 'ready')
    assert.match(reviewed.ocrText, /人工修复/)
    const parsing = ensureEvidenceParsed('stale')
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await readWorkspace()).evidences.find(item => item.id === 'stale')?.parsing?.status === 'processing') break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    await runExclusiveWorkspaceMutation(async () => {
      const latest = await readWorkspace()
      const target = latest.evidences.find(item => item.id === 'stale')
      target.contentHash = 'replaced'
      target.ocrText = '替换后的正文'
      target.parsing = undefined
      await writeWorkspace(latest)
    })
    assert.equal((await readWorkspace()).evidences.find(item => item.id === 'stale').ocrText, '替换后的正文')
    const replacementTask = ensureEvidenceParsed('stale')
    await parsing
    const replacement = await replacementTask
    assert.equal(replacement.parsing.status, 'ready')
    assert.match(replacement.ocrText, /123456.78/)
    await runExclusiveWorkspaceMutation(async () => {
      const latest = await readWorkspace()
      latest.evidences.push({ id: 'image', caseId: 'case-parser', type: 'image', name: '群聊', number: 'E04',
        fileName: 'source.png', storageKey: 'source.png', contentHash: 'image-source', ocrText: '', uploadedAt: '2026-11-16',
        sourceDataUrl: `data:image/png;base64,${(await readFile(path.join(directory, 'storage/source.png'))).toString('base64')}` })
      await writeWorkspace(latest)
    })
    const image = await ensureEvidenceParsed('image')
    assert.equal(image.parsing.status, 'ready')
    await approveEvidenceParsing('image', image.parsing.revision, '人工修订后的聊天正文，金额999.00元。')
    Object.assign(env, { LLM_BASE_URL: 'http://parser-model.invalid', LLM_API_KEY: 'test-only', LLM_MODEL: 'test-text',
      LLM_VISION_BASE_URL: 'http://unexpected-vision.invalid', LLM_VISION_API_KEY: 'test-only', LLM_VISION_MODEL: 'test-vision' })
    const originalFetch = globalThis.fetch
    const calls = []
    globalThis.fetch = async (url, options) => {
      const body = JSON.parse(options.body)
      calls.push({ url: String(url), body })
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: '人工审核正文的理解', keyFacts: ['金额999.00元'], confidence: 0.9 }) } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } })
    }
    try {
      const { summarizeEvidence } = await import('../dist/service.js')
      await summarizeEvidence('image', { background: true })
      assert.ok(calls.length > 0)
      assert.ok(calls.every(call => call.url.startsWith('http://parser-model.invalid') && !JSON.stringify(call.body).includes('image_url')))
      assert.ok(calls.some(call => JSON.stringify(call.body).includes('999.00')))
      assert.equal((await readWorkspace()).evidences.find(item => item.id === 'image').ocrText, '人工修订后的聊天正文，金额999.00元。')
    } finally { globalThis.fetch = originalFetch }
    Object.assign(env, { LLM_BASE_URL: '', LLM_API_KEY: '', LLM_MODEL: '' })
    await runExclusiveWorkspaceMutation(async () => {
      const latest = await readWorkspace()
      latest.evidences.push({ id: 'legacy', caseId: 'case-parser', type: 'pdf', name: '升级前的材料', number: 'E05',
        fileName: 'source.pdf', storageKey: 'source', contentHash: 'legacy', ocrText: '', summaryStatus: 'idle', uploadedAt: '2026-11-16' })
      await writeWorkspace(latest)
    })
    const { retryCaseAgent } = await import('../dist/service.js')
    await retryCaseAgent('case-parser')
    let legacy
    for (let attempt = 0; attempt < 200; attempt++) {
      legacy = (await readWorkspace()).evidences.find(item => item.id === 'legacy')
      if (legacy.parsing?.status === 'ready') break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.equal(legacy.parsing?.status, 'ready', '旧材料必须在整案重试后进入解析队列')
    for (const [id, file] of [['continuous-a', 'continuous-1.png'], ['continuous-b', 'continuous-2.png']]) {
      await copyFile(path.join(samples, file), path.join(directory, 'storage', file))
      await runExclusiveWorkspaceMutation(async () => {
        const latest = await readWorkspace()
        latest.evidences.push({ id, caseId: 'case-parser', type: 'image', name: file, number: id,
          fileName: file, storageKey: file, contentHash: id, ocrText: '', uploadedAt: '2026-11-16' })
        await writeWorkspace(latest)
      })
      await ensureEvidenceParsed(id)
    }
    const continuous = await getEvidenceParsing('continuous-b')
    assert.ok(continuous.continuityCandidates.some(item => item.evidenceId === 'continuous-a' && item.position === 'before' && item.overlapMessages === 4))
    await runExclusiveWorkspaceMutation(async () => {
      const latest = await readWorkspace()
      latest.evidences.push({ id: 'deleted', caseId: 'case-parser', type: 'pdf', name: '删除中的材料', number: 'E06',
        fileName: 'source.pdf', storageKey: 'source', contentHash: 'deleted', ocrText: '', uploadedAt: '2026-11-16' })
      await writeWorkspace(latest)
    })
    const deletedTask = ensureEvidenceParsed('deleted')
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await readWorkspace()).evidences.find(item => item.id === 'deleted')?.parsing?.status === 'processing') break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    await runExclusiveWorkspaceMutation(async () => {
      const latest = await readWorkspace()
      latest.evidences = latest.evidences.filter(item => item.id !== 'deleted')
      await writeWorkspace(latest)
    })
    await deletedTask
    assert.ok(!(await readWorkspace()).evidences.some(item => item.id === 'deleted'), '删除后的材料不能被旧任务恢复')
  })
  await runWithWorkspaceAccount('another-test@example.invalid', async () => {
    await assert.rejects(getEvidenceParsing('good'), /不存在/)
  })
})
