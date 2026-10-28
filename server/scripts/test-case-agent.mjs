import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { env } from '../src/config/env.ts'
import { evidenceSourceNumber, normalizeStrategy, objectiveInputKey, strategyInputKey } from '../src/intelligence/case-agent.ts'

const directory = mkdtempSync(path.join(os.tmpdir(), 'lawverify-case-agent-'))
env.WORKSPACE_DATA_DIR = directory
env.KNOWLEDGE_RAG_MODE = 'local'
env.CLOUD_API_BASE_URL = 'http://case-agent-test.invalid'
env.LLM_BASE_URL = 'http://case-agent-test.invalid'
env.LLM_API_KEY = 'test-only'
env.LLM_MODEL = 'test-only'
const { readWorkspace, writeWorkspace, runWithWorkspaceAccount } = await import('../src/store.ts')
const { confirmCasePosition, importEvidences, retryCaseAgent, caseAgentMessage, bootstrap, deleteEvidence } = await import('../src/service.ts')
const { rememberCaseAgentCredential, chargedCaseAgentTask, settleCaseAgentRefunds } = await import('../src/case-agent-billing.ts')
const originalFetch = globalThis.fetch
const calls = []
let llmInvalid = false
let refundUnavailable = false
let balanceUnavailable = false
globalThis.fetch = async (input, init = {}) => {
  const url = String(input)
  const body = init.body ? JSON.parse(init.body) : null
  calls.push({ url, body })
  const respond = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
  if (url.includes(':7777')) return respond({})
  if (url.endsWith('/profile')) return respond({ data: { user: { email: 'agent@test.invalid' } } })
  if (url.endsWith('/points/consume')) return balanceUnavailable
    ? respond({ error: { message: '余额不足', code: 'INSUFFICIENT_POINTS' } }, 402)
    : respond({ data: { entry: { id: `entry-${calls.length}` }, pointsBalance: 98 } })
  if (url.endsWith('/points/refund')) return refundUnavailable
    ? respond({ error: { message: 'Unavailable' } }, 503) : respond({ data: {} })
  if (url.endsWith('/chat/completions')) {
    const system = body.messages[0].content
    const payload = JSON.parse(body.messages[1].content)
    if (llmInvalid) return respond({ choices: [{ message: { content: '{}' } }] })
    if (system.includes('待确认的代理立场JSON')) return respond({
      choices: [{ message: { content: JSON.stringify({
        reply: '请确认代理立场。', proposal: { party: '李某', role: 'defendant', goals: ['核减重复计算'], admissions: [], disputes: [], boundaries: [] },
      }) } }],
    })
    if (system.includes('主张或抗辩')) return respond({ choices: [{ message: { content: JSON.stringify({
      summary: `为${payload.position.party}整理思路`,
      claims: [{ claim: '核减已还款', requirements: ['款项对应本案借款'], burden: '还款方举证',
        supportEvidenceIds: ['material'], adverseEvidenceIds: [], gaps: ['补充收款确认'],
        counterargument: '转账系其他交易', response: '结合备注与聊天核验', status: 'needs_evidence' }],
      nextSteps: ['核验转账原件'], warnings: ['不能仅凭流水认定还款'],
    }) } }] })
    return respond({ choices: [{ message: { content: JSON.stringify({
      summary: '存在借款与还款争议', parties: ['张某', '李某'], disputeFocuses: ['还款是否对应借款'],
      claimsAndDefenses: [], disputedFacts: [], timeline: [], paymentFlow: [], keyPersons: [], keyAmounts: [],
      lawyerFocuses: [], evidenceWeaknesses: [], proceduralRisks: [], contradictions: [], openQuestions: [],
      supportMatrix: [{ fact: '存在转账记录', evidenceNumbers: ['E01'] }],
    }) } }] })
  }
  throw new Error(`Unexpected test request: ${url}`)
}

const position = { party: '李某', role: 'defendant', goals: ['核减已还款'], admissions: [], disputes: [], boundaries: [] }
async function waitReady() {
  for (let i = 0; i < 80; i++) {
    const state = await readWorkspace()
    const task = state.cases.find(c => c.id === 'agent-case')?.agent?.task
    if (task?.status === 'failed') throw new Error(task.error)
    if (task?.status === 'ready') return state
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Agent did not finish')
}

test('case agent identity, cache, persistence, billing and position isolation', async t => {
  t.after(() => { globalThis.fetch = originalFetch; rmSync(directory, { recursive: true, force: true }) })
  assert.equal(evidenceSourceNumber('材料/证据十二/合同.pdf'), '证据十二')
  assert.equal(evidenceSourceNumber('材料/03_流水.pdf'), '03')
  assert.equal(evidenceSourceNumber('合同.pdf'), undefined)
  await runWithWorkspaceAccount('agent@test.invalid', async () => {
    rememberCaseAgentCredential('test-only')
    const seed = await readWorkspace()
    seed.cases = [{ id: 'agent-case', name: '借款纠纷', description: '', createdAt: '2026-10-19', status: 'draft' }]
    seed.evidences = [{ id: 'material', caseId: 'agent-case', number: 'E01', name: '流水', fileName: '01_流水.txt',
      relativePath: '01_流水.txt', type: 'text', ocrText: '李某向张某转账1000元。',
      contentHash: 'hash-one', summaryText: '存在转账记录', summaryStatus: 'ready', summaryCacheKey: 'valid', uploadedAt: '2026-10-19' }]
    seed.evidenceInsights = [{ id: 'insight', evidenceId: 'material', caseId: 'agent-case', version: 1,
      summary: '转账记录', keyFacts: ['存在转账记录'], entities: ['李某'], timelineEvents: [], amounts: ['1000元'],
      positions: [], issues: [], materialRole: 'source_evidence', sourceFragmentIds: [], confidence: 0.8,
      status: 'ready', updatedAt: '2026-10-19' }]
    seed.caseContextMemories = []
    await writeWorkspace(seed)
    const reply = await caseAgentMessage('agent-case', '我代理李某，希望核减重复计算。', 'position')
    assert.equal(reply.proposal.party, '李某')
    assert.equal((await readWorkspace()).cases[0].agent.position, undefined, 'proposal must not set position')
    await confirmCasePosition('agent-case', reply.proposal, 0)
    let state = await waitReady()
    assert.equal(state.cases[0].agent.position.role, 'defendant')
    assert.equal(state.cases[0].agent.strategy.positionVersion, 1)
    const memory = structuredClone(state.caseContextMemories)
    const llmCallsBefore = calls.filter(c => c.url.endsWith('/chat/completions')).length
    await retryCaseAgent('agent-case')
    await waitReady()
    assert.equal(calls.filter(c => c.url.endsWith('/chat/completions')).length, llmCallsBefore, 'unchanged rebuild must reuse cache')
    await confirmCasePosition('agent-case', { ...position, party: '张某', role: 'plaintiff', goals: ['请求清偿'] }, 1)
    state = await waitReady()
    assert.deepEqual(state.caseContextMemories, memory, 'switching sides must not rewrite objective facts')
    assert.equal(state.cases[0].agent.strategy.positionVersion, 2)
    assert.match(state.cases[0].agent.strategy.summary, /张某/)
    assert.equal(state.cases[0].agent.positionHistory.length, 1)
    await assert.rejects(confirmCasePosition('agent-case', position, 0), /代理立场已更新/)
    const revision = state.cases[0].agent.task.revision
    await importEvidences({ caseId: 'agent-case', processInBackground: true,
      files: [{ fileName: '01_流水.txt', relativePath: '01_流水.txt', type: 'text', name: '流水', ocrText: 'same', contentHash: 'hash-one' }] })
    assert.equal((await readWorkspace()).cases[0].agent.task.revision, revision)
    llmInvalid = true
    const refundsBefore = calls.filter(c => c.url.endsWith('/points/refund')).length
    await assert.rejects(caseAgentMessage('agent-case', '调整代理目标', 'position'), /未返回完整/)
    assert.equal(calls.filter(c => c.url.endsWith('/points/refund')).length, refundsBefore + 1)
    llmInvalid = false
    balanceUnavailable = true
    let executed = false
    await assert.rejects(chargedCaseAgentTask('agent-case', 'evidence_summary', 'denied', async () => { executed = true }), /余额不足/)
    assert.equal(executed, false)
    balanceUnavailable = false
    await settleCaseAgentRefunds('agent-case')
    refundUnavailable = true
    await assert.rejects(chargedCaseAgentTask('agent-case', 'evidence_summary', 'failed', async () => { throw new Error('failed') }), /退回待处理/)
    assert.ok((await readWorkspace()).cases[0].agent.pendingRefunds.length)
    refundUnavailable = false
    await settleCaseAgentRefunds('agent-case')
    assert.equal((await readWorkspace()).cases[0].agent.pendingRefunds.length, 0)
    assert.ok(calls.filter(c => c.url.endsWith('/points/consume')).every(c => c.body.idempotencyKey.startsWith('case-agent:')))
    const other = await runWithWorkspaceAccount('other@test.invalid', () => readWorkspace())
    assert.equal(other.cases.some(c => c.id === 'agent-case'), false)
    assert.notEqual(strategyInputKey(state.caseContextMemories[0], state.cases[0].agent.position),
      strategyInputKey(state.caseContextMemories[0], { ...state.cases[0].agent.position, party: '李某' }))
    assert.equal(objectiveInputKey(state.evidences, state.evidenceInsights),
      objectiveInputKey([...state.evidences].reverse(), [...state.evidenceInsights].reverse()))
    const normalized = normalizeStrategy({
      summary: 'test', nextSteps: [], warnings: [], claims: [{
        claim: 'unsupported', requirements: [], burden: '', supportEvidenceIds: ['invented', 'material'],
        adverseEvidenceIds: ['other-case'], gaps: [], counterargument: '', response: '', status: 'supported',
      }],
    }, state.evidences, [])
    assert.equal(normalized.claims[0].status, 'needs_evidence')
    assert.deepEqual(normalized.claims[0].supportEvidenceIds, [])
    assert.deepEqual(normalized.claims[0].adverseEvidenceIds, [])
    state.cases[0].agent.task.status = 'processing'
    await writeWorkspace(state)
    await bootstrap()
    await waitReady()
    await deleteEvidence('material')
    state = await waitReady()
    assert.equal(state.evidences.length, 0)
    assert.equal(state.caseContextMemories.length, 0)
    assert.equal(state.cases[0].agent.strategy, undefined)
    assert.equal(state.cases[0].agent.archivedEvidence[0].evidence.id, 'material')
  })
})
