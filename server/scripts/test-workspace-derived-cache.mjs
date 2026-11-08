import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { env } from '../src/config/env.ts'

const directory = mkdtempSync(path.join(os.tmpdir(), 'lawverify-derived-cache-'))
env.WORKSPACE_DATA_DIR = directory
env.KNOWLEDGE_RAG_MODE = 'local'

const { readWorkspace, writeWorkspace, runWithWorkspaceAccount } = await import('../src/store.ts')

const ACCOUNT = 'derived-cache@test.invalid'

function seed(text) {
  return {
    user: { id: 'user', name: 'test', email: ACCOUNT, phone: '', organization: '', title: '', points: 100, pointLogs: [] },
    cases: [{ id: 'case', name: '派生缓存', description: '', createdAt: '2026-11-07', status: 'draft' }],
    evidences: [{
      id: 'e1', caseId: 'case', number: 'E01', name: '借条', fileName: '借条.txt', type: 'text',
      relativePath: '借条.txt', ocrText: text, uploadedAt: '2026-11-07', summaryStatus: 'idle',
    }],
    evidenceFragments: [],
    evidenceInsights: [],
    caseContextMemories: [],
    draftMemories: [],
    certificates: [{
      id: 'certificate', caseId: 'case', title: '起诉状', role: 'plaintiff', focus: '', createdAt: '2026-11-07',
      paragraphs: [{ id: 'paragraph', text: '原告主张被告欠付货款10万元。', verified: false, references: [] }],
    }],
    claimUnits: [],
    claimEvidenceMatches: [],
    knowledgeCases: [],
    knowledgeFiles: [],
    knowledgeStatutes: [],
    paymentOrders: [],
  }
}

test('派生结果按内容复用，材料原文变化后必须重算', async (t) => {
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  await runWithWorkspaceAccount(ACCOUNT, async () => {
    const initial = await readWorkspace()
    const template = seed('借款人张三分期还款共5万元，出具借条一份。')
    initial.evidences = template.evidences
    initial.certificates = template.certificates
    initial.cases = template.cases
    await writeWorkspace(initial)

    const first = await readWorkspace()
    assert.equal(first.evidenceFragments.length, 1, '材料应切出证据片段')
    assert.match(first.evidenceFragments[0].text, /5万元/)
    const firstFragmentId = first.evidenceFragments[0].id
    const firstMatches = JSON.stringify(first.claimEvidenceMatches)

    // 输入没变：复用上次结果，结果必须完全一致。
    const second = await readWorkspace()
    assert.deepEqual(second.evidenceFragments, first.evidenceFragments, '输入未变时片段应保持一致')
    assert.deepEqual(second.claimUnits, first.claimUnits, '输入未变时主张单元应保持一致')
    assert.equal(JSON.stringify(second.claimEvidenceMatches), firstMatches, '输入未变时证据匹配应保持一致')

    // 段落文本变了：主张单元与匹配必须跟着重算，不能返回过期结果。
    const changed = await readWorkspace()
    changed.certificates = changed.certificates.map((certificate) => ({
      ...certificate,
      paragraphs: certificate.paragraphs.map((paragraph) => ({ ...paragraph, text: '原告主张被告欠付货款50万元。' })),
    }))
    await writeWorkspace(changed)
    const third = await readWorkspace()
    assert.notEqual(JSON.stringify(third.claimUnits), JSON.stringify(first.claimUnits), '段落变化后主张单元必须重算')
    assert.match(third.claimUnits[0].text, /50万元/)

    // 材料原文变了：证据片段必须重算，不能返回旧片段。
    const fourth = await readWorkspace()
    fourth.evidences = fourth.evidences.map((evidence) => ({
      ...evidence,
      ocrText: '借款人李四一次性还款30万元，并出具收据。',
    }))
    await writeWorkspace(fourth)
    const fifth = await readWorkspace()
    assert.match(fifth.evidenceFragments[0].text, /30万元/, '材料原文变化后片段必须重算')
    assert.notEqual(fifth.evidenceFragments[0].text, first.evidenceFragments[0].text)
    assert.equal(firstFragmentId, fifth.evidenceFragments[0].id, '片段标识不应随内容变化')
  })
})

