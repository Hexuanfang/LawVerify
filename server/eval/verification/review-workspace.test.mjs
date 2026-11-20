import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { env } from '../../src/config/env.ts'
import { extractDeclarations } from '../../src/intelligence/verification/extract.ts'
import { profile } from '../../src/intelligence/verification/profile.ts'

const scratch = fileURLToPath(new URL('../../../tmp/', import.meta.url))
mkdirSync(scratch, { recursive: true })
const directory = mkdtempSync(`${scratch}t6-review-workspace-`)
env.WORKSPACE_DATA_DIR = directory
env.KNOWLEDGE_RAG_MODE = 'local'
env.AI_GATEWAY_MODE = 'direct'
const { createApp } = await import('../../src/app.ts')
const { readWorkspace, writeWorkspace, runWithWorkspaceAccount } = await import('../../src/store.ts')
const { documentMaterialKey, recordVerification } = await import('../../src/intelligence/verification/workspace-review.ts')

test('工作区刷新保留包含法条声明的已保存核验结果，原始法源改动后才失效', async t => {
  const account = 'statute-preview@test.invalid'
  const date = '2026-11-19'
  const text = '依照《测试法》第二条。'
  const preview = '第二条 知识文件的展示文本。'
  const original = '已核验的法源文本。'
  const accountWork = fn => runWithWorkspaceAccount(account, fn)
  await accountWork(async () => {
    const workspace = await readWorkspace()
    workspace.cases = [{ id: 'case', name: '核验回归案件', description: '', status: 'draft', createdAt: date }]
    workspace.evidences = []
    workspace.evidenceInsights = []
    workspace.knowledgeCases = []
    workspace.knowledgeStatutes.unshift({ id: 'law', title: '测试法', docType: '法律', version: '2021',
      effectiveStatus: 'effective', issuer: '测试发文机关', publishDate: date, effectiveDate: date, keywords: [],
      articles: [{ id: 'article', documentId: 'law', articleNumber: '第二条', content: original, plainText: original, aliases: [], topicTags: [] }] })
    workspace.knowledgeFiles = [{ id: 'file', title: '测试法', fileName: '测试法.txt', fileExtension: 'txt', mimeType: 'text/plain',
      fileKind: 'text', uploadedAt: date, updatedAt: date, extractionStatus: 'ready', extractedText: preview, summary: '',
      vectorStatus: 'ready', vectorChunkCount: 0, vectorKeywords: [], linkedStatuteIds: ['law'] }]
    const document = { id: 'doc', caseId: 'case', title: '起诉状', createdAt: date, role: 'plaintiff', focus: '', docKey: 'qs',
      paragraphIds: ['p'], paragraphs: [{ id: 'p', text, verified: false }] }
    const declarations = extractDeclarations(document).declarations.map(item => ({ ...item, reason: '引用已定位，待律师核对。' }))
    assert.ok(declarations.some(item => item.type === 'E-LAW'))
    const inputKey = documentMaterialKey(workspace, 'case')
    workspace.certificates = [{ ...document, linkageInputKey: inputKey, linkageStale: false,
      verification: recordVerification(workspace, undefined, {
        version: 1, profileVersion: profile.version, inputKey, docKey: 'qs', classificationRequired: false, declarations,
      }, undefined, 'case') }]
    await writeWorkspace(workspace)
  })
  const server = createApp().app.listen(0, '127.0.0.1')
  t.after(async () => {
    await new Promise(resolve => server.close(resolve))
    rmSync(directory, { recursive: true, force: true })
  })
  await new Promise(resolve => server.once('listening', resolve))
  const read = async () => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/workspace`, { headers: { 'x-workspace-account': account } })
    assert.equal(response.status, 200)
    return (await response.json()).workspace
  }
  const refreshed = await read()
  assert.equal(refreshed.knowledgeStatutes[0].articles[0].content, preview)
  assert.equal(refreshed.certificates[0].linkageStale, false)
  assert.equal(refreshed.certificates[0].verification.declarations[0].reason, '引用已定位，待律师核对。')
  await accountWork(async () => {
    const workspace = await readWorkspace()
    assert.equal(workspace.knowledgeStatutes[0].articles[0].content, original)
    workspace.knowledgeStatutes[0].articles[0].content = '法源已修订。'
    await writeWorkspace(workspace)
  })
  assert.equal((await read()).certificates[0].linkageStale, true)
})

test('生产路由持久化同句逐声明复核，原子保存手工挂源，并允许局部重核重试', async t => {
  const account = 't6-review@test.invalid'
  const text = '2023年3月15日，被告向原告支付借款本金一百元，利息以一百元为基数按年利率10%计算。'
  const paragraph = { id: 'p', text, verified: false, note: '历史整段意见' }
  const certificate = { id: 'doc', caseId: 'case', title: '民事起诉状', createdAt: '2026-11-19', role: 'plaintiff', focus: '',
    docKey: 'qs', paragraphIds: ['p'], paragraphs: [paragraph] }
  const fact = extractDeclarations(certificate).declarations.find(item => item.type === 'E-FACT')
  assert.ok(fact, '夹具应通过生产规则抽取出事实声明')
  const calculation = { ...fact, id: fact.id.replace(/E-FACT$/u, 'E-CALC'), type: 'E-CALC' }
  const evidence = { id: 'e', caseId: 'case', type: 'text', name: '借款凭证', fileName: '凭证.txt', number: 'E01',
    uploadedAt: '2026-11-19', ocrText: text }
  const accountWork = fn => runWithWorkspaceAccount(account, fn)
  let revision
  await accountWork(async () => {
    const workspace = await readWorkspace()
    workspace.cases = [{ id: 'case', name: '受控案件', description: '', status: 'draft', createdAt: '2026-11-19' }]
    workspace.evidences = [evidence]
    workspace.evidenceInsights = []
    workspace.knowledgeStatutes = []
    workspace.knowledgeCases = []
    workspace.certificates = [certificate]
    await writeWorkspace(workspace)
    const persisted = await readWorkspace()
    const target = persisted.certificates[0]
    const key = documentMaterialKey(persisted, 'case')
    target.linkageInputKey = key
    target.verification = recordVerification(persisted, undefined, {
      version: 1, profileVersion: profile.version, inputKey: key, docKey: 'qs', classificationRequired: false,
      declarations: [fact, calculation].map(item => ({ ...item, verdict: 'pending',
        sources: [{ tier: 'l1', id: 'e', name: evidence.name, quote: item.quote, locator: '第 1 页' }],
        checks: { A1: { outcome: 'pass', reason: '已定位' }, A2: { outcome: 'pending', reason: '待人工确认' } },
      })),
    }, undefined, 'case')
    revision = target.verification.revision
    await writeWorkspace(persisted)
  })
  const server = createApp().app.listen(0, '127.0.0.1')
  t.after(async () => {
    await new Promise(resolve => server.close(resolve))
    rmSync(directory, { recursive: true, force: true })
  })
  await new Promise(resolve => server.once('listening', resolve))
  const request = (route, method = 'GET', body, owner = account) => fetch(`http://127.0.0.1:${server.address().port}/api${route}`, {
    method, headers: { 'content-type': 'application/json', 'x-workspace-account': owner },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(8000),
  })
  const patch = body => request('/certificates/doc/paragraphs/p', 'PATCH', body)
  const readDocument = async () => (await (await request('/workspace')).json()).workspace.certificates.find(item => item.id === 'doc')
  const confirmation = { id: randomUUID(), type: 'confirm', declarationId: fact.id, revision, reviewRevision: null, checks: ['A1', 'A2'] }
  const results = await Promise.all([patch({ declarationReview: confirmation }), patch({ declarationReview: confirmation })])
  for (const response of results) assert.equal(response.status, 200, await response.text())
  const note = { id: randomUUID(), type: 'note', declarationId: calculation.id, revision, reviewRevision: null, note: '复算批注' }
  const noted = await patch({ declarationReview: note })
  assert.equal(noted.status, 200, await noted.text())
  let current = await readDocument()
  assert.equal(current.verification.declarations[0].review.decision, 'confirmed')
  assert.equal(current.verification.declarations[1].review.decision, undefined)
  assert.equal(current.verification.declarations[1].review.note, '复算批注')
  assert.equal(current.paragraphs[0].note, '历史整段意见')
  assert.equal(current.verification.audit.filter(item => item.id === confirmation.id).length, 1)
  assert.equal((await request('/certificates/doc/paragraphs/p', 'PATCH', { declarationReview: confirmation }, 'unrelated@test.invalid')).status, 409)

  const manual = { id: randomUUID(), evidenceId: 'e', locator: '第 1 页', quote: fact.quote,
    note: '人工挂靠出处', relation: 'context', sentenceIndex: fact.location.sentenceIndex, sentenceText: text }
  const sourcePatch = { links: [manual], expectedContent: { text, richText: current.paragraphs[0].richText, links: [], references: [] }, declarationReferences: {
    id: randomUUID(), declarationId: fact.id, revision, reviewRevision: confirmation.id, sourceIds: [manual.id],
  } }
  const added = await patch(sourcePatch)
  assert.equal(added.status, 200, await added.text())
  const stale = await patch({ ...sourcePatch, declarationReferences: { ...sourcePatch.declarationReferences, id: randomUUID() } })
  assert.equal(stale.status, 409)
  current = await readDocument()
  assert.deepEqual(current.verification.dirty.declarationIds, [fact.id])
  assert.equal(current.verification.manualReferences[manual.id], fact.id)
  assert.equal(current.verification.declarations[1].review.note, '复算批注')

  const recheck = () => request('/certificates/doc/auto-link/stream?scope=dirty', 'POST').then(response => response.text())
  const changeSource = value => accountWork(async () => {
    const workspace = await readWorkspace()
    workspace.evidences[0].ocrText = value
    await writeWorkspace(workspace)
  })
  const sourceVersion = await accountWork(async () => (await readWorkspace()).evidences[0].ocrText)
  await changeSource('同一文件的材料原文重新解析，现有摘录已变化。')
  assert.match(await recheck(), /event: error/u)
  current = await readDocument()
  assert.deepEqual(current.verification.dirty.declarationIds, [fact.id])
  assert.equal(current.paragraphs[0].links[0].id, manual.id)
  await changeSource(sourceVersion)
  const rechecked = await Promise.all([recheck(), recheck()])
  assert.equal(rechecked.filter(result => /event: done/u.test(result)).length, 1)
  assert.equal(rechecked.filter(result => /event: error/u.test(result)).length, 1)
  current = await readDocument()
  assert.equal(current.verification.dirty, undefined)
  assert.equal(current.paragraphs[0].links[0].id, manual.id)
  assert.equal(current.verification.declarations.find(item => item.id === calculation.id)?.review?.note, '复算批注')
  assert.equal(current.verification.declarations.find(item => item.id === fact.id)?.review, undefined)
  assert.equal((await patch({ declarationReview: { ...confirmation, id: randomUUID() } })).status, 409)

  const oldLaw = '《测试旧法》第一条'
  const legacyQuote = `${oldLaw}载明：‘旧引文’`
  const verifiedText = '《测试新法》第二条：“已核引文”'
  const oldText = `${legacyQuote}，其他正文保持原状。`
  let replacementRevision
  let replacementId
  await accountWork(async () => {
    const workspace = await readWorkspace()
    workspace.knowledgeStatutes = [{ id: 'local-law', title: '测试新法', docType: '法律', version: '2021', effectiveStatus: 'effective',
      issuer: '受控发文机关', publishDate: '2020-12-31', effectiveDate: '2021-01-01', keywords: [],
      sourceProvider: 'npc_flk', sourceDocumentId: 'fixture-test', sourceVerifiedAt: '2026-11-19', sourceUrl: 'https://flk.npc.gov.cn/detail2.html?bbbs=fixture-test',
      articles: [{ id: 'new-article', documentId: 'local-law', articleNumber: '第二条', content: '已核引文', plainText: '已核引文', aliases: [], topicTags: [] }] }]
    const key = documentMaterialKey(workspace, 'case')
    const document = { ...certificate, id: 'suggestion', title: '替代法条', linkageInputKey: key,
      paragraphIds: ['p-suggestion'], paragraphs: [{ id: 'p-suggestion', text: oldText, richText: `<p>${oldText}</p>`, verified: false }] }
    workspace.certificates.push(document)
    await writeWorkspace(workspace)
    const persisted = await readWorkspace()
    const target = persisted.certificates.find(item => item.id === document.id)
    const law = extractDeclarations(target).declarations.find(item => item.type === 'E-LAW')
    replacementId = law.id
    target.verification = recordVerification(persisted, undefined, {
      version: 1, profileVersion: profile.version, inputKey: key, docKey: 'qs', classificationRequired: false,
      declarations: [{ ...law, verdict: 'fail', verifiedText,
        sources: [{ tier: 'l2', id: 'old', name: '测试旧法', quote: '旧引文', locator: '第一条' }],
        verifiedSources: [{ tier: 'l2', id: 'new-article', name: '测试新法', quote: '已核引文', locator: '第二条' }],
      }],
    }, undefined, 'case')
    replacementRevision = target.verification.revision
    await writeWorkspace(persisted)
  })
  const edit = body => request('/certificates/suggestion/paragraphs/p-suggestion', 'PATCH', body)
  const declined = await edit({ declarationReview: { id: randomUUID(), type: 'decline', declarationId: replacementId, revision: replacementRevision, reviewRevision: null } })
  assert.equal(declined.status, 200, await declined.text())
  const readSuggestion = async () => (await (await request('/workspace')).json()).workspace.certificates.find(item => item.id === 'suggestion')
  const original = await readSuggestion()
  assert.equal(original.paragraphs[0].text, oldText)
  const editAction = { id: randomUUID(), type: 'adopt', declarationId: replacementId, revision: replacementRevision,
    reviewRevision: original.verification.declarations[0].review.revision }
  const correct = verifiedText + oldText.slice(legacyQuote.length)
  const editPatch = { text: correct, richText: `<p>${correct}</p>`, expectedContent: { text: oldText, richText: `<p>${oldText}</p>` }, declarationEdit: editAction }
  assert.equal((await edit({ ...editPatch, text: `${verifiedText}错误覆盖整段` })).status, 409)
  const adopted = await edit(editPatch)
  assert.equal(adopted.status, 200, await adopted.text())
  const duplicate = await edit(editPatch)
  assert.equal(duplicate.status, 200, await duplicate.text())
  const updated = await readSuggestion()
  assert.equal(updated.paragraphs[0].text, correct)
  assert.equal(updated.linkageStale, true)
  assert.ok(updated.verification.dirty.declarationIds.includes(replacementId))
  const trail = updated.verification.audit.filter(item => item.id === editAction.id)
  assert.equal(trail.length, 1)
  assert.equal(trail[0].quote, legacyQuote)
  assert.equal(trail[0].sources[0].quote, '旧引文')
})
