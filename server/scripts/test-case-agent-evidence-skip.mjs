import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { env } from '../src/config/env.ts'

const directory = mkdtempSync(path.join(os.tmpdir(), 'lawverify-case-agent-skip-'))
env.WORKSPACE_DATA_DIR = directory
env.KNOWLEDGE_RAG_MODE = 'local'
env.CLOUD_API_BASE_URL = 'http://case-agent-skip-test.invalid'
env.LLM_BASE_URL = 'http://case-agent-skip-test.invalid'
env.LLM_API_KEY = 'test-only'
env.LLM_MODEL = 'test-only'

const { readWorkspace, writeWorkspace, runWithWorkspaceAccount } = await import('../src/store.ts')
const { retryCaseAgent } = await import('../src/service.ts')
const { rememberCaseAgentCredential } = await import('../src/case-agent-billing.ts')

const originalFetch = globalThis.fetch
const calls = []
globalThis.fetch = async (input, init = {}) => {
  const url = String(input)
  const body = init.body ? JSON.parse(init.body) : null
  calls.push({ url, body })
  const respond = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
  if (url.endsWith('/profile')) return respond({ data: { user: { email: 'skip@test.invalid' } } })
  if (url.endsWith('/points/consume')) return respond({ data: { entry: { id: 'entry-1' }, pointsBalance: 98 } })
  if (url.endsWith('/points/refund')) return respond({ data: {} })
  if (url.endsWith('/chat/completions')) {
    if (body.messages[0].content.includes('主张或抗辩')) {
      return respond({ choices: [{ message: { content: JSON.stringify({
        summary: '暂无可用主张', claims: [], nextSteps: [], warnings: [],
      }) } }] })
    }
    return respond({ choices: [{ message: { content: JSON.stringify({
      summary: '仅流水一份材料可读', parties: [], disputeFocuses: [], claimsAndDefenses: [], disputedFacts: [],
      timeline: [], paymentFlow: [], keyPersons: [], keyAmounts: [], lawyerFocuses: [], evidenceWeaknesses: [],
      proceduralRisks: [], contradictions: [], openQuestions: [], supportMatrix: [],
    }) } }] })
  }
  throw new Error(`Unexpected test request: ${url}`)
}

async function waitReady() {
  for (let i = 0; i < 80; i++) {
    const state = await readWorkspace()
    const task = state.cases.find(c => c.id === 'skip-case')?.agent?.task
    if (task?.status === 'failed') throw new Error(task.error)
    if (task?.status === 'ready') return state
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Agent did not finish')
}

test('自动梳理跳过没有文本也没有图片的材料', async t => {
  t.after(() => { globalThis.fetch = originalFetch; rmSync(directory, { recursive: true, force: true }) })
  await runWithWorkspaceAccount('skip@test.invalid', async () => {
    rememberCaseAgentCredential('test-only')
    const seed = await readWorkspace()
    seed.cases = [{ id: 'skip-case', name: '排除测试', description: '', createdAt: '2026-11-05', status: 'draft' }]
    seed.evidences = [
      { id: 'blank', caseId: 'skip-case', number: 'E01', name: '未解析扫描件', fileName: '01_扫描件.txt',
        relativePath: '01_扫描件.txt', type: 'text', ocrText: '', contentHash: 'hash-blank',
        summaryStatus: 'idle', uploadedAt: '2026-11-05' },
      { id: 'ready', caseId: 'skip-case', number: 'E02', name: '流水', fileName: '02_流水.txt',
        relativePath: '02_流水.txt', type: 'text', ocrText: '李某向张某转账1000元。', contentHash: 'hash-ready',
        summaryText: '存在转账记录', summaryStatus: 'ready', summaryCacheKey: 'valid', uploadedAt: '2026-11-05' },
    ]
    seed.evidenceInsights = [{ id: 'insight', evidenceId: 'ready', caseId: 'skip-case', version: 1,
      summary: '转账记录', keyFacts: ['存在转账记录'], entities: ['李某'], timelineEvents: [], amounts: ['1000元'],
      positions: [], issues: [], materialRole: 'source_evidence', sourceFragmentIds: [], confidence: 0.8,
      status: 'ready', updatedAt: '2026-11-05' }]
    seed.caseContextMemories = []
    await writeWorkspace(seed)

    await retryCaseAgent('skip-case')
    const state = await waitReady()
    const task = state.cases[0].agent.task
    assert.equal(task.status, 'ready', '缺少可读内容的材料不应让整案梳理失败')
    assert.deepEqual(task.skippedEvidenceIds, ['blank'])
    assert.match(task.stage, /已跳过 1 份待解析材料/)
    const skipped = state.evidences.find(e => e.id === 'blank')
    assert.equal(skipped.summaryStatus, 'failed')
    assert.match(skipped.summaryError, /尚无可供模型理解的文本或图片原件/)
    const memory = state.caseContextMemories.find(m => m.caseId === 'skip-case')
    assert.ok(memory)
    assert.equal(memory.evidenceInsightIds.includes('insight'), true)
    assert.equal(memory.evidenceInsightIds.length, 1, '被排除的材料不应进入案件记忆')
    assert.ok(calls.some(c => c.url.endsWith('/points/refund')), '理解失败的材料应退回积分')
  })
})
