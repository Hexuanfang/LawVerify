import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { after, test } from 'node:test'
import { env } from '../src/config/env.ts'

const root = mkdtempSync(path.resolve(import.meta.dirname, '../../tmp/lawverify-full-link-'))
env.WORKSPACE_DATA_DIR = path.join(root, 'data')
env.STORAGE_LOCAL_ROOT = path.join(root, 'storage')
env.KNOWLEDGE_RAG_MODE = 'local'
env.DATABASE_URL = undefined
env.AI_GATEWAY_MODE = 'direct'
env.YUANDIAN_API_KEY = undefined
env.CLOUD_API_BASE_URL = 'http://full-link-cloud.invalid'
env.LLM_BASE_URL = 'http://full-link-llm.invalid'
env.LLM_API_KEY = 'test-only'
env.LLM_MODEL = 'test-only'

const { createApp } = await import('../src/app.ts')
const { rememberCaseAgentCredential } = await import('../src/case-agent-billing.ts')
const { autoLinkCertificate } = await import('../src/service.ts')
const { readWorkspace, writeWorkspace, runWithWorkspaceAccount } = await import('../src/store.ts')
const { closeDocumentParser } = await import('../src/infrastructure/document-jobs.ts')

// 只拦截模型与账户服务，其余请求（含本地 HTTP）都走真实链路。
const originalFetch = globalThis.fetch
const modelCalls = []
const officialCasePages = new Map()
let currentParagraphId = ''
let currentAccountEmail = 'full-link@test.invalid'
globalThis.fetch = async (input, init = {}) => {
  const url = String(input)
  if (officialCasePages.has(url)) return new Response(officialCasePages.get(url), { headers: { 'content-type': 'text/html' } })
  if (!url.startsWith('http://full-link-')) {
    return originalFetch(input, init)
  }

  const body = init.body ? JSON.parse(init.body) : null
  modelCalls.push({ url, body })
  const respond = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
  if (url.endsWith('/profile')) return respond({ data: { user: { email: currentAccountEmail } } })
  if (url.endsWith('/points/consume')) return respond({ data: { entry: { id: `entry-${modelCalls.length}` }, pointsBalance: 900 } })
  if (url.endsWith('/points/refund')) return respond({ data: {} })
  if (url.endsWith('/chat/completions')) {
    const prompt = body.messages?.[0]?.content ?? ''
    if (prompt.includes('主张或抗辩')) {
      return respond({ choices: [{ message: { content: JSON.stringify({
        summary: '暂无可用主张', claims: [], nextSteps: [], warnings: [],
      }) } }] })
    }
    if (prompt.includes('法律文书整体理解助手') || prompt.includes('法律文书关联编排助手')) {
      return respond({ choices: [{ message: { content: JSON.stringify(paragraphLinkPlan(body)) } }] })
    }
    return respond({ choices: [{ message: { content: JSON.stringify(insightDraft()) } }] })
  }
  throw new Error(`Unexpected request: ${url}`)
}

// fetch 的 mock 要覆盖整个文件：单个用例结束时恢复会让后续用例打真实网络。
after(async () => {
  globalThis.fetch = originalFetch
  await closeDocumentParser()
  rmSync(root, { recursive: true, force: true })
})

function insightDraft() {
  return {
    summary: '材料显示双方就借款事宜往来并存在还款争议。',
    materialRole: 'source_evidence',
    proofPurposes: ['证明借款关系成立'],
    proofLimitations: ['单方陈述需其他证据印证'],
    disputedPoints: ['借款是否清偿存在争议'],
    keyFacts: ['借款金额十万元', '未签字盖章', '约定送达地址为被告住所地'],
    entities: ['张某', '李某'],
    timelineEvents: ['2024年3月15日确认还款'],
    amounts: ['100000元'],
    positions: [],
    issues: [],
    confidence: 0.82,
    keyExcerpts: [{ quote: '借款金额十万元', significance: '确认本金', pageNumber: 1 }],
  }
}

function paragraphLinkPlan(body) {
  // 从请求里取出本批要分析的段落 ID，逐段给出可解析的联动结果。
  const userMessage = body.messages?.find((message) => message.role === 'user')?.content ?? '{}'
  let paragraphIds = []
  const texts = new Map()
  try {
    const payload = JSON.parse(userMessage)
    paragraphIds = (payload.paragraphs ?? []).map((item) => item.paragraphId).filter(Boolean)
    for (const item of payload.paragraphs ?? []) texts.set(item.paragraphId, item.text)
  } catch {
    paragraphIds = currentParagraphId ? [currentParagraphId] : []
  }

  return {
    paragraphs: paragraphIds.map((paragraphId) => ({
      paragraphId,
      paragraphSummary: '原告主张借款事实并要求偿还本息。',
      declarationCandidates: /双方分歧在于交货(?:地点|期限)/u.test(texts.get(paragraphId) ?? '')
        ? [{ sentenceIndex: 1, type: 'E-FOCUS', quote: texts.get(paragraphId).match(/双方分歧在于交货(?:地点|期限)/u)[0] },
          { sentenceIndex: 1, type: 'E-FOCUS', quote: '模型添加的争议焦点' },
          { sentenceIndex: 1, type: 'E-FACT', quote: '双方分歧在于交货地点', nature: 'opinion' }]
        : [],
      legalIssues: ['借款是否成立', '是否已清偿'],
      sentenceFocus: [0, 1, 2].map((sentenceIndex) => ({
        sentenceIndex,
        kind: 'fact',
        priority: 'high',
        reason: '关键事实需要材料核验',
        evidenceNeeded: true,
        statuteNeeded: false,
        caseNeeded: false,
      })),
      evidenceLinks: [{
        evidenceNumber: 'E01',
        sentenceIndex: 0,
        reason: '材料直接记载了借款事实',
        relation: 'support',
        quoteHint: '借款金额十万元',
      }],
      statuteIntents: [],
      caseIntents: [],
    })),
  }
}

function pdfFixture(pages = 4, marker = '', graphicsOnly = false) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${3 + i * 2} 0 R`).join(' ')}] /Count ${pages} >>`,
  ]
  for (let i = 0; i < pages; i += 1) {
    // 扫描件只有图形没有文字：提取不到文本层，只能走视觉理解。
    const body = graphicsOnly
      ? '0 0 120 160 re f'
      : i === 0
        ? `BT /F1 14 Tf 30 120 Td (Borrow contract amount 100000 yuan ${marker}) Tj ET`
        : `BT /F1 14 Tf 30 120 Td (Page ${i + 1} schedule and notes ${marker}) Tj ET`
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 ${3 + pages * 2} 0 R >> >> /Contents ${4 + i * 2} 0 R >>`)
    objects.push(`<< /Length ${body.length} >>\nstream\n${body}\nendstream`)
  }
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  let output = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(output))
    output += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = Buffer.byteLength(output)
  output += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`
  for (const offset of offsets.slice(1)) output += `${String(offset).padStart(10, '0')} 00000 n \n`
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  return Buffer.from(output)
}

test('全链路：建案 → 上传 → 理解 → 导入文书 → 证据联动 → 增量材料', async t => {
  const server = createApp().app.listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  t.after(async () => { await new Promise(resolve => server.close(resolve)) })
  const base = `http://127.0.0.1:${server.address().port}`
  const account = 'full-link@test.invalid'
  const headers = { 'x-workspace-account': account, 'x-case-agent-token': 'test-only' }
  rememberCaseAgentCredential('test-only')

  const post = async (url, body) => {
    const response = await fetch(`${base}${url}`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const text = await response.text()
    assert.equal(response.status, 200, `${url} 失败：${text.slice(0, 300)}`)
    return JSON.parse(text)
  }

  // 1. 建案件
  const created = await post('/api/cases', { name: '全链路测试', description: '借款纠纷' })
  const caseId = created.workspace.cases[0].id
  assert.ok(caseId)

  // 2. 上传原件：一份带文本层的 PDF，一份大文本，验证落盘与哈希。
  const pdf = pdfFixture(4)
  const largeText = Buffer.from([
    '借条复印件一份，原件未随卷提交。',
    '末页未签字未盖章。',
    '双方约定送达地址为被告住所地。',
    '本页为与争议无关的会议安排与通知事项的记录。'.repeat(2000),
  ].join('\n'))
  const form = new FormData()
  form.append('files', new Blob([pdf], { type: 'application/pdf' }), '借条.pdf')
  form.append('files', new Blob([largeText], { type: 'text/plain' }), '流水.txt')
  form.append('manifest', JSON.stringify([
    { fileName: '借条.pdf', relativePath: '借条.pdf' },
    { fileName: '流水.txt', relativePath: '流水.txt' },
  ]))
  const upload = await fetch(`${base}/api/evidences/assets/upload`, { method: 'POST', headers, body: form })
  const uploadText = await upload.text()
  assert.equal(upload.status, 200, uploadText.slice(0, 300))
  const { assets } = JSON.parse(uploadText)
  assert.equal(assets.length, 2)
  assert.ok(assets[0].contentHash && assets[1].contentHash, '上传必须带回内容哈希')

  // 3. 导入材料并进入后台理解
  const imported = await post('/api/evidences/import', {
    caseId,
    processInBackground: true,
    files: assets.map((asset, index) => ({
      ...asset,
      name: index === 0 ? '借条' : '流水',
      type: index === 0 ? 'pdf' : 'text',
      ocrText: '',
    })),
  })
  const createdCount = imported.workspace.evidences.filter((item) => item.caseId === caseId).length
  assert.equal(createdCount, 2, '两份材料都应入库')

  // 4. 等待后台理解完成
  let workspace = imported.workspace
  for (let attempt = 0; attempt < 600; attempt += 1) {
    workspace = (await (await fetch(`${base}/api/workspace`, { headers })).json()).workspace
    const task = workspace.cases.find((item) => item.id === caseId)?.agent?.task
    if (task?.status === 'failed') throw new Error(task.error)
    if (task?.status === 'ready' && workspace.evidences.filter(item => item.caseId === caseId)
      .every(item => item.parsing?.status === 'ready' && item.summaryStatus === 'ready')) break
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  const task = workspace.cases.find((item) => item.id === caseId)?.agent?.task
  assert.equal(task?.status, 'ready', `案件梳理未完成：${task?.stage ?? ''}`)
  const insights = workspace.evidenceInsights.filter((item) => item.caseId === caseId)
  assert.equal(insights.length, 2, '两份材料都应产出理解记忆')
  const pdfEvidenceId = workspace.evidences.find((e) => e.caseId === caseId && e.type === 'pdf')?.id
  const pdfInsight = insights.find((item) => item.evidenceId === pdfEvidenceId)
  assert.ok(pdfInsight?.keyFacts?.length, 'PDF 材料应有提炼出的关键事实')
  const textEvidenceId = workspace.evidences.find((e) => e.caseId === caseId && e.type === 'text')?.id
  const textInsight = insights.find((item) => item.evidenceId === textEvidenceId)
  assert.ok(textInsight?.risks?.length, '中文材料应给出程序与形式风险')
  assert.ok(textInsight.risks.some((risk) => risk.kind === 'original-missing'), '应识别出原件缺失')
  assert.ok(textInsight.risks.some((risk) => risk.kind === 'delivery-address'), '应识别出送达地址')
  assert.ok(workspace.caseContextMemories.some((item) => item.caseId === caseId), '案件记忆应已重建')

  // 5. 导入文书
  const content = [
    '一、原告主张与被告于 2024 年 3 月 15 日签订借款合同，借款金额十万元。',
    '二、借款到期后，经多次催告，被告至今未清偿本息。',
    '三、双方在合同中约定送达地址为被告住所地。',
  ].join('\n')
  const certificate = await post('/api/certificates/import', {
    caseId,
    title: '起诉状',
    content,
    sourceFileName: '起诉状.txt',
  })
  const certificateId = certificate.workspace.certificates[0].id
  assert.ok(certificateId)
  const paragraphId = certificate.workspace.certificates[0].paragraphs[0].id

  // 联动分析要用到真实段落 ID：把模型返回的段落 ID 换成真实值。
  currentParagraphId = paragraphId

  // 6. 证据联动
  const linkResponse = await fetch(`${base}/api/certificates/${certificateId}/auto-link/stream`, { method: 'POST', headers })
  const linkText = await linkResponse.text()
  assert.equal(linkResponse.status, 200, linkText.slice(0, 300))
  assert.match(linkText, /event: done/, '联动应正常结束')
  assert.match(linkText, /"linkedParagraphCount"/, '联动结果应包含统计信息')

  const afterLink = (await (await fetch(`${base}/api/workspace`, { headers })).json()).workspace
  const linkedCertificate = afterLink.certificates.find((item) => item.id === certificateId)
  const linkedParagraph = linkedCertificate.paragraphs.find((item) => item.id === paragraphId)
  assert.ok(linkedParagraph?.links?.length, '联动后段落应挂上材料引用')
  assert.equal(linkedParagraph.links[0].evidenceId.startsWith('evidence'), true)
  assert.ok(linkedCertificate.linkageInputKey, '联动应记录材料指纹')
  assert.equal(linkedCertificate.linkageStale, false, '材料没变时联动结果不应标记过期')
  // 7. 增量上传新材料后，联动结果应被标记为过期
  const extraForm = new FormData()
  extraForm.append('files', new Blob([Buffer.from('新增材料：2024 年 5 月 6 日收到还款十万元。')], { type: 'text/plain' }), '还款.txt')
  extraForm.append('manifest', JSON.stringify([{ fileName: '还款.txt', relativePath: '还款.txt' }]))
  const extraUpload = await fetch(`${base}/api/evidences/assets/upload`, { method: 'POST', headers, body: extraForm })
  const extraAssets = (await extraUpload.json()).assets
  await post('/api/evidences/import', {
    caseId,
    processInBackground: true,
    files: [{ ...extraAssets[0], name: '还款', type: 'text', ocrText: '' }],
  })
  const afterExtra = (await (await fetch(`${base}/api/workspace`, { headers })).json()).workspace
  const staleCertificate = afterExtra.certificates.find((item) => item.id === certificateId)
  assert.equal(staleCertificate.linkageStale, true, '新增材料后联动结果应提示已过时')
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const current = (await (await fetch(`${base}/api/workspace`, { headers })).json()).workspace
    const task = current.cases.find(item => item.id === caseId)?.agent?.task
    if (task?.status === 'failed') throw new Error(task.error)
    const extra = current.evidences.find(item => item.caseId === caseId && item.fileName === '还款.txt')
    if (task?.status === 'ready' && extra?.parsing?.status === 'ready' && extra.summaryStatus === 'ready') {
      assert.ok(current.evidenceInsights.some(item => item.evidenceId === extra.id))
      assert.equal(current.evidences.find(item => item.id === pdfEvidenceId)?.parsing?.revision,
        workspace.evidences.find(item => item.id === pdfEvidenceId)?.parsing?.revision, '新增材料应复用旧材料解析结果')
      break
    }
    assert.ok(attempt < 599, '增量材料应完成解析与理解')
    await new Promise(resolve => setTimeout(resolve, 200))
  }

  // 8. 原件下载走流，内容与上传一致
  const pdfEvidence = afterExtra.evidences.find((item) => item.caseId === caseId && item.type === 'pdf')
  const source = await fetch(`${base}/api/evidences/${pdfEvidence.id}/source`, { headers })
  assert.equal(source.status, 200)
  const downloaded = Buffer.from(await source.arrayBuffer())
  assert.deepEqual(downloaded, pdf, '原件下载内容应与上传一致')
})

test('T2 核验入口：多类型候选、旧人工链接、正文修改及重核', async context => {
  const account = 'full-link-t2@test.invalid'
  const issue = '双方分歧在于交货地点'
  const text = `被告已经支付借款金额十万元。${issue}。`
  const legacyLink = { evidenceId: 't2-payment', locator: '原件全文', quote: '借款金额十万元', sentenceIndex: 0,
    sentenceText: '被告已经支付借款金额十万元。', relation: 'support', note: '人工核对旧链接' }
  await runWithWorkspaceAccount(account, async () => {
    const workspace = await readWorkspace()
    workspace.cases.push({ id: 't2-case', name: 'T2 受控案件', description: '借款纠纷', status: 'draft', createdAt: new Date().toISOString() })
    workspace.evidences.push({ id: legacyLink.evidenceId, caseId: 't2-case', number: 'E01', name: '付款凭证', fileName: '付款凭证.txt',
      type: 'text', ocrText: '借款金额十万元。', anchorHint: '原件全文', uploadedAt: new Date().toISOString() })
    workspace.certificates.push({ id: 't2-doc', caseId: 't2-case', title: '民事起诉状', docKey: 'qs', role: 'plaintiff', focus: '',
      paragraphIds: ['t2-p'], paragraphs: [{ id: 't2-p', text, verified: false, link: legacyLink }], createdAt: new Date().toISOString() })
    await writeWorkspace(workspace)
  })
  const server = createApp().app.listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  context.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`
  const headers = { 'x-workspace-account': account, 'content-type': 'application/json' }
  const readDocument = async () => (await (await fetch(`${base}/api/workspace`, { headers })).json()).workspace.certificates.find(item => item.id === 't2-doc')
  const verify = async sourceText => {
    const response = await fetch(`${base}/api/certificates/t2-doc/auto-link/stream`, { method: 'POST', headers })
    const eventStream = await response.text()
    assert.match(eventStream, /event: done/, eventStream.slice(-1200))
    const document = await readDocument()
    const { declarations } = document.verification
    for (const item of declarations) assert.equal(sourceText.slice(item.location.start, item.location.end), item.quote)
    assert.ok(declarations.every(item => !item.quote.includes('模型添加')))
    assert.equal(document.paragraphs[0].links[0].note, legacyLink.note)
    return declarations.filter(item => item.type === 'E-FOCUS')
  }

  assert.deepEqual((await verify(text)).map(item => [item.quote, item.location.sentenceIndex]), [[issue, 1]])
  const revisedText = text.replace('交货地点', '交货期限')
  const current = (await readDocument()).paragraphs[0]
  const edited = await fetch(`${base}/api/certificates/t2-doc/paragraphs/t2-p`, {
    method: 'PATCH', headers, body: JSON.stringify({ text: revisedText, expectedContent: { text: current.text, richText: current.richText } }),
  })
  const editedBody = await edited.text()
  assert.equal(edited.status, 200, editedBody)
  assert.equal((await readDocument()).linkageStale, true)
  assert.deepEqual((await verify(revisedText)).map(item => [item.quote, item.location.sentenceIndex]), [['双方分歧在于交货期限', 1]])
})

test('T3 核验入口：替换原始凭证后旧人工链接返回 L0', async () => {
  const caseId = 't3-case'
  const documentId = 't3-document'
  const evidenceId = 't3-payment'
  const quote = '被告已支付第2期利息35,000元。'
  const link = { evidenceId, locator: '第 1 段', quote, sentenceIndex: 0, sentenceText: quote, relation: 'support', note: '人工核对旧链接' }
  const date = new Date().toISOString()
  await runWithWorkspaceAccount('full-link-t3@test.invalid', async () => {
    const workspace = await readWorkspace()
    workspace.cases.push({ id: caseId, name: 'T3 受控案件', description: '', status: 'draft', createdAt: date })
    workspace.evidences.push({ id: evidenceId, caseId, number: 'E01', name: '付款凭证', fileName: '付款凭证.txt',
      type: 'text', ocrText: quote, anchorHint: link.locator, sourceFingerprint: 'current', uploadedAt: date })
    workspace.certificates.push({ id: documentId, caseId, title: '民事起诉状', docKey: 'qs', role: 'plaintiff', focus: '', createdAt: date,
      paragraphIds: ['t3-p'], paragraphs: [{ id: 't3-p', text: quote, link, verified: true }] })
    await writeWorkspace(workspace)
    const verify = async () => {
      const result = await autoLinkCertificate(documentId)
      const document = result.workspace.certificates.find(item => item.id === documentId)
      return document.verification.declarations.find(item => item.type === 'E-FACT')
    }
    const current = await verify()
    assert.equal(current.sources[0]?.version, 'current')
    const revised = await readWorkspace()
    revised.evidences = revised.evidences.map(item => item.id === evidenceId
      ? { ...item, ocrText: '被告已支付第3期利息35,000元。', sourceFingerprint: 'replacement' } : item)
    await writeWorkspace(revised)
    const expired = await verify()
    assert.equal(expired.verdict, 'miss')
    assert.deepEqual(expired.sources, [])
  })
})

test('T3 核验入口：漏列诊断与结构化复算随文书写入并读回', async () => {
  const caseId = 't3-snapshot-case'
  const catalogId = 't3-catalog'
  const balanceId = 't3-balance'
  const date = new Date().toISOString()
  const settlement = '货款总额576,000元，累计已付货款200,000元。'
  const claim = '被告仅支付货款200,000元，尚欠376,000元。'
  await runWithWorkspaceAccount('full-link-t3-snapshot@test.invalid', async () => {
    const workspace = await readWorkspace()
    workspace.cases.push({ id: caseId, name: 'T3 清单和结算', description: '', status: 'draft', createdAt: date })
    const materials = [
      { id: 'settlement', name: '结算单', ocrText: settlement, materialRole: 'source_evidence' },
      { id: 'identity', name: '原告身份证', ocrText: '居民身份证', materialRole: 'identity' },
    ]
    for (const [index, material] of materials.entries()) {
      const { id, name, ocrText, materialRole } = material
      workspace.evidences.push({ id, name, ocrText, caseId, number: `E0${index + 1}`, type: 'text',
        fileName: `${name}.txt`, sourceFingerprint: 'original', uploadedAt: date, summaryStatus: 'ready' })
      workspace.evidenceInsights.push({ id: `insight-${id}`, evidenceId: id, caseId, version: 1, summary: name,
        keyFacts: [], entities: [], timelineEvents: [], amounts: [], positions: [], issues: [], sourceFragmentIds: [],
        materialRole, confidence: 1, status: 'ready', updatedAt: date })
    }
    const common = { caseId, role: 'plaintiff', focus: '', createdAt: date }
    workspace.certificates.push(
      { ...common, id: catalogId, title: '证据清单', docKey: 'zj', paragraphIds: ['p-catalog'],
        paragraphs: [{ id: 'p-catalog', text: '结算单', verified: true }] },
      { ...common, id: balanceId, title: '民事起诉状', docKey: 'qs', paragraphIds: ['p-balance'],
        paragraphs: [{ id: 'p-balance', text: claim, verified: true, link: { evidenceId: 'settlement', quote: settlement,
          locator: '第 1 段', sentenceIndex: 0, sentenceText: claim, relation: 'support' } }] },
    )
    await writeWorkspace(workspace)
    await autoLinkCertificate(catalogId)
    await autoLinkCertificate(balanceId)
    const persisted = await readWorkspace()
    const catalog = persisted.certificates.find(item => item.id === catalogId).verification
    assert.deepEqual(catalog.declarations.map(({ type, verdict }) => [type, verdict]), [['E-EVID', 'pass']])
    assert.deepEqual(catalog.documentDiagnostics[0].sources.map(({ id, locator, version }) => [id, locator, version]),
      [['identity', '第 1 段', 'original']])
    const balance = persisted.certificates.find(item => item.id === balanceId).verification.declarations.find(item => item.type === 'E-CALC')
    assert.equal(balance.calculation.kind, 'trade-balance')
    assert.equal(balance.calculation.amount, 376000)
    assert.equal(balance.calculation.sources[0].version, 'original')
  })
})

test('T4 核验入口：只关联有原文的详情并持久化引文差异和效力时点', async context => {
  const account = 'full-link-t4@test.invalid'
  const createdAt = '2025-01-01T00:00:00.000Z'
  const provision = '借款人应当按照约定的期限返还借款。'
  const text = '2023年3月15日交付借款，依据《受控核验法》第１条之二第２款：“借款人应当按照约定的期限归还借款。”'
  const placeholder = '依据《受控核验法》第三条。'
  await runWithWorkspaceAccount(account, async () => {
    const workspace = await readWorkspace()
    workspace.cases.push({ id: 't4-case', name: 'T4 受控案件', description: '', status: 'draft', createdAt })
    workspace.knowledgeStatutes.push({ id: 't4-law', title: '受控核验法', docType: '法律', issuer: '受控发布机关',
      effectiveStatus: 'effective', effectiveDate: '2020-01-01', publishDate: '2019-01-01', version: '2020',
      sourceProvider: 'npc_flk', sourceDocumentId: 't4-fixture', sourceUrl: 'https://flk.npc.gov.cn/detail2.html?bbbs=t4-fixture',
      sourceVerifiedAt: createdAt, keywords: [], articles: [
        { id: 't4-article', documentId: 't4-law', articleNumber: '第一条之二', clauseNumber: '第二款', content: provision, plainText: provision, aliases: [], topicTags: [] },
        { id: 't4-placeholder', documentId: 't4-law', articleNumber: '第三条', content: '官方原文已定位', plainText: '官方原文已定位', aliases: [], topicTags: [] },
      ] })
    workspace.certificates.push({ id: 't4-doc', caseId: 't4-case', title: '民事起诉状', docKey: 'qs', role: 'plaintiff', focus: '', createdAt,
      paragraphIds: ['t4-p', 't4-p2'], paragraphs: [{ id: 't4-p', text, verified: false }, { id: 't4-p2', text: placeholder, verified: false }] })
    await writeWorkspace(workspace)
  })
  const server = createApp().app.listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  context.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`
  const headers = { 'x-workspace-account': account, 'content-type': 'application/json' }
  const response = await fetch(`${base}/api/certificates/t4-doc/auto-link/stream`, { method: 'POST', headers })
  const events = await response.text()
  assert.match(events, /event: done/u, events.slice(-1200))
  const { workspace } = await (await fetch(`${base}/api/workspace`, { headers })).json()
  const document = workspace.certificates.find(item => item.id === 't4-doc')
  assert.ok(document.verification.declarations.every(item => item.quote !== '”'), '单个结束引号不能生成需要核验的事实')
  const [altered, missing] = document.verification.declarations.filter(item => item.type === 'E-LAW')
  assert.equal(altered.quote, '《受控核验法》第１条之二第２款')
  assert.equal(altered.verdict, 'fail')
  assert.equal(altered.checks.B1.outcome, 'pass')
  assert.equal(altered.checks.B3.outcome, 'fail')
  assert.equal(altered.differences[0].source, provision)
  assert.equal(altered.statuteVerification.factDate, '2023-03-15')
  assert.equal(altered.statuteVerification.validity, 'VALID')
  assert.equal(altered.statuteVerification.official.checkedAt, createdAt)
  assert.equal(missing.checks.B1.outcome, 'miss')
  assert.deepEqual(missing.sources, [])

  await runWithWorkspaceAccount(account, async () => {
    const changed = await readWorkspace()
    const law = changed.knowledgeStatutes.find(item => item.id === 't4-law')
    law.version = 'new-version-during-linkage'
    let update
    await assert.rejects(autoLinkCertificate('t4-doc', progress => {
      if (progress.startsWith('正在保存联动结果')) update = writeWorkspace(changed)
    }), error => error.code === 'WORKSPACE_CONFLICT' && /法源/u.test(error.message))
    await update
    const snapshot = await readWorkspace()
    assert.equal(snapshot.knowledgeStatutes.find(item => item.id === 't4-law').version, 'new-version-during-linkage')
    assert.equal(snapshot.certificates.find(item => item.id === 't4-doc').verification.declarations.find(item => item.type === 'E-LAW').sources[0].version, '2020')
  })
})

test('T5 核验入口：读取官方详情后保存 L3 定位，摘要不得冒充判项', async context => {
  const account = 'full-link-t5@test.invalid'
  const createdAt = '2025-01-01T00:00:00.000Z'
  const number = '（2023）京01民终617号'
  const missingNumber = '（2023）京01民终618号'
  const court = '北京市第一中级人民法院'
  const terminal = '驳回上诉，维持原判。'
  const key = 'https://www.court.gov.cn/lawverify-t5-fixture/judgment-617'
  const badKey = 'https://www.court.gov.cn/lawverify-t5-fixture/search-618'
  officialCasePages.set(key, `<article><p>案件名称：借款合同纠纷二审案</p><p>案件类型：普通案例</p><p>案由：民间借贷纠纷</p>
    <p>${court}</p><p>民事判决书</p><p>${number}</p>
    <p>本院认为：本案争议焦点是借贷关系是否成立。出借人提交借条原件及银行转账凭证，借款人确认收款。出借人应承担举证责任。</p>
    <p>判决如下：${terminal}</p><p>本判决为终审判决。</p><p>审判长 某甲</p><p>二〇二三年五月十七日</p></article>`)
  officialCasePages.set(badKey, `<article><h1>检索摘要</h1><p>${missingNumber}</p><p>${terminal}</p></article>`)
  await runWithWorkspaceAccount(account, async () => {
    const workspace = await readWorkspace()
    workspace.cases.push({ id: 't5-case', name: 'T5 受控案件', description: '', status: 'draft', createdAt })
    for (const [id, caseNumber, sourceUrl] of [['t5-detail', number, key], ['t5-summary', missingNumber, badKey]]) {
      workspace.knowledgeCases.push({ id, title: '借款合同纠纷二审案', caseNumber, courtName: court, judgmentDate: '2023-05-17',
        sourceUrl, sourceType: 'fixture', courtLevel: '中院', region: '北京', trialLevel: '二审', caseType: '民事', cause: '民间借贷',
        effectiveDate: '', issueSummary: '', holdingSummary: terminal, reasoningSummary: '', resultSummary: '',
        keywords: [], focusTags: [], referencedStatutes: [], excerpts: [] })
    }
    const paragraphs = [
      { id: 't5-facts', text: '民间借贷纠纷中，出借人向借款人交付借条原件并完成银行转账。争议焦点是借贷关系是否成立，适用出借人举证规则。', verified: false },
      { id: 't5-verified', text: `参照${number}判项原文：“${terminal}”`, verified: false },
      { id: 't5-index', text: `参照${missingNumber}判项原文：“${terminal}”`, verified: false },
    ]
    workspace.certificates.push({ id: 't5-doc', caseId: 't5-case', title: '民事上诉状', docKey: 'ss', role: 'plaintiff', focus: '',
      createdAt, paragraphs, paragraphIds: paragraphs.map(item => item.id) })
    await writeWorkspace(workspace)
  })
  const server = createApp().app.listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  context.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`
  const headers = { 'x-workspace-account': account, 'content-type': 'application/json' }
  const response = await fetch(`${base}/api/certificates/t5-doc/auto-link/stream`, { method: 'POST', headers })
  const events = await response.text()
  assert.match(events, /event: done/u, events.slice(-1200))
  const { workspace } = await (await fetch(`${base}/api/workspace`, { headers })).json()
  const document = workspace.certificates.find(item => item.id === 't5-doc')
  const [verified, missing] = document.verification.declarations.filter(item => item.type === 'E-CASE')
  assert.equal(verified.checks.C1.outcome, 'pass')
  assert.equal(verified.checks.C2.outcome, 'pass')
  assert.equal(verified.checks.C3.outcome, 'pass')
  assert.equal(verified.caseVerification.provider, 'official-case-page')
  assert.equal(verified.caseVerification.allowCitation, true)
  assert.deepEqual(verified.sources.map(({ tier, locator, quote }) => [tier, locator, quote]), [['l3', '判决如下', terminal]])
  assert.equal(missing.checks.C1.outcome, 'miss')
  assert.deepEqual(missing.sources, [])
  const { paragraphElements } = await import('../../app/src/redesign/model.ts')
  const elements = document.paragraphs.flatMap(paragraph => paragraphElements(paragraph, workspace, document.id))
  const { caseCitations } = await import('../../app/src/redesign/caseResearchReport.ts')
  const reportCases = caseCitations(elements, workspace.knowledgeCases)
  assert.deepEqual(reportCases.map(row => [row.verification.caseNumber, row.documents[0].url, row.citations[0].source.quote]),
    [[number, key, terminal]])
  const { wordExportReadiness } = await import('../../app/src/redesign/workflow.ts')
  assert.equal(wordExportReadiness(workspace, document.id).allowed, false)
  const { exportCertificateToWord } = await import('../../app/src/export-word.ts')
  for (const mode of ['review', 'clean']) {
    await assert.rejects(exportCertificateToWord(workspace, document.id, { appVersion: 'fixture', options: { mode } }), /请处理后再导出/u)
  }
})

test('T6 核验入口：完整冻结文书导入、级联、保存和局部重核', async t => {
  const account = 'full-link-t6@test.invalid'
  const createdAt = '2026-11-19T00:00:00.000Z'
  const caseId = 't6-case'
  const documents = JSON.parse(readFileSync(new URL('../eval/verification/fixtures/seed/documents.json', import.meta.url), 'utf8'))
  const [complaint, opinion] = ['c1-qs', 'c1-dlc'].map(id => documents.find(item => item.id === id))
  const source = JSON.parse(readFileSync(new URL('../eval/verification/fixtures/statute-details.json', import.meta.url), 'utf8'))
  const judgment = JSON.parse(readFileSync(new URL('../eval/verification/fixtures/case-details.json', import.meta.url), 'utf8')).seed
  const caseUrl = 'https://www.court.gov.cn/lawverify-t6-fixture/judgment'
  const court = '北京市第一中级人民法院'
  const judgmentBody = judgment.body.replace('\n判决如下', '裁判援引《中华人民共和国合同法》第一百零七条。\n判决如下')
  officialCasePages.set(caseUrl, `<article><p>案件名称：${judgment.name}</p><p>案件类型：普通案例</p><p>案由：${judgment.cause}</p>
    <p>裁判日期：2021年6月10日</p>${judgmentBody.split('\n').map(line => `<p>${line}</p>`).join('')}</article>`)

  await runWithWorkspaceAccount(account, async () => {
    const workspace = await readWorkspace()
    workspace.cases = [{ id: caseId, name: 'T6 冻结核验案件', description: '', status: 'draft', createdAt }]
    workspace.knowledgeStatutes = [[source.old], [source.replacement, source.definition, {
      ...source.replacement, id: 't6-civil-675', article_number: '第六百七十五条',
      text: '借款人应当按照约定的期限返还借款。',
    }]].map((articles, index) => ({
      id: `t6-law-${index}`, title: articles[0].law_name, docType: '法律', issuer: '受控发布机关', keywords: [],
      effectiveStatus: index ? 'effective' : 'repealed', effectiveDate: articles[0].effective_date, publishDate: articles[0].effective_date,
      ...(index === 0 && { repealDate: source.old.repeal_date }), version: index ? '2021' : '1999', sourceProvider: 'npc_flk',
      sourceDocumentId: `t6-fixture-${index}`, sourceUrl: articles[0].url, sourceVerifiedAt: articles[0].checked_at,
      articles: articles.map(item => ({ id: item.id, documentId: `t6-law-${index}`, articleNumber: item.article_number,
        content: item.text, plainText: item.text, aliases: [], topicTags: [] })),
    }))
    workspace.knowledgeCases = [{ id: 't6-judgment', title: judgment.name, caseNumber: judgment.case_number,
      courtName: court, judgmentDate: judgment.judgment_date, sourceUrl: caseUrl, sourceType: 'fixture', courtLevel: '中院',
      region: '北京', trialLevel: '二审', caseType: '民事', cause: judgment.cause, effectiveDate: '', issueSummary: '',
      holdingSummary: '', reasoningSummary: '', resultSummary: '', keywords: [], focusTags: [], referencedStatutes: [], excerpts: [] }]
    await writeWorkspace(workspace)
  })
  const server = createApp().app.listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}/api`
  const headers = { 'x-workspace-account': account, 'content-type': 'application/json' }
  const request = (route, method = 'GET', body) => fetch(`${base}${route}`, { method, headers,
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000) })
  const scan = async (id, scope = '') => {
    const response = await request(`/certificates/${id}/auto-link/stream${scope}`, 'POST')
    const events = await response.text()
    assert.match(events, /event: done/u, events.slice(-1600))
    return readDocument(id)
  }
  const readDocument = async id => (await (await request('/workspace')).json()).workspace.certificates.find(item => item.id === id)
  const importFrozen = async seed => {
    const response = await request('/certificates/import', 'POST', { caseId, title: seed.title, docKey: seed.docKey,
      content: seed.paragraphs.join('\n\n'), sourceFileName: `${seed.id}.txt` })
    const imported = await response.json()
    assert.equal(response.status, 200, JSON.stringify(imported.error ?? {}))
    const document = imported.certificate
    assert.deepEqual(document.paragraphs.map(item => item.text), seed.paragraphs)
    return scan(document.id)
  }
  const at = (document, type, index) => document.verification.declarations.filter(item => item.type === type && item.location.paragraphIndex === index)
  const dependsOn = (item, code, facts) => item.dependencies?.some(edge => edge.check === code && facts.some(fact => fact.id === edge.id))
  const original = await importFrozen(complaint)
  const q1 = at(original, 'E-FACT', 1)
  const [q6] = at(original, 'E-LAW', 6)
  const [q7] = at(original, 'E-CASE', 7)
  assert.ok(q1.length && q6 && q7)
  assert.equal(q6.checks.B4.outcome, 'pending')
  assert.ok(dependsOn(q6, 'B4', q1), 'q6 应记录跨段事实 q1')
  assert.ok(dependsOn(q7, 'C4', q1), 'q7 应记录跨段事实 q1')
  assert.notEqual(q7.caseVerification.match, 'strict')

  const snapshots = original.paragraphs.map(({ id, text, richText }) => ({ id, text, richText }))
  const edited = snapshots.map((paragraph, index) => index === 1 ? { id: paragraph.id, text: paragraph.text.replaceAll('500,000', '510,000') } : paragraph)
  const saved = await request(`/certificates/${original.id}/content`, 'PUT', { paragraphs: edited, expectedContent: snapshots })
  assert.equal(saved.status, 200, await saved.text())
  const dirty = await readDocument(original.id)
  assert.ok(dirty.verification.dirty.declarationIds.includes(q6.id))
  assert.ok(dirty.verification.dirty.declarationIds.includes(q7.id))
  const rechecked = await scan(original.id, '?scope=dirty')
  assert.equal(rechecked.paragraphs[1].text, edited[1].text)
  assert.equal(rechecked.verification.dirty, undefined)
  assert.ok(rechecked.verification.audit.at(-1).affected.includes(q6.id))
  assert.ok(rechecked.verification.audit.at(-1).affected.includes(q7.id))

  const argumentsDocument = await importFrozen(opinion)
  const [l4] = at(argumentsDocument, 'E-LAW', 3)
  const [l3] = at(argumentsDocument, 'E-CASE', 2)
  assert.equal(l4.statuteVerification.validity, 'REPEALED')
  assert.notEqual(l4.checks.B2.outcome, 'pass')
  assert.deepEqual(l3.caseVerification.referencedStatutes, [l4.quote])
  assert.ok(dependsOn(l3, 'C6', [l4]), 'l3 应记录旧法 l4 的效力依赖')
  assert.notEqual(l3.checks.C6.outcome, 'pass')
})

test('全链路：超大文件按落盘接入，多页 PDF 走检索式理解，分批上传即入队', async t => {
  const server = createApp().app.listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  t.after(async () => { await new Promise(resolve => server.close(resolve)) })
  const base = `http://127.0.0.1:${server.address().port}`
  const headers = { 'x-workspace-account': 'full-link-scale@test.invalid', 'x-case-agent-token': 'test-only' }
  currentAccountEmail = 'full-link-scale@test.invalid'
  rememberCaseAgentCredential('test-only')
  // 把检索阈值调小，让多页 PDF 在测试里也能走检索式理解路径。
  env.EVIDENCE_RETRIEVAL_PAGE_THRESHOLD = 5

  const post = async (url, body) => {
    const response = await fetch(`${base}${url}`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const text = await response.text()
    assert.equal(response.status, 200, `${url} 失败：${text.slice(0, 300)}`)
    return JSON.parse(text)
  }

  const created = await post('/api/cases', { name: '大体量链路', description: '规模化接入' })
  const caseId = created.workspace.cases[0].id

  // 1. 超过旧上限（100MB）的原件必须能接进来。
  const oversized = Buffer.alloc(120 * 1024 * 1024, 7)
  oversized.write('贷款合同编号 LX-2024-001，借款金额人民币 500000 元。', 0, 'utf8')
  const bigForm = new FormData()
  bigForm.append('files', new Blob([oversized], { type: 'application/octet-stream' }), '大件.bin')
  bigForm.append('manifest', JSON.stringify([{ fileName: '大件.bin', relativePath: '大件.bin' }]))
  const bigUpload = await fetch(`${base}/api/evidences/assets/upload`, { method: 'POST', headers, body: bigForm })
  const bigUploadText = await bigUpload.text()
  assert.equal(bigUpload.status, 200, `超大文件上传失败：${bigUploadText.slice(0, 200)}`)
  const bigAssets = JSON.parse(bigUploadText).assets
  assert.equal(bigAssets[0].contentHash.length, 64, '超大文件也要算出内容哈希')

  // 2. 多页 PDF 分批上传，每批立即入队。
  const pageCount = 24
  for (let batch = 0; batch < 2; batch += 1) {
    const form = new FormData()
    const name = `卷宗-${batch}.pdf`
    // 两份 PDF 内容必须不同：内容相同的材料会被判定为重复而跳过理解。
    form.append('files', new Blob([pdfFixture(pageCount, `batch-${batch}`)], { type: 'application/pdf' }), name)
    form.append('manifest', JSON.stringify([{ fileName: name, relativePath: name }]))
    const upload = await fetch(`${base}/api/evidences/assets/upload`, { method: 'POST', headers, body: form })
    assert.equal(upload.status, 200)
    const assets = (await upload.json()).assets
    const imported = await post('/api/evidences/import', {
      caseId,
      processInBackground: true,
      files: [{ ...assets[0], name, type: 'pdf', ocrText: '' }],
    })
    const task = imported.workspace.cases.find((item) => item.id === caseId)?.agent?.task
    assert.equal(task?.status, 'queued', '每批上传后都应立即进入后台队列')
  }

  // 3. 等待理解完成，检查检索式覆盖与页数。
  let workspace = null
  for (let attempt = 0; attempt < 600; attempt += 1) {
    workspace = (await (await fetch(`${base}/api/workspace`, { headers })).json()).workspace
    const task = workspace.cases.find((item) => item.id === caseId)?.agent?.task
    if (task?.status === 'failed') throw new Error(task.error)
    if (task?.status === 'ready' && workspace.evidences.filter(item => item.caseId === caseId)
      .every(item => item.parsing?.status === 'ready' && item.summaryStatus === 'ready')) break
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  const task = workspace.cases.find((item) => item.id === caseId)?.agent?.task
  assert.equal(task?.status, 'ready', `大体量案件梳理未完成：${task?.stage ?? ''}`)

  const pdfEvidences = workspace.evidences.filter((item) => item.caseId === caseId && item.type === 'pdf')
  assert.equal(pdfEvidences.length, 2)
  assert.ok(pdfEvidences.every((item) => item.pages === pageCount),
    `PDF 页数应被正确解析：实际 ${pdfEvidences.map((item) => item.pages).join(',')}，材料状态 ${workspace.evidences.filter((e) => e.caseId === caseId).map((e) => `${e.fileName}:${e.summaryStatus}:${e.summaryError ?? ''}`).join(' | ')}`)
  const pdfInsights = workspace.evidenceInsights.filter((item) => pdfEvidences.some((e) => e.id === item.evidenceId))
  assert.equal(pdfInsights.length, 2)
  assert.ok(pdfInsights.every((item) => item.coverage?.mode === 'retrieval'),
    `超过阈值的材料应走检索式理解：${JSON.stringify(pdfInsights.map((item) => ({ coverage: item.coverage, issues: item.issues })))}`)
  assert.ok(pdfInsights.every((item) => item.coverage.coveredChunks > 0 && item.coverage.totalChunks > 0), '覆盖情况应被记录')
  assert.ok(pdfInsights.some((item) => item.issues.some((issue) => issue.includes('未逐块理解'))), '应说明只理解了命中块')
})

test('全链路：未识别到正文的扫描件先审核，确认后走文本理解', async t => {
  const server = createApp().app.listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  t.after(async () => { await new Promise(resolve => server.close(resolve)) })
  const base = `http://127.0.0.1:${server.address().port}`
  const headers = { 'x-workspace-account': 'full-link-scan@test.invalid', 'x-case-agent-token': 'test-only' }
  currentAccountEmail = 'full-link-scan@test.invalid'

  const post = async (url, body) => {
    const response = await fetch(`${base}${url}`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const text = await response.text()
    assert.equal(response.status, 200, `${url} 失败：${text.slice(0, 300)}`)
    return JSON.parse(text)
  }

  const created = await post('/api/cases', { name: '扫描件链路', description: '视觉理解' })
  const caseId = created.workspace.cases[0].id

  const form = new FormData()
  form.append('files', new Blob([pdfFixture(8, 'scanned', true)], { type: 'application/pdf' }), '扫描件.pdf')
  form.append('manifest', JSON.stringify([{ fileName: '扫描件.pdf', relativePath: '扫描件.pdf' }]))
  const upload = await fetch(`${base}/api/evidences/assets/upload`, { method: 'POST', headers, body: form })
  const assets = JSON.parse(await upload.text()).assets
  await post('/api/evidences/import', {
    caseId,
    processInBackground: true,
    files: [{ ...assets[0], name: '扫描件', type: 'pdf', ocrText: '' }],
  })

  let workspace = null
  for (let attempt = 0; attempt < 600; attempt += 1) {
    workspace = (await (await fetch(`${base}/api/workspace`, { headers })).json()).workspace
    const task = workspace.cases.find((item) => item.id === caseId)?.agent?.task
    if (task?.status === 'failed') throw new Error(task.error)
    if (['ready', 'review_required', 'failed'].includes(workspace.evidences.find(item => item.caseId === caseId)?.parsing?.status)) break
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  const scannedEvidence = workspace.evidences.find((item) => item.caseId === caseId)
  assert.equal(scannedEvidence.parsing?.status, 'review_required')
  assert.equal(scannedEvidence.ocrText.trim(), '', '图片编码不能当作已识别正文')
  assert.equal(workspace.evidenceInsights.filter(item => item.caseId === caseId).length, 0)
  const callOffset = modelCalls.length
  await post(`/api/evidences/${scannedEvidence.id}/parsing/review`, {
    revision: scannedEvidence.parsing.revision, text: '人工核对原件，借款金额十万元，尚未归还。',
  })
  for (let attempt = 0; attempt < 600; attempt += 1) {
    workspace = (await (await fetch(`${base}/api/workspace`, { headers })).json()).workspace
    const task = workspace.cases.find(item => item.id === caseId)?.agent?.task
    if (task?.status === 'failed') throw new Error(task.error)
    if (task?.status === 'ready' && workspace.evidences.find(item => item.id === scannedEvidence.id)?.summaryStatus === 'ready') break
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  assert.equal(workspace.evidences.find(item => item.id === scannedEvidence.id)?.summaryStatus, 'ready')
  assert.ok(workspace.evidenceInsights.some(item => item.evidenceId === scannedEvidence.id))
  assert.ok(modelCalls.slice(callOffset).some(call => JSON.stringify(call.body).includes('人工核对原件')))
  assert.ok(modelCalls.slice(callOffset).every(call => !JSON.stringify(call.body).includes('image_url')))
})
