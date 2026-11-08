import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { env } from '../src/config/env.ts'

const root = mkdtempSync(path.join(os.tmpdir(), 'lawverify-full-link-'))
env.WORKSPACE_DATA_DIR = path.join(root, 'data')
env.STORAGE_LOCAL_ROOT = path.join(root, 'storage')
env.KNOWLEDGE_RAG_MODE = 'local'
env.DATABASE_URL = undefined
env.AI_GATEWAY_MODE = 'direct'
env.CLOUD_API_BASE_URL = 'http://full-link-cloud.invalid'
env.LLM_BASE_URL = 'http://full-link-llm.invalid'
env.LLM_API_KEY = 'test-only'
env.LLM_MODEL = 'test-only'

const { createApp } = await import('../src/app.ts')
const { rememberCaseAgentCredential } = await import('../src/case-agent-billing.ts')

// 只拦截模型与账户服务，其余请求（含本地 HTTP）都走真实链路。
const originalFetch = globalThis.fetch
const modelCalls = []
let currentParagraphId = ''
let currentAccountEmail = 'full-link@test.invalid'
globalThis.fetch = async (input, init = {}) => {
  const url = String(input)
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
after(() => { globalThis.fetch = originalFetch })

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
  try {
    const payload = JSON.parse(userMessage)
    paragraphIds = (payload.paragraphs ?? []).map((item) => item.paragraphId).filter(Boolean)
  } catch {
    paragraphIds = currentParagraphId ? [currentParagraphId] : []
  }

  return {
    paragraphs: paragraphIds.map((paragraphId) => ({
      paragraphId,
      paragraphSummary: '原告主张借款事实并要求偿还本息。',
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
  t.after(() => { rmSync(root, { recursive: true, force: true }) })
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
  for (let attempt = 0; attempt < 120; attempt += 1) {
    workspace = (await (await fetch(`${base}/api/workspace`, { headers })).json()).workspace
    const task = workspace.cases.find((item) => item.id === caseId)?.agent?.task
    if (task?.status === 'failed') throw new Error(task.error)
    if (task?.status === 'ready') break
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

  // 8. 原件下载走流，内容与上传一致
  const pdfEvidence = afterExtra.evidences.find((item) => item.caseId === caseId && item.type === 'pdf')
  const source = await fetch(`${base}/api/evidences/${pdfEvidence.id}/source`, { headers })
  assert.equal(source.status, 200)
  const downloaded = Buffer.from(await source.arrayBuffer())
  assert.deepEqual(downloaded, pdf, '原件下载内容应与上传一致')
})

test('全链路：超大文件按落盘接入，多页 PDF 走检索式理解，分批上传即入队', async t => {
  t.after(() => { rmSync(root, { recursive: true, force: true }) })
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
  for (let attempt = 0; attempt < 200; attempt += 1) {
    workspace = (await (await fetch(`${base}/api/workspace`, { headers })).json()).workspace
    const task = workspace.cases.find((item) => item.id === caseId)?.agent?.task
    if (task?.status === 'failed') throw new Error(task.error)
    if (task?.status === 'ready') break
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

test('全链路：扫描件走视觉理解，页数封顶后说明覆盖范围', async t => {
  t.after(() => { rmSync(root, { recursive: true, force: true }) })
  const server = createApp().app.listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  t.after(async () => { await new Promise(resolve => server.close(resolve)) })
  const base = `http://127.0.0.1:${server.address().port}`
  const headers = { 'x-workspace-account': 'full-link-scan@test.invalid', 'x-case-agent-token': 'test-only' }
  currentAccountEmail = 'full-link-scan@test.invalid'
  // 视觉页数封顶调小，测试不必真的渲染十几页。
  env.EVIDENCE_VISION_PAGE_LIMIT = 2

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
  for (let attempt = 0; attempt < 200; attempt += 1) {
    workspace = (await (await fetch(`${base}/api/workspace`, { headers })).json()).workspace
    const task = workspace.cases.find((item) => item.id === caseId)?.agent?.task
    if (task?.status === 'failed') throw new Error(task.error)
    if (task?.status === 'ready') break
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  const task = workspace.cases.find((item) => item.id === caseId)?.agent?.task
  assert.equal(task?.status, 'ready', `扫描件梳理未完成：${task?.stage ?? ''}`)
  const insight = workspace.evidenceInsights.find((item) => item.caseId === caseId)
  assert.ok(insight, '扫描件应产出理解记忆')
  const scannedEvidence = workspace.evidences.find((item) => item.caseId === caseId)
  assert.ok(insight.issues.some((issue) => issue.includes('仅覆盖前')),
    `应说明视觉理解只覆盖了前若干页：issues=${JSON.stringify(insight.issues)} pages=${scannedEvidence?.pages} 文本片段=${JSON.stringify((scannedEvidence?.ocrText ?? '').slice(0, 120))}`)
})
