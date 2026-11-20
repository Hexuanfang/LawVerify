import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { after, test } from 'node:test'
import { env } from '../src/config/env.ts'

const base = mkdtempSync(path.resolve(import.meta.dirname, '../../tmp/lawverify-assistant-execution-'))
env.WORKSPACE_DATA_DIR = base
env.KNOWLEDGE_RAG_MODE = 'local'
env.DATABASE_URL = undefined

const { executeAssistantSkill, checkAssistantCaseReport } = await import('../src/assistant/execute.ts')
const { assistantMaterialVersion, assistantSnapshot } = await import('../src/assistant/draft.ts')
const { extractDeclarations } = await import('../src/intelligence/verification/extract.ts')
const { profile } = await import('../src/intelligence/verification/profile.ts')
const { adoptAssistantCandidate } = await import('../src/assistant/candidates.ts')
const { readWorkspace, writeWorkspace, runWithWorkspaceAccount } = await import('../src/store.ts')
after(() => rmSync(base, { recursive: true, force: true }))

const target = { caseId: 't7-case', certificateId: 't7-doc' }
const text = '被告已在2025年3月1日收到转账500元。'

async function seed() {
  const state = await readWorkspace()
  state.cases.push({ id: target.caseId, name: '借款纠纷', description: '', status: 'draft', createdAt: '2026-11-17' })
  state.evidences.push({ id: 't7-material', caseId: target.caseId, type: 'image', number: 'E01', name: '转账流水',
    fileName: '转账流水.png', ocrText: text, summaryText: text, anchorHint: '第 1 页', createdAt: '2026-11-17' })
  state.certificates.push({ id: target.certificateId, caseId: target.caseId, title: '民事起诉状', role: 'plaintiff', focus: '', docKey: 'qs',
    createdAt: '2026-11-17', paragraphIds: ['original'], paragraphs: [{ id: 'original', text: '原告请求偿还借款。', verified: false }] })
  await writeWorkspace(state)
}

test('卷内检索空结果无采纳候选，已核摘录只在确认后新增为待核段落', () => runWithWorkspaceAccount('t7-execution@test.invalid', async () => {
  await seed()
  const baseline = await readWorkspace()
  const original = baseline.certificates[0]
  const { declarations } = extractDeclarations(original)
  const priorId = declarations[0].id
  const materialKey = assistantMaterialVersion(baseline, target.caseId)
  original.linkageInputKey = materialKey
  original.verification = { version: 1, profileVersion: profile.version, docKey: 'qs', inputKey: materialKey, classificationRequired: false,
    declarations, revision: 'earlier', dirty: { paragraphIds: ['original'], declarationIds: [priorId] },
    audit: [{ id: 'previous-lawyer-note', action: 'note', actor: 'lawyer@test.invalid', at: '2026-11-17' }] }
  await writeWorkspace(baseline)
  const none = await executeAssistantSkill('inbox-search', { ...target, query: '未收录的内容' })
  assert.deepEqual(none.cards, [])
  const result = await executeAssistantSkill('inbox-search', { ...target, query: '转账500元' })
  const source = result.cards[0]
  assert.equal(source.output.excerpt, text)
  assert.ok(source.candidateId)
  assert.equal((await readWorkspace()).certificates[0].paragraphs.length, 1)
  const adopted = await adoptAssistantCandidate({ ...target, candidateId: source.candidateId, confirmed: true })
  const document = (await readWorkspace()).certificates[0]
  assert.equal(document.paragraphs[0].text, '原告请求偿还借款。')
  assert.equal(document.paragraphs[1].id, adopted.paragraphId)
  assert.equal(document.paragraphs[1].text, source.citationText)
  assert.equal(document.paragraphs[1].aiOrigin, 'citation')
  assert.equal(document.paragraphs[1].links[0].quote, text)
  assert.ok(document.verification.declarations.some(item => item.location.paragraphId === adopted.paragraphId && item.verdict === 'pending'))
  assert.ok(document.verification.audit.some(item => item.id === 'previous-lawyer-note'))
  assert.ok(document.verification.audit.some(item => item.action === 'adopt' && item.paragraphId === adopted.paragraphId))
  assert.ok(document.verification.dirty.declarationIds.includes(priorId))
  assert.ok(document.verification.authorityKey)
}))

test('引用候选不能写入已变化的文书', () => runWithWorkspaceAccount('t7-stale-citation@test.invalid', async () => {
  await seed()
  const result = await executeAssistantSkill('inbox-search', { ...target, query: '转账500元' })
  const latest = await readWorkspace()
  latest.certificates[0].paragraphs[0].text = '文书已有更新。'
  await writeWorkspace(latest)
  await assert.rejects(adoptAssistantCandidate({ ...target, candidateId: result.cards[0].candidateId, confirmed: true }), /文书或来源已变化/)
  assert.equal((await readWorkspace()).certificates[0].paragraphs.length, 1)
}))

test('六项分析执行返回分析卡，且不能跨案件读取文书', () => runWithWorkspaceAccount('t7-analysis@test.invalid', async () => {
  await seed()
  for (const id of ['evidence', 'chain', 'calc', 'risk', 'focus', 'timeline']) {
    const result = await executeAssistantSkill(id, target)
    assert.equal(result.type, 'analysis-card')
    assert.equal(result.candidateId, undefined)
  }
  await assert.rejects(executeAssistantSkill('evidence', { ...target, caseId: 't7-other-case' }), /案件/)
}))

test('助手案例报告导出复核当前文书和报告输出契约', () => runWithWorkspaceAccount('t7-report@test.invalid', async () => {
  await seed()
  const latest = await readWorkspace()
  const document = latest.certificates[0]
  const version = assistantSnapshot([document.docKey, document.officeFile?.version, document.verification,
    document.paragraphs.map(item => [item.id, item.text, item.richText])])
  const report = { type: 'docx-case-report', task: '借款纠纷', overview: '所选案例 1 件', list: [{ title: '裁判样本' }],
    excerpts: [], disclaimer: '仍需核对权威来源。' }
  await checkAssistantCaseReport({ ...target, version, confirmed: true, report })
  await assert.rejects(checkAssistantCaseReport({ ...target, version, confirmed: true, report: { ...report, list: null } }), /list/)
  document.paragraphs[0].text = '文书已有更新。'
  await writeWorkspace(latest)
  await assert.rejects(checkAssistantCaseReport({ ...target, version, confirmed: true, report }), /文书.*更新/)
}))
