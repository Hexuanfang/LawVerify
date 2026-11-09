import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { env } from '../src/config/env.ts'

const directory = mkdtempSync(path.join(os.tmpdir(), 'lawverify-evidence-summary-concurrency-'))
env.WORKSPACE_DATA_DIR = directory
env.KNOWLEDGE_RAG_MODE = 'local'
env.CLOUD_API_BASE_URL = 'http://evidence-summary-test.invalid'
env.LLM_BASE_URL = 'http://evidence-summary-test.invalid'
env.LLM_API_KEY = 'test-only'
env.LLM_MODEL = 'test-only'
env.EVIDENCE_SUMMARY_CONCURRENCY = 3
env.EVIDENCE_UNDERSTANDING_LLM_CONCURRENCY = 6

const { createSemaphore } = await import('../src/infrastructure/concurrency.ts')
const { runExclusiveWorkspaceMutation } = await import('../src/infrastructure/workspace-lock.ts')
const { readWorkspace, writeWorkspace, runWithWorkspaceAccount } = await import('../src/store.ts')
const { retryCaseAgent } = await import('../src/service.ts')
const { rememberCaseAgentCredential } = await import('../src/case-agent-billing.ts')

const originalFetch = globalThis.fetch
let activeLlmCalls = 0
let peakLlmCalls = 0
globalThis.fetch = async (input, init = {}) => {
  const url = String(input)
  const body = init.body ? JSON.parse(init.body) : null
  const respond = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
  if (url.endsWith('/profile')) return respond({ data: { user: { email: 'concurrency@test.invalid' } } })
  if (url.endsWith('/points/consume')) return respond({ data: { entry: { id: 'entry-1' }, pointsBalance: 98 } })
  if (url.endsWith('/points/refund')) return respond({ data: {} })
  if (url.endsWith('/chat/completions')) {
    const userMessage = body.messages.find((item) => item.role === 'user')
    let payload = {}
    try {
      payload = JSON.parse(userMessage.content)
    } catch {
      payload = {}
    }
    if (body.messages[0].content.includes('主张或抗辩')) {
      return respond({ choices: [{ message: { content: JSON.stringify({
        summary: '案件背景', parties: [], disputeFocuses: [], claimsAndDefenses: [], disputedFacts: [],
        timeline: [], paymentFlow: [], keyPersons: [], keyAmounts: [], lawyerFocuses: [], evidenceWeaknesses: [],
        proceduralRisks: [], contradictions: [], openQuestions: [], supportMatrix: [],
      }) } }] })
    }
    activeLlmCalls += 1
    peakLlmCalls = Math.max(peakLlmCalls, activeLlmCalls)
    await new Promise((resolve) => setTimeout(resolve, 120))
    activeLlmCalls -= 1
    return respond({ choices: [{ message: { content: JSON.stringify({
      summary: `理解结果:${payload.evidenceName ?? '未知'}`,
      keyFacts: ['关键事实'],
      entities: [],
      timelineEvents: [],
      amounts: [],
      positions: [],
      issues: [],
      confidence: 0.8,
    }) } }] })
  }
  throw new Error(`Unexpected test request: ${url}`)
}

async function waitReady() {
  for (let i = 0; i < 120; i++) {
    const state = await readWorkspace()
    const task = state.cases.find(c => c.id === 'concurrency-case')?.agent?.task
    if (task?.status === 'failed') throw new Error(task.error)
    if (task?.status === 'ready') return state
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Agent did not finish')
}

test('信号量限制并发数且不会死锁', async () => {
  const semaphore = createSemaphore(2)
  let active = 0
  let peak = 0
  const results = await Promise.all(Array.from({ length: 6 }, (_, index) => semaphore.run(async () => {
    active += 1
    peak = Math.max(peak, active)
    await new Promise((resolve) => setTimeout(resolve, 20))
    active -= 1
    return index
  })))
  assert.equal(peak, 2, `信号量并发上限应为 2，实际 ${peak}`)
  assert.deepEqual(results, [0, 1, 2, 3, 4, 5])
})

test('工作区写锁保证并发写入不丢数据', async () => {
  await runWithWorkspaceAccount('lock@test.invalid', async () => {
    const seed = await readWorkspace()
    seed.evidences = []
    await writeWorkspace(seed)
    await Promise.all(Array.from({ length: 8 }, (_, index) => runExclusiveWorkspaceMutation(async () => {
      const state = await readWorkspace()
      state.evidences = [...state.evidences, { id: `e-${index}`, caseId: 'lock-case', number: `E${index}`,
        name: `材料${index}`, fileName: `${index}.txt`, relativePath: `${index}.txt`, type: 'text',
        ocrText: '文本', contentHash: `hash-${index}`, summaryStatus: 'idle', uploadedAt: '2026-11-07' }]
      await writeWorkspace(state)
    })))
    const state = await readWorkspace()
    assert.equal(state.evidences.length, 8, '并发写入后每条记录都应保留')
  })
})

test('自动理解多份材料时并发执行且结果不丢', async (t) => {
  t.after(() => { globalThis.fetch = originalFetch; rmSync(directory, { recursive: true, force: true }) })
  await runWithWorkspaceAccount('concurrency@test.invalid', async () => {
    rememberCaseAgentCredential('test-only')
    const seed = await readWorkspace()
    seed.cases = [{ id: 'concurrency-case', name: '并发测试', description: '', createdAt: '2026-11-07', status: 'draft' }]
    seed.evidences = [
      { id: 'm1', caseId: 'concurrency-case', number: 'E01', name: '合同', fileName: '01_合同.txt',
        relativePath: '01_合同.txt', type: 'text', ocrText: '双方签订买卖合同，货款50万元。', contentHash: 'hash-1',
        summaryStatus: 'idle', uploadedAt: '2026-11-07' },
      { id: 'm2', caseId: 'concurrency-case', number: 'E02', name: '转账凭证', fileName: '02_转账凭证.txt',
        relativePath: '02_转账凭证.txt', type: 'text', ocrText: '张三向李四转账10万元。', contentHash: 'hash-2',
        summaryStatus: 'idle', uploadedAt: '2026-11-07' },
      { id: 'm3', caseId: 'concurrency-case', number: 'E03', name: '聊天记录', fileName: '03_聊天记录.txt',
        relativePath: '03_聊天记录.txt', type: 'text', ocrText: '双方微信沟通确认欠款事实。', contentHash: 'hash-3',
        summaryStatus: 'idle', uploadedAt: '2026-11-07' },
    ]
    seed.evidenceInsights = []
    seed.caseContextMemories = []
    await writeWorkspace(seed)

    await retryCaseAgent('concurrency-case')
    const state = await waitReady()
    const task = state.cases[0].agent.task
    assert.equal(task.status, 'ready')

    assert.ok(peakLlmCalls >= 2, `多份材料应并发理解，实际模型并发峰值 ${peakLlmCalls}`)
    for (const material of state.evidences) {
      assert.equal(material.summaryStatus, 'ready', `${material.name} 应理解成功`)
      assert.match(material.summaryText ?? '', new RegExp(`理解结果:${material.name}`))
    }
    const readyInsights = state.evidenceInsights.filter((item) => item.status === 'ready')
    assert.equal(readyInsights.length, 3, '并发写入不应丢失其它材料的理解结果')
  })
})
