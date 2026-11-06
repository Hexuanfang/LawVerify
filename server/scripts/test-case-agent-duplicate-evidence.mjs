import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { env } from '../src/config/env.ts'

const directory = mkdtempSync(path.join(os.tmpdir(), 'lawverify-case-agent-duplicate-'))
env.WORKSPACE_DATA_DIR = directory
env.KNOWLEDGE_RAG_MODE = 'local'
env.CLOUD_API_BASE_URL = 'http://case-agent-duplicate-test.invalid'
env.LLM_BASE_URL = 'http://case-agent-duplicate-test.invalid'
env.LLM_API_KEY = 'test-only'
env.LLM_MODEL = 'test-only'

const { readWorkspace, writeWorkspace, runWithWorkspaceAccount } = await import('../src/store.ts')
const { importEvidences } = await import('../src/service.ts')
const { rememberCaseAgentCredential } = await import('../src/case-agent-billing.ts')

const originalFetch = globalThis.fetch
const calls = []
globalThis.fetch = async (input, init = {}) => {
  const url = String(input)
  const body = init.body ? JSON.parse(init.body) : null
  calls.push({ url, body })
  const respond = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
  if (url.endsWith('/profile')) return respond({ data: { user: { email: 'duplicate@test.invalid' } } })
  if (url.endsWith('/points/consume')) return respond({ data: { entry: { id: `entry-${calls.length}` }, pointsBalance: 98 } })
  if (url.endsWith('/points/refund')) return respond({ data: {} })
  if (url.endsWith('/chat/completions')) {
    if (body.messages[0].content.includes('主张或抗辩')) {
      return respond({ choices: [{ message: { content: JSON.stringify({
        summary: '暂无可用主张', claims: [], nextSteps: [], warnings: [],
      }) } }] })
    }
    return respond({ choices: [{ message: { content: JSON.stringify({
      summary: '仅一份有效材料', parties: [], disputeFocuses: [], claimsAndDefenses: [], disputedFacts: [],
      timeline: [], paymentFlow: [], keyPersons: [], keyAmounts: [], lawyerFocuses: [], evidenceWeaknesses: [],
      proceduralRisks: [], contradictions: [], openQuestions: [], supportMatrix: [],
    }) } }] })
  }
  throw new Error(`Unexpected test request: ${url}`)
}

async function waitReady() {
  for (let i = 0; i < 80; i++) {
    const state = await readWorkspace()
    const task = state.cases.find(c => c.id === 'duplicate-case')?.agent?.task
    if (task?.status === 'failed') throw new Error(task.error)
    if (task?.status === 'ready') return state
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Agent did not finish')
}

test('重复文件被标记并跳过理解，不阻断整案梳理', async t => {
  t.after(() => { globalThis.fetch = originalFetch; rmSync(directory, { recursive: true, force: true }) })
  await runWithWorkspaceAccount('duplicate@test.invalid', async () => {
    rememberCaseAgentCredential('test-only')
    const seed = await readWorkspace()
    seed.cases = [{ id: 'duplicate-case', name: '重复测试', description: '', createdAt: '2026-11-06', status: 'draft' }]
    seed.evidences = [{ id: 'origin', caseId: 'duplicate-case', number: 'E01', name: '流水', fileName: '01_流水.txt',
      relativePath: '01_流水.txt', type: 'text', ocrText: '李某向张某转账1000元。', contentHash: 'hash-same',
      summaryText: '存在转账记录', summaryStatus: 'ready', summaryCacheKey: 'valid', uploadedAt: '2026-11-06T01:00:00.000Z' }]
    seed.evidenceInsights = [{ id: 'insight', evidenceId: 'origin', caseId: 'duplicate-case', version: 1,
      summary: '转账记录', keyFacts: ['存在转账记录'], entities: ['李某'], timelineEvents: [], amounts: ['1000元'],
      positions: [], issues: [], materialRole: 'source_evidence', sourceFragmentIds: [], confidence: 0.8,
      status: 'ready', updatedAt: '2026-11-06T01:00:00.000Z' }]
    seed.caseContextMemories = []
    await writeWorkspace(seed)

    const imported = await importEvidences({ caseId: 'duplicate-case', processInBackground: true,
      files: [{ fileName: '01_流水.txt', relativePath: '备份/01_流水.txt', type: 'text', name: '流水（备份）',
        ocrText: '李某向张某转账1000元。', contentHash: 'hash-same' }] })
    const duplicate = imported.workspace.evidences.find(e => e.contentHash === 'hash-same' && e.id !== 'origin')
    assert.ok(duplicate, '重复材料应保留在目录树中')
    assert.equal(duplicate.duplicateOf, 'origin', '重复材料应标记为原文件的副本')
    assert.equal(duplicate.summaryStatus, 'idle', '重复材料不应停留在处理中')

    const state = await waitReady()
    const task = state.cases[0].agent.task
    assert.equal(task.status, 'ready', '重复文件不应让整案梳理失败')
    assert.deepEqual(task.duplicateEvidenceIds, [duplicate.id])
    assert.match(task.stage, /已排除 1 份重复文件/)
    const summaryCharges = calls.filter(c => c.url.endsWith('/points/consume') && c.body.actionType === 'evidence_summary')
    assert.equal(summaryCharges.length, 0, '重复文件不应触发材料理解扣费')
    const skipped = state.evidences.find(e => e.id === duplicate.id)
    assert.equal(skipped.summaryStatus, 'idle', '重复文件不应被送去理解')
    const memory = state.caseContextMemories.find(m => m.caseId === 'duplicate-case')
    assert.ok(memory)
    assert.equal(memory.evidenceInsightIds.length, 1, '重复文件不应进入案件记忆')
  })
})
