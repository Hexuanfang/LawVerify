import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { env } from '../src/config/env.ts'

const directory = mkdtempSync(path.join(os.tmpdir(), 'lawverify-queue-race-'))
env.WORKSPACE_DATA_DIR = directory
env.KNOWLEDGE_RAG_MODE = 'local'
env.CLOUD_API_BASE_URL = 'http://queue-race-test.invalid'
env.LLM_BASE_URL = 'http://queue-race-test.invalid'
env.LLM_API_KEY = 'test-only'
env.LLM_MODEL = 'test-only'

const { readWorkspace, writeWorkspace, runWithWorkspaceAccount } = await import('../src/store.ts')
const { bootstrap, retryCaseAgent } = await import('../src/service.ts')
const { rememberCaseAgentCredential } = await import('../src/case-agent-billing.ts')

const originalFetch = globalThis.fetch
globalThis.fetch = async (input, init = {}) => {
  const url = String(input)
  const body = init.body ? JSON.parse(init.body) : null
  const respond = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
  if (url.endsWith('/profile')) return respond({ data: { user: { email: 'race@test.invalid' } } })
  if (url.endsWith('/points/consume')) return respond({ data: { entry: { id: 'entry-1' }, pointsBalance: 98 } })
  if (url.endsWith('/points/refund')) return respond({ data: {} })
  if (url.endsWith('/chat/completions')) {
    if (String(body.messages?.[0]?.content ?? '').includes('主张或抗辩')) {
      return respond({ choices: [{ message: { content: JSON.stringify({
        summary: '案件背景', parties: [], disputeFocuses: [], claimsAndDefenses: [], disputedFacts: [],
        timeline: [], paymentFlow: [], keyPersons: [], keyAmounts: [], lawyerFocuses: [], evidenceWeaknesses: [],
        proceduralRisks: [], contradictions: [], openQuestions: [], supportMatrix: [],
      }) } }] })
    }
    return respond({ choices: [{ message: { content: JSON.stringify({
      summary: '材料理解结论', keyFacts: ['关键事实'], entities: [], timelineEvents: [], amounts: [],
      positions: [], issues: [], confidence: 0.8,
    }) } }] })
  }
  throw new Error(`Unexpected test request: ${url}`)
}

test('连续读取工作区不会推迟自动理解的执行', async (t) => {
  t.after(() => { globalThis.fetch = originalFetch; rmSync(directory, { recursive: true, force: true }) })
  await runWithWorkspaceAccount('race@test.invalid', async () => {
    rememberCaseAgentCredential('test-only')
    const seed = await readWorkspace()
    seed.cases = [{ id: 'race-case', name: '排队竞态', description: '', createdAt: '2026-11-07', status: 'draft' }]
    seed.evidences = [{
      id: 'race-evidence', caseId: 'race-case', number: 'E01', name: '借条', fileName: '借条.txt',
      relativePath: '借条.txt', type: 'text', ocrText: '借款人张三分期还款共5万元，出具借条一份。',
      contentHash: 'race-hash', summaryStatus: 'idle', uploadedAt: '2026-11-07',
    }]
    seed.evidenceInsights = []
    seed.caseContextMemories = []
    await writeWorkspace(seed)

    await retryCaseAgent('race-case')

    // 前端在后台处理期间会持续读取工作区；每次读取都会把未完成的梳理重新排队。
    // 排队不能重置调度定时器，否则自动理解永远得不到执行。
    const deadline = Date.now() + 8000
    let state = null
    let task = null
    while (Date.now() < deadline) {
      await bootstrap()
      state = await readWorkspace()
      task = state.cases.find(c => c.id === 'race-case')?.agent?.task
      if (task?.status === 'ready' || task?.status === 'failed') break
      await new Promise(resolve => setTimeout(resolve, 60))
    }
    assert.equal(task?.status, 'ready', `自动理解应完成执行，实际 ${task?.status} ${task?.error ?? ''}`)
    const evidence = state.evidences.find(e => e.id === 'race-evidence')
    assert.equal(evidence?.summaryStatus, 'ready', '材料应理解成功')
  })
})

