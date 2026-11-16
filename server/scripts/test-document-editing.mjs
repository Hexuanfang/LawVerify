import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { env } from '../src/config/env.ts'

const directory = path.resolve('tmp', `document-editing-${Date.now()}`)
mkdirSync(directory, { recursive: true })
env.WORKSPACE_DATA_DIR = directory
env.KNOWLEDGE_RAG_MODE = 'local'
const { readWorkspace, writeWorkspace, runWithWorkspaceAccount } = await import('../src/store.ts')
const { saveDocumentContent } = await import('../src/document-editing.ts')
const account = 'whole-document@test.invalid'
const content = paragraphs => paragraphs.map(({ id, text, richText }) => ({ id, text, richText }))

async function fixture() {
  const state = await readWorkspace()
  state.cases = [{ id: 'case', name: '全文编辑', description: '', createdAt: '2026-11-16', status: 'ready' }]
  state.certificates = [{ id: 'doc', caseId: 'case', title: '起诉状', role: 'plaintiff', focus: '', createdAt: '2026-11-16', paragraphIds: ['a', 'b'], paragraphs: [
    { id: 'a', text: '借款已交付。尚未还款。', richText: '<p>借款已交付。尚未还款。</p>', verified: true,
      links: [{ evidenceId: 'e', locator: '第1页', quote: '凭证', sentenceIndex: 1, sentenceText: '尚未还款。', relation: 'support' }] },
    { id: 'b', text: '此致', richText: '<h2>此致</h2>', verified: true, note: '保留批注' },
  ] }]
  state.evidences = [{ id: 'e', caseId: 'case', name: '凭证', fileName: '凭证.txt', number: '证据1', type: 'text', ocrText: '凭证', uploadedAt: '2026-11-16' }]
  state.claimUnits = []; state.claimEvidenceMatches = []
  await writeWorkspace(state)
  return content(state.certificates[0].paragraphs)
}

await runWithWorkspaceAccount(account, async () => {
  await test('只改格式保留审阅、最新引用、批注及案件完成状态', async () => {
    const base = await fixture()
    const state = await readWorkspace()
    state.certificates[0].paragraphs[0].links[0].locator = '后台新定位'
    await writeWorkspace(state)
    const next = structuredClone(base); next[0].richText = '<p><strong>借款已交付。尚未还款。</strong></p>'
    await saveDocumentContent('doc', { expectedContent: base, paragraphs: next })
    const saved = await readWorkspace()
    assert.equal(saved.certificates[0].paragraphs[0].verified, true)
    assert.equal(saved.certificates[0].paragraphs[0].links[0].locator, '后台新定位')
    assert.equal(saved.certificates[0].paragraphs[1].note, '保留批注')
    assert.equal(saved.cases[0].status, 'ready')
  })
  await test('拆分段落保留唯一未改句引用，取消受影响审阅并更新顺序', async () => {
    const base = await fixture()
    await saveDocumentContent('doc', { expectedContent: base, paragraphs: [
      { id: 'a', text: '借款已经交付。', richText: '<p>借款已经交付。</p>' },
      { id: 'new', text: '尚未还款。', richText: '<p>尚未还款。</p>' }, base[1],
    ] })
    const state = await readWorkspace(), doc = state.certificates[0]
    assert.deepEqual(doc.paragraphIds, ['a', 'new', 'b'])
    assert.equal(doc.paragraphs[0].links.length, 0)
    assert.equal(doc.paragraphs[1].links[0].sentenceIndex, 0)
    assert.equal(doc.paragraphs[1].verified, false)
    assert.equal(doc.paragraphs[2].verified, true)
    assert.equal(state.cases[0].status, 'in_review')
  })
  await test('合并段落引用重新定位，重复句不误挂', async () => {
    const base = await fixture()
    await saveDocumentContent('doc', { expectedContent: base, paragraphs: [{ id: 'a', text: '借款已交付。尚未还款。此致', richText: '<p>借款已交付。尚未还款。此致</p>' }] })
    let state = await readWorkspace()
    assert.equal(state.certificates[0].paragraphs[0].links[0].sentenceIndex, 1)
    const merged = content(state.certificates[0].paragraphs)
    await saveDocumentContent('doc', { expectedContent: merged, paragraphs: [{ id: 'a', text: '尚未还款。尚未还款。', richText: '<p>尚未还款。尚未还款。</p>' }] })
    state = await readWorkspace()
    assert.equal(state.certificates[0].paragraphs[0].links.length, 0)
  })
  await test('旧基线不能覆盖后台正文，所有段落均不部分写入', async () => {
    const base = await fixture(), state = await readWorkspace()
    state.certificates[0].paragraphs[1].text = '后台新正文'
    await writeWorkspace(state)
    const next = structuredClone(base); next[0].text = '本机修改'
    await assert.rejects(saveDocumentContent('doc', { expectedContent: base, paragraphs: next }), error => error.code === 'DOCUMENT_CONFLICT')
    assert.equal((await readWorkspace()).certificates[0].paragraphs[0].text, base[0].text)
  })
  await test('已提交请求可安全重试，并发旧基线只能一个成功', async () => {
    const base = await fixture(), next = structuredClone(base)
    next[0].text = '第一次修改'; next[0].richText = '<p>第一次修改</p>'
    await saveDocumentContent('doc', { expectedContent: base, paragraphs: next })
    await saveDocumentContent('doc', { expectedContent: base, paragraphs: next })
    const other = structuredClone(next); other[0].text = '另一份修改'
    const third = structuredClone(next); third[0].text = '第三份修改'
    const results = await Promise.allSettled([other, third].map(paragraphs => saveDocumentContent('doc', { expectedContent: next, paragraphs })))
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  })
  await test('重复或跨文书段落 ID 拒绝保存，空文书可存为待审阅', async () => {
    const base = await fixture()
    await assert.rejects(saveDocumentContent('doc', { expectedContent: base, paragraphs: [base[0], base[0]] }))
    const state = await readWorkspace()
    state.certificates.push({ ...state.certificates[0], id: 'other', paragraphIds: ['other-p'], paragraphs: [{ id: 'other-p', text: '其他文书', verified: false }] })
    await writeWorkspace(state)
    await assert.rejects(saveDocumentContent('doc', { expectedContent: base, paragraphs: [{ id: 'other-p', text: '冒用', richText: '<p>冒用</p>' }] }))
    await saveDocumentContent('doc', { expectedContent: base, paragraphs: [{ id: 'blank', text: '', richText: '<p></p>' }] })
    assert.equal((await readWorkspace()).cases[0].status, 'in_review')
  })
})
