import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { env } from '../src/config/env.ts'
import { fixturePython, useParserWorkerFixture } from './parser-test-fixtures.mjs'

// 删除案件时，案件相关的数据（材料、质证书及其段落引用、案件记忆、起草记忆、材料理解结果）
// 必须一起回收；全局法条库与案例库属于共享知识库，不能被单个案件带走。
// 材料原件文件也要一并删除，避免删除案件后磁盘上还留着证据文件。

const directory = mkdtempSync(path.join(os.tmpdir(), 'lawverify-case-deletion-'))
env.WORKSPACE_DATA_DIR = directory
env.APP_DATA_ROOT = directory
env.KNOWLEDGE_RAG_MODE = 'local'

const { readWorkspace, rememberCaseFile, writeWorkspace, runWithWorkspaceAccount } = await import('../src/store.ts')
const { deleteCase } = await import('../src/service.ts')
const { officePath } = await import('../src/office/files.ts')
const { createApp } = await import('../src/app.ts')
const { ensureEvidenceParsed } = await import('../src/evidence-parsing.ts')
const { closeDocumentParser } = await import('../src/infrastructure/document-jobs.ts')
after(() => { rmSync(directory, { recursive: true, force: true }) })

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

function assetPath(dataUrl) {
  return path.join(path.dirname(workspaceDatabasePath), 'workspace-assets',
    createHash('sha256').update(dataUrl).digest('hex'))
}

function addOfficeFiles(certificate) {
  const id = randomUUID()
  certificate.officeFile = { id, format: 'txt', fileName: '文书.txt', version: 1, sha256: '', contentHash: '', updatedAt: now }
  const files = [officePath(id), officePath(id, 'json')]
  mkdirSync(path.dirname(files[0]), { recursive: true })
  for (const file of files) writeFileSync(file, '文书内容')
  return files
}

function createParsingFile(name) {
  const owner = createHash('sha256').update('deletion@test.invalid').digest('hex')
  const file = path.join(directory, 'parsing', owner, name)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, '解析缓存')
  return file
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

test('删除案件会回收在用和历史文件，并保留其他案件引用的共享文件', async () => {
  await runWithWorkspaceAccount('deletion@test.invalid', async () => {
    const seeded = { ...await readWorkspace(), ...seedWorkspace() }
    const sharedKey = 'evidence/2024-05-01/shared.txt'
    const archivedKey = 'evidence/2024-05-01/archived.txt'
    const otherWorkspaceKey = 'evidence/2024-05-01/other-workspace.txt'
    const legacyOwnerKey = 'evidence/2024-05-01/legacy-owner.txt'
    const pendingOwnerKey = 'evidence/2024-05-01/pending-owner.txt'
    const sharedAsset = 'data:image/png;base64,c2hhcmVk'
    const oldAsset = 'data:image/png;base64,b2xk'
    const currentAsset = 'data:image/png;base64,Y3VycmVudA=='
    const legacyInputKey = 'a'.repeat(64)
    const oldParsing = { status: 'ready', revision: 'aaaa', sourceKey: legacyInputKey, artifactKey: 'aaaa.json', mode: 'auto', updatedAt: now }
    const oldResult = createParsingFile(oldParsing.artifactKey)
    const parsedInput = createParsingFile(`inputs/${legacyInputKey}.png`)
    const currentResult = createParsingFile('bbbb.json')
    const otherResult = createParsingFile('cccc.json')
    seeded.cases[0].agent = { autoAnalyze: false, archivedEvidence: [
      { evidence: { ...seeded.evidences[0], id: 'archived-a', storageKey: archivedKey }, removedAt: now },
      { evidence: { ...seeded.evidences[0], id: 'archived-shared-a', storageKey: sharedKey }, removedAt: now },
      { evidence: { ...seeded.evidences[0], id: 'archived-other-workspace', storageKey: otherWorkspaceKey }, removedAt: now },
      { evidence: { ...seeded.evidences[0], id: 'archived-legacy-workspace', storageKey: legacyOwnerKey }, removedAt: now },
      { evidence: { ...seeded.evidences[0], id: 'archived-pending-owner', storageKey: pendingOwnerKey }, removedAt: now },
      { evidence: { ...seeded.evidences[0], id: 'archived-preview', fileName: 'preview.png',
        storageKey: undefined, previewDataUrl: oldAsset, parsing: oldParsing }, removedAt: now },
    ] }
    seeded.cases[1].agent = { autoAnalyze: false, archivedEvidence: [
      { evidence: { ...seeded.evidences[1], id: 'archived-shared-b', storageKey: sharedKey, previewDataUrl: sharedAsset }, removedAt: now },
    ] }
    seeded.evidences[0].previewDataUrl = oldAsset
    seeded.evidences[0].pageImageDataUrls = [sharedAsset]
    seeded.evidences[0].parsing = oldParsing
    seeded.evidences[1].parsing = { ...oldParsing, revision: 'cccc', artifactKey: 'cccc.json' }
    const oldDocument = addOfficeFiles(seeded.certificates[0])
    const otherDocument = addOfficeFiles(seeded.certificates[1])
    await writeWorkspace(seeded)

    const updated = await readWorkspace()
    updated.evidences[0].previewDataUrl = currentAsset
    updated.evidences[0].parsing = { ...oldParsing, revision: 'bbbb', artifactKey: 'bbbb.json' }
    const currentDocument = addOfficeFiles(updated.certificates[0])
    await writeWorkspace(updated)
    rememberCaseFile('case-b', `evidence:${pendingOwnerKey}`)
    await runWithWorkspaceAccount('other-owner@test.invalid', async () => {
      const other = { ...await readWorkspace(), ...seedWorkspace() }
      other.evidences = [{ ...other.evidences[1], storageKey: otherWorkspaceKey }]
      await writeWorkspace(other)
    })
    const legacyDirectory = path.join(directory, 'workspaces', 'legacy-owner-test-invalid')
    const legacy = { ...seeded, ...seedWorkspace(), user: { ...seeded.user, email: 'legacy-owner@test.invalid' } }
    legacy.evidences = [{ ...legacy.evidences[1], storageKey: legacyOwnerKey }]
    mkdirSync(legacyDirectory, { recursive: true })
    writeFileSync(path.join(legacyDirectory, 'workspace.json'), JSON.stringify(legacy))

    const storedFileA = createStoredEvidenceFile('evidence/2024-05-01/case-a.txt', '甲案原件')
    const storedFileB = createStoredEvidenceFile('evidence/2024-05-01/case-b.txt', '乙案原件')
    const archivedFile = createStoredEvidenceFile(archivedKey, '旧版材料')
    const sharedFile = createStoredEvidenceFile(sharedKey, '共享材料')
    const otherWorkspaceFile = createStoredEvidenceFile(otherWorkspaceKey, '另一工作区引用的材料')
    const legacyOwnerFile = createStoredEvidenceFile(legacyOwnerKey, '待迁移工作区引用的材料')
    const pendingOwnerFile = createStoredEvidenceFile(pendingOwnerKey, '另一案件正在导入的材料')
    assert.equal(existsSync(storedFileA), true, '应准备甲案的材料原件')
    assert.equal(existsSync(storedFileB), true, '应准备乙案的材料原件')

    const before = await readWorkspace()
    assert.equal(before.cases.length, 2, '应准备两个案件')
    assert.equal(before.evidenceInsights.length, 2, '应准备两条材料理解结果')
    assert.equal(countWorkspaceRows('paragraph_references', 'case-a'), 1, '甲案应有一条法条/案例引用')
    assert.equal(countWorkspaceRows('paragraphs', 'case-a'), 1, '甲案应有一个文书段落')
    assert.equal(countWorkspaceRows('paragraph_references', 'case-b'), 1, '乙案应有一条法条/案例引用')

    await deleteCase('case-a')

    // 另一任务可能已经读取了删除前的快照，保存乙案时不应重新写出甲案的缓存。
    before.cases[1].description = '乙案更新'
    await writeWorkspace(before)
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
    assert.equal(after.cases.find(item => item.id === 'case-b').description, '乙案更新')
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
    for (const file of [archivedFile, oldResult, currentResult, parsedInput, assetPath(oldAsset), assetPath(currentAsset), ...currentDocument, ...oldDocument]) {
      assert.equal(existsSync(file), false, `案件文件应移除：${path.basename(file)}`)
    }
    for (const file of [sharedFile, otherWorkspaceFile, legacyOwnerFile, pendingOwnerFile, otherResult, assetPath(sharedAsset), ...otherDocument]) {
      assert.equal(existsSync(file), true, `其他案件引用的文件应保留：${path.basename(file)}`)
    }
  })
})

test('磁盘清理失败后仍能重试删除同一案件的文件', async () => {
  await runWithWorkspaceAccount('retry-deletion@test.invalid', async () => {
    const workspace = { ...await readWorkspace(), ...seedWorkspace() }
    await writeWorkspace(workspace)
    const storageKey = workspace.evidences[0].storageKey
    const blockedFile = path.join(storageRoot, storageKey)
    mkdirSync(blockedFile, { recursive: true })
    await assert.rejects(deleteCase('case-a'), { code: 'CASE_FILE_CLEANUP_FAILED' })
    assert.equal((await readWorkspace()).cases.some(item => item.id === 'case-a'), false)
    rmdirSync(blockedFile)
    createStoredEvidenceFile(storageKey, '甲案原件')
    await deleteCase('case-a')
    assert.equal(existsSync(blockedFile), false)
  })
})

test('已上传但来不及登记为证据的案卷文件也随案清理', async t => {
  const account = 'upload-deletion@test.invalid'
  await runWithWorkspaceAccount(account, async () => {
    const workspace = { ...await readWorkspace(), ...seedWorkspace() }
    workspace.evidences = []
    await writeWorkspace(workspace)
  })
  const server = createApp().app.listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}/api`
  const headers = { 'x-workspace-account': account }
  const form = new FormData()
  form.set('caseId', 'case-a')
  form.append('files', new Blob(['材料内容']), 'evidence.txt')
  form.set('manifest', JSON.stringify([{ fileName: '证据.补充附件' }]))
  const upload = await fetch(`${base}/evidences/assets/upload`, { method: 'POST', headers, body: form })
  assert.equal(upload.status, 200)
  const { assets: [asset] } = await upload.json()
  const file = path.join(storageRoot, asset.storageKey)
  assert.equal(existsSync(file), true)
  const deletion = await fetch(`${base}/cases/case-a`, { method: 'DELETE', headers })
  assert.equal(deletion.status, 200)
  assert.equal(existsSync(file), false)
})

test('删除正在解析的案件会停止本机进程并回收解析临时文件', { timeout: 10000, skip: !fixturePython() }, async () => {
  const account = 'parsing-deletion@test.invalid'
  const previous = { APP_RUNTIME_ROOT: env.APP_RUNTIME_ROOT, LAWVERIFY_PYTHON: env.LAWVERIFY_PYTHON,
    PARSER_BUNDLE_ROOT: env.PARSER_BUNDLE_ROOT }
  await closeDocumentParser()
  useParserWorkerFixture(env, directory)
  try {
    await runWithWorkspaceAccount(account, async () => {
      const workspace = { ...await readWorkspace(), ...seedWorkspace() }
      Object.assign(workspace.evidences[0], { storageKey: undefined, fileName: 'hold-parsing.txt', sourceDataUrl: 'data:text/plain;base64,dGVzdA==' })
      await writeWorkspace(workspace)
      const parsing = ensureEvidenceParsed('ev-a')
      const started = path.join(directory, 'parsing', 'test-worker-running')
      for (let attempt = 0; attempt < 100 && !existsSync(started); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 30))
      }
      assert.ok(existsSync(started), '本机解析进程已收到任务')
      const root = path.join(directory, 'parsing', createHash('sha256').update(account).digest('hex'))
      assert.equal(readdirSync(path.join(root, 'inputs')).length, 1)
      await deleteCase('case-a')
      assert.equal(await parsing, undefined)
      assert.deepEqual(readdirSync(root), ['inputs'])
      assert.deepEqual(readdirSync(path.join(root, 'inputs')), [])
    })
  } finally {
    await closeDocumentParser()
    Object.assign(env, previous)
  }
})
