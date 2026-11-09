import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { env } from '../src/config/env.ts'

const directory = mkdtempSync(path.join(os.tmpdir(), 'lawverify-incremental-upload-'))
env.WORKSPACE_DATA_DIR = directory
env.KNOWLEDGE_RAG_MODE = 'local'
env.CLOUD_API_BASE_URL = 'http://incremental-upload-test.invalid'
env.LLM_BASE_URL = 'http://incremental-upload-test.invalid'
env.LLM_API_KEY = 'test-only'
env.LLM_MODEL = 'test-only'

const { readWorkspace, writeWorkspace, runWithWorkspaceAccount } = await import('../src/store.ts')
const { importEvidences } = await import('../src/service.ts')
const { rememberCaseAgentCredential } = await import('../src/case-agent-billing.ts')

const calls = []
let currentEmail = 'incremental@test.invalid'
globalThis.fetch = async (input, init = {}) => {
  const url = String(input)
  const body = init.body ? JSON.parse(init.body) : null
  calls.push({ url, body })
  const respond = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
  if (url.endsWith('/profile')) return respond({ data: { user: { email: currentEmail } } })
  if (url.endsWith('/points/consume')) return respond({ data: { entry: { id: `entry-${calls.length}` }, pointsBalance: 98 } })
  if (url.endsWith('/points/refund')) return respond({ data: {} })
  if (url.endsWith('/chat/completions')) {
    if (body.messages[0].content.includes('主张或抗辩')) {
      return respond({ choices: [{ message: { content: JSON.stringify({
        summary: '暂无可用主张', claims: [], nextSteps: [], warnings: [],
      }) } }] })
    }
    return respond({ choices: [{ message: { content: JSON.stringify({
      summary: '案件记忆', parties: [], disputeFocuses: [], claimsAndDefenses: [], disputedFacts: [],
      timeline: [], paymentFlow: [], keyPersons: [], keyAmounts: [], lawyerFocuses: [], evidenceWeaknesses: [],
      proceduralRisks: [], contradictions: [], openQuestions: [], supportMatrix: [],
    }) } }] })
  }
  console.error('unexpected request:', url)
  throw new Error(`Unexpected test request: ${url}`)
}

const evidenceFile = (id, text) => ({
  fileName: `${id}.txt`,
  relativePath: `${id}.txt`,
  name: id,
  type: 'text',
  ocrText: text,
  contentHash: `hash-${id}`,
})

async function waitReady(caseId, attempts = 160) {
  for (let i = 0; i < attempts; i += 1) {
    const state = await readWorkspace()
    const task = state.cases.find(c => c.id === caseId)?.agent?.task
    if (task?.status === 'failed') throw new Error(`${task.error} | requests: ${calls.map(call => call.url).join(', ')}`)
    if (task?.status === 'ready') return state
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Agent did not finish')
}

test('分批上传时每批都进入后台理解，且已理解的材料不会重复消耗模型', async t => {
  t.after(() => { rmSync(directory, { recursive: true, force: true }) })
  await runWithWorkspaceAccount('incremental@test.invalid', async () => {
    rememberCaseAgentCredential('test-only')
    const seed = await readWorkspace()
    seed.cases = [{ id: 'incremental-case', name: '分批上传', description: '', createdAt: '2026-11-08', status: 'draft' }]
    seed.evidences = []
    seed.caseContextMemories = []
    await writeWorkspace(seed)

    // 第一批：分批上传后立即进入后台队列，不再等全部材料传完。
    await importEvidences({
      caseId: 'incremental-case',
      processInBackground: true,
      files: [evidenceFile('batch-one-a', '甲方主张借款十万元。'), evidenceFile('batch-one-b', '乙方否认存在借款事实。')],
    })

    const firstTask = (await readWorkspace()).cases.find(c => c.id === 'incremental-case')?.agent?.task
    assert.equal(firstTask?.status, 'queued', '分批导入后应立即进入理解队列')
    assert.equal(firstTask?.evidenceIds.length, 2, '队列里应只有本批材料')

    const ready = await waitReady('incremental-case')
    assert.equal(ready.cases.find(c => c.id === 'incremental-case')?.agent?.task?.status, 'ready')
    const firstInsights = ready.evidenceInsights.filter(item => item.caseId === 'incremental-case')
    assert.equal(firstInsights.length, 2, '本批两份材料都应完成理解')

    const understandingCallsAfterFirstBatch = calls.filter(call =>
      call.url.endsWith('/chat/completions') && !call.body.messages[0].content.includes('主张或抗辩')).length
    assert.ok(understandingCallsAfterFirstBatch > 0, '第一批材料应触发模型理解')

    // 第二批：新增材料继续走同一条队列。
    await importEvidences({
      caseId: 'incremental-case',
      processInBackground: true,
      files: [evidenceFile('batch-two', '双方于 2024 年 3 月 15 日确认还款十万元。')],
    })
    const secondReady = await waitReady('incremental-case')
    const secondInsights = secondReady.evidenceInsights.filter(item => item.caseId === 'incremental-case')
    assert.equal(secondInsights.length, 3, '第二批材料应追加进案件记忆')
  })
})

test('分批上传期间案件记忆只重建一次，不会每批都调用模型', async t => {
  t.after(() => { rmSync(directory, { recursive: true, force: true }) })
  await runWithWorkspaceAccount('incremental-memory@test.invalid', async () => {
    currentEmail = 'incremental-memory@test.invalid'
    rememberCaseAgentCredential('test-only')
    const seed = await readWorkspace()
    seed.cases = [{ id: 'memory-case', name: '记忆合并', description: '', createdAt: '2026-11-08', status: 'draft' }]
    seed.evidences = []
    seed.caseContextMemories = []
    await writeWorkspace(seed)

    calls.length = 0
    await importEvidences({
      caseId: 'memory-case',
      processInBackground: true,
      files: [evidenceFile('one', '第一份材料内容。'), evidenceFile('two', '第二份材料内容。')],
    })
    await waitReady('memory-case')
    const memoryCalls = calls.filter(call =>
      call.url.endsWith('/chat/completions') && call.body.messages[0].content.includes('案件记忆')).length
    assert.equal(memoryCalls, 1, '连续分批到达的案件记忆只应重建一次')
  })
})
