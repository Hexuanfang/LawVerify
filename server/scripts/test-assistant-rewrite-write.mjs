import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { after, test } from 'node:test'
import { env } from '../src/config/env.ts'

const root = mkdtempSync(path.resolve(import.meta.dirname, '../../tmp/lawverify-assistant-rewrite-'))
env.WORKSPACE_DATA_DIR = root
env.KNOWLEDGE_RAG_MODE = 'local'
env.DATABASE_URL = undefined
const { updateParagraph } = await import('../src/service.ts')
const { assistantSnapshot } = await import('../src/assistant/draft.ts')
const { readWorkspace, runWithWorkspaceAccount, writeWorkspace } = await import('../src/store.ts')
after(() => rmSync(root, { recursive: true, force: true }))

test('选区采纳要求同一文书版本并触发局部重核', () => runWithWorkspaceAccount('rewrite-write@test.invalid', async () => {
  const workspace = await readWorkspace()
  workspace.cases.push({ id: 'case', name: '借款纠纷', status: 'in_review', createdAt: '2026-11-17' })
  workspace.certificates.push({ id: 'doc', caseId: 'case', title: '起诉状', role: 'plaintiff', focus: '', docKey: 'qs', createdAt: '2026-11-17',
    paragraphIds: ['p1', 'p2'], paragraphs: [
      { id: 'p1', text: '被告收到借款100元。', richText: '<p>被告收到借款<strong>100元</strong>。</p>', verified: false },
      { id: 'p2', text: '原告请求偿还借款。', verified: false },
    ] })
  await writeWorkspace(workspace)
  const original = (await readWorkspace()).certificates[0]
  const expectedContent = { text: original.paragraphs[0].text, richText: original.paragraphs[0].richText }
  const patch = { text: '被告已收到借款100元。', richText: '<p>被告没有收到借款180元。</p>', aiOrigin: 'rewrite', expectedContent,
    references: [{ targetId: 'invented-reference', type: 'case', quote: '虚构引文' }] }
  const selected = { start: 0, quote: original.paragraphs[0].text, candidate: patch.text, version: assistantSnapshot(original), confirmed: true }
  const comparison = await readWorkspace()
  comparison.certificates[0].paragraphs[1].text = '原告另行请求偿还本金。'
  await writeWorkspace(comparison)
  await assert.rejects(updateParagraph('doc', 'p1', { ...patch, assistantRewrite: selected }), /文书已变化/)
  const before = (await readWorkspace()).certificates[0]
  assert.equal(before.paragraphs[0].text, expectedContent.text)
  const result = await updateParagraph('doc', 'p1', { ...patch, assistantRewrite: { ...selected, version: assistantSnapshot(before) } })
  assert.equal(result.assistantRecheck, 'complete')
  const updated = (await readWorkspace()).certificates[0]
  assert.equal(updated.paragraphs[0].text, patch.text)
  assert.equal(updated.paragraphs[0].richText, '<p>被告已收到借款<strong>100元</strong>。</p>')
  assert.equal(updated.paragraphs[0].references?.length ?? 0, 0)
  assert.equal(updated.paragraphs[0].aiOrigin, 'rewrite')
  assert.equal(updated.paragraphs[1].text, comparison.certificates[0].paragraphs[1].text)
  assert.ok(updated.verification.declarations.some(item => item.location.paragraphId === 'p1' && item.aiOrigin === 'rewrite'))
  assert.ok(updated.verification.declarations.filter(item => item.location.paragraphId !== 'p1').every(item => item.verdict === 'pending'))
}))
