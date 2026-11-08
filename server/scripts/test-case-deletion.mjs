import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { env } from '../src/config/env.ts'

// 删除案件时，案件相关的数据（材料、质证书及其段落引用、案件记忆、起草记忆、材料理解结果）
// 必须一起回收；全局法条库与案例库属于共享知识库，不能被单个案件带走。
// 材料原件文件也要一并删除，避免删除案件后磁盘上还留着证据文件。

const directory = mkdtempSync(path.join(os.tmpdir(), 'lawverify-case-deletion-'))
env.WORKSPACE_DATA_DIR = directory
env.APP_DATA_ROOT = directory
env.KNOWLEDGE_RAG_MODE = 'local'

const { readWorkspace, writeWorkspace, runWithWorkspaceAccount } = await import('../src/store.ts')
const { deleteCase } = await import('../src/service.ts')

const now = '2024-05-01T00:00:00.000Z'
const storageRoot = path.join(directory, 'storage')
// 登录态工作区按账号分目录存放，数据库路径跟随账号。
const workspaceDatabasePath = path.join(directory, 'workspaces', 'deletion-test-invalid', 'workspace.sqlite')

function createStoredEvidenceFile(key, content) {
  const fullPath = path.join(storageRoot, key)
  mkdirSync(path.dirname(fullPath), { recursive: true })
  writeFileSync(fullPath, content, 'utf8')
  return fullPath
}

function countWorkspaceRows(table, caseId) {
  const db = new DatabaseSync(workspaceDatabasePath)
  try {
    const row = db.prepare(`SELECT COUNT(*) AS total FROM ${table} WHERE case_id = ?`).get(caseId)
    return Number(row?.total ?? 0)
  } finally {
    db.close()
  }
}

function seedWorkspace() {
  return {
    cases: [
      { id: 'case-a', name: '甲案', description: '', createdAt: now, status: 'draft' },
      { id: 'case-b', name: '乙案', description: '', createdAt: now, status: 'draft' },
    ],
    evidences: [
      { id: 'ev-a', caseId: 'case-a', number: 'E01', name: '甲案借条', type: 'text', fileName: 'a.txt', uploadedAt: now, ocrText: '甲案材料内容', summaryStatus: 'ready', storageKey: 'evidence/2024-05-01/case-a.txt' },
      { id: 'ev-b', caseId: 'case-b', number: 'E01', name: '乙案借条', type: 'text', fileName: 'b.txt', uploadedAt: now, ocrText: '乙案材料内容', summaryStatus: 'ready', storageKey: 'evidence/2024-05-01/case-b.txt' },
    ],
    certificates: [
      {
        id: 'cert-a', caseId: 'case-a', title: '甲案质证书', role: 'plaintiff', focus: '付款事实',
        paragraphIds: ['para-a'],
        paragraphs: [{
          id: 'para-a', text: '甲案主张对方未付款', verified: false,
          references: [{
            id: 'ref-a', type: 'statute', targetId: 'statute-1', sourceTitle: '中华人民共和国民法典',
            label: '第五百七十七条', locator: '第五百七十七条', quote: '当事人一方不履行合同义务或者履行合同义务不符合约定的，应当承担违约责任。',
          }],
        }],
        createdAt: now,
      },
      {
        id: 'cert-b', caseId: 'case-b', title: '乙案质证书', role: 'plaintiff', focus: '交付事实',
        paragraphIds: ['para-b'],
        paragraphs: [{
          id: 'para-b', text: '乙案主张已完成交付', verified: false,
          links: [{ id: 'link-b', evidenceId: 'ev-b', locator: '第 1 段', quote: '乙案材料内容' }],
          references: [{
            id: 'ref-b', type: 'case', targetId: 'kcase-1', sourceTitle: '某买卖合同纠纷案',
            label: '裁判要旨', locator: '二审', quote: '判决支持付款请求',
          }],
        }],
        createdAt: now,
      },
    ],
    evidenceInsights: [
      { id: 'ins-a', caseId: 'case-a', evidenceId: 'ev-a', version: 1, summary: '甲案材料理解结果', keyFacts: [], entities: [], timelineEvents: [], amounts: [], positions: [], issues: [], sourceFragmentIds: [], confidence: 0.9, status: 'ready', updatedAt: now },
      { id: 'ins-b', caseId: 'case-b', evidenceId: 'ev-b', version: 1, summary: '乙案材料理解结果', keyFacts: [], entities: [], timelineEvents: [], amounts: [], positions: [], issues: [], sourceFragmentIds: [], confidence: 0.9, status: 'ready', updatedAt: now },
    ],
    caseContextMemories: [
      { id: 'mem-a', caseId: 'case-a', version: 1, summary: '甲案记忆', parties: [], disputeFocuses: [], claimsAndDefenses: [], disputedFacts: [], timeline: [], paymentFlow: [], keyPersons: [], keyAmounts: [], lawyerFocuses: [], evidenceWeaknesses: [], proceduralRisks: [], contradictions: [], openQuestions: [], supportMatrix: [], evidenceInsightIds: ['ins-a'], updatedAt: now },
      { id: 'mem-b', caseId: 'case-b', version: 1, summary: '乙案记忆', parties: [], disputeFocuses: [], claimsAndDefenses: [], disputedFacts: [], timeline: [], paymentFlow: [], keyPersons: [], keyAmounts: [], lawyerFocuses: [], evidenceWeaknesses: [], proceduralRisks: [], contradictions: [], openQuestions: [], supportMatrix: [], evidenceInsightIds: ['ins-b'], updatedAt: now },
    ],
    draftMemories: [
      { id: 'draft-a', caseId: 'case-a', certificateId: 'cert-a', writingGoal: '起草甲案质证书', usedEvidenceInsightIds: ['ins-a'], paragraphPlans: [{ paragraphId: 'para-a', intent: '主张付款', evidenceNumbers: ['E01'] }], updatedAt: now },
      { id: 'draft-b', caseId: 'case-b', certificateId: 'cert-b', writingGoal: '起草乙案质证书', usedEvidenceInsightIds: ['ins-b'], paragraphPlans: [{ paragraphId: 'para-b', intent: '主张交付', evidenceNumbers: ['E01'] }], updatedAt: now },
    ],
    knowledgeStatutes: [{
      id: 'statute-1', title: '中华人民共和国民法典', docType: '法律', issuer: '全国人民代表大会',
      effectiveStatus: 'effective', effectiveDate: '2021-01-01', publishDate: '2020-05-28', version: '2020',
      keywords: ['合同违约'], articles: [],
    }],
    knowledgeCases: [{
      id: 'kcase-1', title: '某买卖合同纠纷案', caseNumber: '(2023)京01民终123号', courtName: '北京市第一中级人民法院',
      courtLevel: '中级', region: '北京', trialLevel: '二审', caseType: '合同纠纷', cause: '买卖合同纠纷',
      judgmentDate: '2023-08-01', effectiveDate: '2023-08-01', issueSummary: '交付与付款争议',
      holdingSummary: '判决支持付款请求', keyFacts: ['交付凭证'], conclusion: '支持原判', amount: '120000',
      keywords: ['买卖合同'], practiceNotes: ['核对交付凭证'], similarityTags: [],
    }],
  }
}

test('删除案件会回收该案件的全部数据，且不动共享知识库与其他案件', async t => {
  t.after(() => { rmSync(directory, { recursive: true, force: true }) })

  await runWithWorkspaceAccount('deletion@test.invalid', async () => {
    const seeded = await readWorkspace()
    await writeWorkspace({ ...seeded, ...seedWorkspace() })

    const storedFileA = createStoredEvidenceFile('evidence/2024-05-01/case-a.txt', '甲案原件')
    const storedFileB = createStoredEvidenceFile('evidence/2024-05-01/case-b.txt', '乙案原件')
    assert.equal(existsSync(storedFileA), true, '应准备甲案的材料原件')
    assert.equal(existsSync(storedFileB), true, '应准备乙案的材料原件')

    const before = await readWorkspace()
    assert.equal(before.cases.length, 2, '应准备两个案件')
    assert.equal(before.evidenceInsights.length, 2, '应准备两条材料理解结果')
    assert.equal(countWorkspaceRows('paragraph_references', 'case-a'), 1, '甲案应有一条法条/案例引用')
    assert.equal(countWorkspaceRows('paragraphs', 'case-a'), 1, '甲案应有一个文书段落')
    assert.equal(countWorkspaceRows('paragraph_references', 'case-b'), 1, '乙案应有一条法条/案例引用')

    await deleteCase('case-a')

    const after = await readWorkspace()
    assert.equal(after.cases.some(item => item.id === 'case-a'), false, '案件本身应被删除')
    assert.equal(after.evidences.some(item => item.caseId === 'case-a'), false, '案件材料应被删除')
    assert.equal(after.certificates.some(item => item.caseId === 'case-a'), false, '质证书应被删除')
    assert.equal(after.evidenceInsights.some(item => item.caseId === 'case-a'), false, '材料理解结果应被删除')
    assert.equal(after.caseContextMemories.some(item => item.caseId === 'case-a'), false, '案件记忆应被删除')
    assert.equal(after.draftMemories.some(item => item.caseId === 'case-a'), false, '起草记忆应被删除')
    assert.equal(after.evidenceFragments.some(item => item.caseId === 'case-a'), false, '证据片段应被删除')
    assert.equal(after.claimUnits.some(item => item.caseId === 'case-a'), false, '主张拆解应被删除')
    assert.equal(after.claimEvidenceMatches.some(item => item.caseId === 'case-a'), false, '主张与证据匹配应被删除')

    assert.equal(countWorkspaceRows('paragraph_references', 'case-a'), 0, '甲案的法条/案例引用应被回收')
    assert.equal(countWorkspaceRows('paragraphs', 'case-a'), 0, '甲案的文书段落应被回收')
    assert.equal(countWorkspaceRows('evidence_links', 'case-a'), 0, '甲案的证据链接应被回收')
    assert.equal(countWorkspaceRows('certificates', 'case-a'), 0, '甲案的质证书记录应被回收')

    assert.equal(after.cases.some(item => item.id === 'case-b'), true, '其他案件应保留')
    assert.equal(after.evidences.some(item => item.caseId === 'case-b'), true, '其他案件的材料应保留')
    assert.equal(after.certificates.some(item => item.caseId === 'case-b'), true, '其他案件的质证书应保留')
    assert.equal(after.evidenceInsights.some(item => item.caseId === 'case-b'), true, '其他案件的材料理解结果应保留')
    assert.equal(after.caseContextMemories.some(item => item.caseId === 'case-b'), true, '其他案件的案件记忆应保留')
    assert.equal(after.draftMemories.some(item => item.caseId === 'case-b'), true, '其他案件的起草记忆应保留')
    assert.equal(countWorkspaceRows('paragraph_references', 'case-b'), 1, '其他案件的法条/案例引用应保留')
    assert.equal(countWorkspaceRows('paragraphs', 'case-b'), 1, '其他案件的文书段落应保留')

    assert.equal(after.knowledgeStatutes.some(item => item.id === 'statute-1'), true, '全局法条库应保留')
    assert.equal(after.knowledgeCases.some(item => item.id === 'kcase-1'), true, '全局案例库应保留')

    assert.equal(existsSync(storedFileA), false, '被删案件的材料原件应从磁盘移除')
    assert.equal(existsSync(storedFileB), true, '其他案件的材料原件应保留')
  })
})
