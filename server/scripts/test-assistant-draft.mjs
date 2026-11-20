import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { after, test } from 'node:test'
import { env } from '../src/config/env.ts'

const root = mkdtempSync(path.resolve(import.meta.dirname, '../../tmp/lawverify-assistant-draft-'))
env.WORKSPACE_DATA_DIR = path.join(root, 'data')
env.KNOWLEDGE_RAG_MODE = 'local'
env.DATABASE_URL = undefined
env.LLM_API_KEY = undefined
env.AI_GATEWAY_MODE = 'direct'

const { streamGenerateCertificate } = await import('../src/service.ts')
const { readWorkspace, runWithWorkspaceAccount, writeWorkspace } = await import('../src/store.ts')
const { adoptAssistantCandidate } = await import('../src/assistant/candidates.ts')
const { prepareAssistantDraft } = await import('../src/assistant/draft.ts')
after(() => rmSync(root, { recursive: true, force: true }))

const request = { caseId: 't7-case', docKey: 'zz', evidenceIds: ['t7-material'], role: 'plaintiff', focus: '审阅借款凭据' }

async function setup(confirmed) {
  const state = await readWorkspace()
  state.cases.push({ id: request.caseId, name: '借款纠纷', description: '', status: 'draft', createdAt: '2026-11-17',
    agent: confirmed ? { position: { role: 'plaintiff', version: 1, confirmedAt: '2026-11-17', summary: '支持原告' } } : undefined })
  state.evidences.push({ id: 't7-material', caseId: request.caseId, type: 'image', number: 'E01', name: '借款凭据',
    fileName: '借款凭据.png', summaryText: '被告于2025年1月1日收到借款人民币100元。',
    ocrText: '被告于2025年1月1日收到借款人民币100元。', anchorHint: '原件全文', createdAt: '2026-11-17' })
  await writeWorkspace(state)
}

async function preview() {
  const events = []
  await streamGenerateCertificate(request, event => { events.push(event) }, { preview: {} })
  return events.at(-1)
}

test('起草候选预览不写入，明确采纳后仅保存一份待核文书', () => runWithWorkspaceAccount('draft-ok@test.invalid', async () => {
  await setup(true)
  const done = await preview()
  assert.ok(done.candidateId, '预览应返回待确认候选')
  assert.equal(done.draft.type, 'draft-doc')
  assert.equal(done.draft.docType, 'zz')
  assert.ok(done.draft.items.some(item => item.sources.some(source => source.id === 't7-material')))
  assert.equal((await readWorkspace()).certificates.length, 0, '生成不能自动保存')
  const adopt = { caseId: request.caseId, candidateId: done.candidateId, confirmed: true }
  const results = await Promise.all([adoptAssistantCandidate(adopt), adoptAssistantCandidate(adopt)])
  assert.equal(results[0].certificateId, results[1].certificateId)
  const { certificates } = await readWorkspace()
  assert.equal(certificates.length, 1)
  const certificate = certificates[0]
  assert.equal(certificate.id, results[0].certificateId)
  assert.ok(certificate.paragraphs.every(paragraph => paragraph.aiOrigin === 'draft' && !paragraph.verified))
  assert.ok(certificate.verification.declarations.length)
  assert.ok(certificate.verification.declarations.every(item => item.verdict === 'pending'))
}))

test('起草前拦截空立场，采纳时拦截过期立场', async () => {
  await runWithWorkspaceAccount('draft-unconfirmed@test.invalid', async () => {
    await setup(false)
    await assert.rejects(preview(), /请先确认/)
  })
  await runWithWorkspaceAccount('draft-stale@test.invalid', async () => {
    await setup(true)
    const done = await preview()
    assert.ok(done.candidateId, '预览应返回待确认候选')
    const latest = await readWorkspace()
    latest.cases[0].agent.position.version++
    await writeWorkspace(latest)
    await assert.rejects(adoptAssistantCandidate({ caseId: request.caseId, candidateId: done.candidateId, confirmed: true }), /立场已更新/)
    assert.equal((await readWorkspace()).certificates.length, 0)
  })
})

test('起草只沿用所核法条和裁判的逐字引文，原条号或案号不能给篡改内容补位', () => {
  const law = '《民法典》第五百七十七条'
  const docket = '（2026）京01民终10号'
  const statuteText = '当事人一方不履行合同义务，应当承担违约责任。'
  const holding = '驳回上诉，维持原判。'
  const authority = (type, quote, tier, text) => ({ type, quote, sources: [{ tier, id: tier, name: quote, quote: text,
    url: 'https://example.invalid/details' }], ...(tier === 'l3' && { caseVerification: { citationKind: 'operative' } }) })
  const sources = [authority('E-LAW', law, 'l2', statuteText), authority('E-CASE', docket, 'l3', holding)]
  const certificate = text => ({ id: 'doc', caseId: 'case', docKey: 'qs', paragraphs: [{ id: 'p1', text, verified: false }] })
  const workspace = { evidences: [] }
  assert.throws(() => prepareAssistantDraft(workspace, certificate(`${law}规定：“当事人无需承担违约责任。”`), sources, 'key'), /未经核验/)
  assert.throws(() => prepareAssistantDraft(workspace, certificate(`${docket}判决如下：“撤销原判。”`), sources, 'key'), /未经核验/)
  const accepted = prepareAssistantDraft(workspace, certificate(`${law}规定：“${statuteText}”\n${docket}判决如下：“${holding}”`), sources, 'key')
  assert.deepEqual(accepted.draft.items.filter(item => ['E-LAW', 'E-CASE'].includes(item.type)).map(item => item.sources[0].quote), [statuteText, holding])
})
