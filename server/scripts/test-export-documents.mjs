import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inflateRawSync } from 'node:zlib'
import {
  buildDeclarationData,
  buildEvidenceCatalogRows,
  buildParagraphComment,
  buildVerificationRecordRows,
} from '../../app/src/export-declaration.ts'
import { buildCertificateWordBytes, exportCertificateToWord } from '../../app/src/export-word.ts'
import { paragraphElements } from '../../app/src/redesign/model.ts'
import { verifyEvidenceDeclarations } from '../src/intelligence/verification/evidence.ts'
import { extractDeclarations } from '../src/intelligence/verification/extract.ts'

/** 最小 zip 读取器：只按中央目录取出需要的条目，避免引入额外依赖。 */
function readZipEntries(bytes) {
  const buffer = Buffer.from(bytes)
  let eocd = -1
  for (let index = buffer.length - 22; index >= 0; index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) {
      eocd = index
      break
    }
  }
  assert.ok(eocd >= 0, '产物不是有效的 zip 包')

  const count = buffer.readUInt16LE(eocd + 10)
  let offset = buffer.readUInt32LE(eocd + 16)
  const entries = new Map()

  for (let index = 0; index < count; index += 1) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50, '中央目录项损坏')
    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength)

    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const raw = buffer.subarray(dataStart, dataStart + compressedSize)
    entries.set(name, (method === 0 ? raw : inflateRawSync(raw)).toString('utf8'))

    offset += 46 + nameLength + extraLength + commentLength
  }

  return entries
}

const baseContext = {
  certificate: {
    id: 'cert-1',
    caseId: 'case-1',
    title: '民事起诉状',
    role: 'plaintiff',
    focus: '付款违约',
    paragraphIds: ['p-1', 'p-2'],
    createdAt: '2024-01-01T00:00:00.000Z',
    paragraphs: [
      {
        id: 'p-1',
        text: '双方于2023年5月签订购销合同，约定总价120万元。',
        note: '金额与合同页对应',
        verified: true,
        links: [{ evidenceId: 'e-1', locator: '第 2 页', quote: '合同总价款为人民币120万元', sentenceIndex: 0 }],
        references: [
          { type: 'statute', targetId: 's-1', sourceTitle: '中华人民共和国民法典', label: '民法典第五百七十七条', locator: '第五百七十七条', quote: '违约责任' },
          { type: 'case', targetId: 'k-1', sourceTitle: '某买卖合同纠纷', label: '（2021）京01民终XXXX号', locator: '二审', quote: '违约金' },
        ],
      },
      {
        id: 'p-2',
        text: '被告至今未支付第二期货款60万元。',
        verified: false,
        links: [],
        references: [],
      },
    ],
  },
  caseFolder: { id: 'case-1', name: '甲乙买卖合同纠纷', status: 'draft' },
  evidences: [
    { id: 'e-1', number: 'E01', sourceNumber: '证据1', name: '购销合同', fileName: '购销合同.pdf', type: 'pdf', pages: 3, relativePath: '证据1 购销合同.pdf' },
    { id: 'e-2', number: 'E02', sourceNumber: undefined, name: '付款凭证', fileName: '付款凭证.pdf', type: 'pdf', pages: 1, relativePath: '证据2 付款凭证.pdf' },
  ],
  roleLabel: '原告',
  appVersion: '0.1.60',
  exportedAt: new Date('2024-05-06T08:09:10.000Z'),
  operator: 'lawyer-a',
  options: { evidenceCatalog: true, verificationRecord: true, declaration: true, useWordComments: true },
}

test('ADV-08 的前审反转走实际 Word 下载入口时阻断两种模式，缺源结果在桌面显示 L0', async () => {
  const caseId = 'case-1'
  const id = 'adv-08'
  const locator = '判项第一项'
  const quote = '被告向原告赔偿1000元。'
  const judgment = { id: 'judgment', caseId, name: '一审判决书', fileName: '一审判决书.pdf', type: 'pdf', ocrText: quote }
  const paragraph = { id: 'p', text: '原审驳回我方赔偿请求。', verified: true,
    link: { evidenceId: judgment.id, locator, quote } }
  const document = { ...baseContext.certificate, id, docKey: 'ss', linkageInputKey: 'adv-key', paragraphs: [paragraph] }
  const declarations = extractDeclarations(document).declarations.filter(item => item.type === 'E-ERR')
  assert.equal(declarations.length, 1)
  const stateFor = withOriginal => {
    const evidences = withOriginal ? [judgment] : []
    const results = verifyEvidenceDeclarations(document, declarations, { evidences,
      evidenceFragments: withOriginal ? [{ evidenceId: judgment.id, locator, text: quote }] : [], evidenceInsights: [] })
    return { evidences, certificates: [{ ...document, verification: { version: 1, profileVersion: 'qa', inputKey: 'adv-key',
      docKey: 'ss', classificationRequired: false, declarations: results } }] }
  }
  const absent = paragraphElements(paragraph, stateFor(false), id).find(item => item.type === 'E-ERR')
  assert.equal(absent.verdict, 'miss')
  assert.equal(absent.src, 'l0')
  assert.deepEqual(absent.sources, [])

  const state = stateFor(true)
  const result = paragraphElements(paragraph, state, id).find(item => item.type === 'E-ERR')
  assert.equal(result.verdict, 'fail')
  assert.equal(result.src, 'l1')
  for (const useWordComments of [true, false]) {
    await assert.rejects(exportCertificateToWord(state, id, { appVersion: baseContext.appVersion,
      options: { ...baseContext.options, useWordComments } }), /1 项不通过/u)
  }
})

test('审阅版按同段不同声明范围写原生 Word 批注，不包住相邻原文', async () => {
  const body = baseContext.certificate.paragraphs[0].text
  const spans = ['2023年5月', '120万元'].map(quote => ({ start: body.indexOf(quote), end: body.indexOf(quote) + quote.length, quote, text: `核对：${quote}` }))
  const { bytes } = await buildCertificateWordBytes({ ...baseContext, declarationComments: new Map([['p-1', spans]]) })
  const files = readZipEntries(bytes)
  const document = files.get('word/document.xml')
  const contents = [...document.matchAll(/<w:commentRangeStart w:id="(\d+)"\/><w:r><w:t[^>]*>([^<]+)<\/w:t><\/w:r><w:commentRangeEnd w:id="\1"\/>/gu)].map(match => match[2]).filter(value => body.includes(value))
  assert.deepEqual(contents, ['2023年5月', '120万元'])
  assert.match(files.get('word/comments.xml'), /核对：120万元/)
})

test('实际 Word 下载入口拒绝红灯、缺源、待核验、旧快照和空稿', async () => {
  const certificate = { ...baseContext.certificate, linkageInputKey: 'qa' }
  const body = { ...certificate.paragraphs[0], references: [], links: [{ ...certificate.paragraphs[0].links[0], relation: 'support' }] }
  const workspace = { user: { email: 'qa@test.invalid' }, cases: [baseContext.caseFolder],
    evidences: baseContext.evidences.map(item => ({ ...item, caseId: certificate.caseId })), certificates: [] }
  for (const review of [true, false]) {
    for (const patch of [
      { paragraphs: [{ ...body, links: [{ ...body.links[0], relation: 'contradict' }] }] },
      { paragraphs: [{ ...body, links: [] }] },
      { paragraphs: [{ ...body, verified: false }] },
      { paragraphs: [] },
      { paragraphs: [body], linkageStale: true },
      { paragraphs: [body], linkageInputKey: undefined },
    ]) {
      workspace.certificates = [{ ...certificate, ...patch }]
      await assert.rejects(exportCertificateToWord(workspace, certificate.id, {
        appVersion: baseContext.appVersion, options: { ...baseContext.options, useWordComments: review, bodyAnnotations: review },
      }), /核验|正文/)
    }
  }
})

test('两个 Word 都拒绝本机脏稿，清稿和已判定黄灯均生成实际 DOCX', async context => {
  const certificate = { ...baseContext.certificate, linkageInputKey: 'qa' }
  const body = { ...certificate.paragraphs[0], references: [], links: [{ ...certificate.paragraphs[0].links[0], relation: 'support' }] }
  const workspace = { user: { email: 'qa@test.invalid' }, cases: [baseContext.caseFolder],
    evidences: baseContext.evidences.map(item => ({ ...item, caseId: certificate.caseId })), certificates: [] }
  const downloaded = []
  const blobs = []
  const drafts = new Map()
  const localAudits = []
  const globals = {
    sessionStorage: { getItem: () => workspace.user.email },
    document: { body: { appendChild() {}, removeChild() {} }, createElement: () => ({ click() { downloaded.push(this.download) } }) },
    indexedDB: { open() {
      const request = { result: { transaction() {
        const transaction = { objectStore: () => ({
          get: key => ({ result: drafts.get(key) }),
          index: () => ({ getAll: ([account, certificateId]) => ({
            result: localAudits.filter(item => item.account === account && item.certificateId === certificateId),
          }) }),
        }) }
        queueMicrotask(() => transaction.oncomplete())
        return transaction
      } } }
      queueMicrotask(() => request.onsuccess())
      return request
    } },
  }
  for (const [key, value] of Object.entries(globals)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key)
    Object.defineProperty(globalThis, key, { value, configurable: true })
    context.after(() => previous ? Object.defineProperty(globalThis, key, previous) : Reflect.deleteProperty(globalThis, key))
  }
  context.mock.method(URL, 'createObjectURL', blob => { blobs.push(blob); return 'blob:qa-word' })
  const key = JSON.stringify(['lawverify-document', workspace.user.email, certificate.id])
  for (const review of [true, false]) {
    const options = { appVersion: baseContext.appVersion,
      options: { ...baseContext.options, verificationRecord: false, useWordComments: review, bodyAnnotations: review } }
    workspace.certificates = [{ ...certificate, paragraphs: [body] }]
    drafts.set(key, { text: '尚未保存' })
    const priorDownloads = downloaded.length
    await assert.rejects(exportCertificateToWord(workspace, certificate.id, options), /尚未保存/)
    assert.equal(downloaded.length, priorDownloads)
    drafts.delete(key)
    await exportCertificateToWord(workspace, certificate.id, options)
    workspace.certificates[0].paragraphs = [{ ...body, links: [{ ...body.links[0], relation: 'context' }] }]
    await exportCertificateToWord(workspace, certificate.id, options)
    const entries = readZipEntries(await blobs.at(-1).arrayBuffer())
    assert.match(entries.get('word/document.xml'), /段落核验记录/)
    assert.match(entries.get('word/document.xml'), /黄·待核对/)
    assert.equal(/<w:comment\b/u.test(entries.get('word/comments.xml') ?? ''), review)
    assert.equal(/<w:commentRangeStart\b/u.test(entries.get('word/document.xml')), review)

    const diagnose = { code: 'A3', verdict: 'warn', reason: '卷内材料未列入证据清单。',
      sources: [{ tier: 'l1', id: 'e-2', name: '付款凭证', locator: '第 2 页' }] }
    workspace.certificates = [{ ...certificate, docKey: 'zj', paragraphs: [body], verification: {
      version: 1, profileVersion: 'qa', docKey: 'zj', inputKey: 'qa', classificationRequired: false, documentDiagnostics: [diagnose], declarations: [],
    } }]
    await exportCertificateToWord(workspace, certificate.id, options)
    const withDiagnostic = readZipEntries(await blobs.at(-1).arrayBuffer())
    assert.match(withDiagnostic.get('word/document.xml'), /文书级预警/u)
    assert.match(withDiagnostic.get('word/document.xml'), /卷内材料未列入证据清单.*付款凭证[^<]*第 2 页/u)
    assert.doesNotMatch(withDiagnostic.get('word/comments.xml') ?? '', /卷内材料未列入证据清单/u)

    const tradeText = '被告仅支付货款200,000元，尚欠376,000元。'
    const statement = '货款总额576,000元，累计已付货款200,000元。'
    const tradeParagraph = { ...body, text: tradeText, richText: `<p>${tradeText}</p>`, verified: true,
      links: [{ evidenceId: 'e-2', locator: '第 2 页', quote: statement, relation: 'support' }] }
    const tradeDocument = { ...certificate, docKey: 'qs', paragraphs: [tradeParagraph] }
    const declarations = verifyEvidenceDeclarations(tradeDocument, extractDeclarations(tradeDocument).declarations, {
      evidences: workspace.evidences, evidenceFragments: [{ evidenceId: 'e-2', locator: '第 2 页', text: statement }], evidenceInsights: [],
    })
    workspace.certificates = [{ ...tradeDocument, verification: {
      version: 1, profileVersion: 'qa', docKey: 'qs', inputKey: 'qa', classificationRequired: false, declarations,
    } }]
    await exportCertificateToWord(workspace, certificate.id, options)
    const withCalculation = readZipEntries(await blobs.at(-1).arrayBuffer())
    assert.match(withCalculation.get('word/document.xml'), /第 1 段金额复算.*376000\.00 元。依据 付款凭证 · 第 2 页/u)
  }
  assert.equal(downloaded.length, 8)

  await context.test('清洁版附页记录核验版本、声明联动以及当前文书的人工和助手操作', async () => {
    const fact = { ...body, id: 'fact', text: '双方订立购销合同。' }
    const statute = { ...body, id: 'statute', text: '相关依据为民法典第五百七十七条。' }
    const at = '2026-11-20T10:30:45.000Z'
    const declarations = [fact, statute].map((paragraph, paragraphIndex) => ({
      id: paragraph.id,
      quote: paragraph.text,
      type: paragraphIndex ? 'E-LAW' : 'E-FACT',
      reason: '已核对原文',
      location: { paragraphId: paragraph.id, paragraphIndex, start: 0, end: paragraph.text.length, sentenceIndex: 0 },
      verdict: 'pass',
      checks: {},
      sources: paragraphIndex
        ? [{ tier: 'l2', id: 's-1', name: '中华人民共和国民法典', version: '2021-01', locator: '第五百七十七条' }]
        : [{ tier: 'l1', id: 'e-1', name: '购销合同', locator: '第 2 页', quote: fact.text }],
    }))
    declarations[1].dependencies = [{ id: 'fact', check: 'B4' }]
    declarations[1].checks = { B4: { outcome: 'pass', reason: '法律依据对应已核实的合同事实' } }
    declarations[1].statuteVerification = { checkedAt: at }
    workspace.certificates = [{ ...certificate, paragraphs: [fact, statute], verification: {
      version: 1, profileVersion: 'qa-profile-v12', inputKey: 'qa', classificationRequired: false,
      verifiedAt: at, declarations, audit: [
        { id: '1', at, actor: '律师甲', action: 'adopt', quote: '实际采纳的助手引用', note: '关联处已复核', affected: ['statute'],
          sources: [{ tier: 'l2', id: 's-1', name: '中华人民共和国民法典', locator: '第五百七十七条' }] },
      ],
    } }]
    localAudits.push(
      { id: 'l-1', account: workspace.user.email, certificateId: certificate.id, t: at, msg: '律师在本机确认段落' },
      { id: 'l-2', account: workspace.user.email, certificateId: 'other-document', t: at, msg: '其他文书的操作记录' },
      { id: 'l-3', account: 'other@test.invalid', certificateId: certificate.id, t: at, msg: '其他账号的操作记录' },
    )

    for (const review of [false, true]) {
      await exportCertificateToWord(workspace, certificate.id, { appVersion: baseContext.appVersion,
        options: { ...baseContext.options, useWordComments: review, bodyAnnotations: review } })
      const files = readZipEntries(await blobs.at(-1).arrayBuffer())
      const xml = files.get('word/document.xml')
      if (review) {
        assert.doesNotMatch(xml, /qa-profile-v12|实际采纳的助手引用|律师在本机确认段落/u)
        continue
      }
      const appendix = xml.slice(xml.indexOf('段落核验记录'))
      for (const value of ['qa-profile-v12', '核验时间', '最近法源核对', '中华人民共和国民法典 2021-01', '联动影响',
        '法律依据对应已核实的合同事实', '依赖声明 · 双方订立购销合同。', '受影响声明 · 相关依据为民法典第五百七十七条。',
        '律师甲', '实际采纳的助手引用', '涉及 1 项声明', '律师在本机确认段落']) {
        assert.ok(appendix.includes(value), `附页缺少 ${value}`)
      }
      assert.doesNotMatch(xml, /其他文书的操作记录|其他账号的操作记录/u)
      assert.doesNotMatch(xml, /w:commentRangeStart/u)
    }
  })
})

test('编号对照行：目录编号与引用编号并列，缺失引用编号不臆造', () => {
  const rows = buildEvidenceCatalogRows(baseContext)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].index, 1)
  assert.equal(rows[0].sourceNumber, '证据1')
  assert.equal(rows[0].number, 'E01')
  assert.equal(rows[0].name, '购销合同')
  assert.equal(rows[0].type, 'PDF')
  assert.equal(rows[0].pages, 3)
  assert.equal(rows[0].usage, '第 1 段引用')
  assert.equal(rows[1].sourceNumber, '未指定（按路径推断）')
  assert.equal(rows[1].usage, '未引用')
})

test('核验记录行：核验状态与段落数一致', () => {
  const rows = buildVerificationRecordRows(baseContext)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].index, 1)
  assert.equal(rows[0].status, '已核验')
  assert.equal(rows[0].sentenceCount, 1)
  assert.equal(rows[0].linkedEvidenceCount, 1)
  assert.equal(rows[0].statuteCount, 1)
  assert.equal(rows[0].caseCount, 1)
  assert.equal(rows[0].commentSummary, '金额与合同页对应')
  assert.equal(rows[1].status, '未核验')
  assert.equal(rows[1].linkedEvidenceCount, 0)
  assert.equal(rows[1].commentSummary, '—')
})

test('声明字段：案件名、代理角色、导出时间、版本与核验统计齐全', () => {
  const declaration = buildDeclarationData(baseContext)
  const labels = declaration.fields.map(field => field.label)
  assert.ok(labels.includes('案件名称'))
  assert.ok(labels.includes('文书名称'))
  assert.ok(labels.includes('代理角色'))
  assert.ok(labels.includes('导出时间'))
  assert.ok(labels.includes('软件版本'))

  const byLabel = Object.fromEntries(declaration.fields.map(field => [field.label, field.value]))
  assert.equal(byLabel['案件名称'], '甲乙买卖合同纠纷')
  assert.equal(byLabel['文书名称'], '民事起诉状')
  assert.equal(byLabel['代理角色'], '原告')
  assert.equal(byLabel['软件版本'], '0.1.60')
  assert.equal(byLabel['导出人'], 'lawyer-a')
  assert.match(byLabel['导出时间'], /^2024-05-06 /)

  assert.equal(declaration.stats.totalParagraphs, 2)
  assert.equal(declaration.stats.verifiedParagraphs, 1)
  assert.equal(declaration.stats.linkedSentenceCount, 1)
  assert.deepEqual(declaration.stats.unverifiedParagraphIndexes, [2])
  assert.match(declaration.disclaimer, /材料关联仅表示内容相关性/)
})

test('段落批注：包含原批注、绑定证据编号与核验状态', () => {
  const comment = buildParagraphComment(baseContext, 0)
  assert.match(comment, /金额与合同页对应/)
  assert.match(comment, /E01（第 2 页）/)
  assert.match(comment, /核验状态：已核验/)

  const unverified = buildParagraphComment(baseContext, 1)
  assert.match(unverified, /核验状态：未核验/)
})

test('导出产物：正文、附录、页码域与 Word 批注都落到包里', async () => {
  const { bytes, usedComments } = await buildCertificateWordBytes(baseContext)
  assert.equal(usedComments, true)

  const entries = readZipEntries(bytes)
  assert.ok(entries.has('word/document.xml'))
  assert.ok(entries.has('word/comments.xml'))
  assert.ok(entries.has('word/footer1.xml'))
  assert.ok(entries.has('word/header1.xml'))

  const documentXml = entries.get('word/document.xml')
  assert.match(documentXml, /民事起诉状/)
  assert.match(documentXml, /附录一　证据编号对照表/)
  assert.match(documentXml, /附录二　段落核验记录/)
  assert.match(documentXml, /附录三　AI 辅助与人工核验声明/)
  assert.match(documentXml, /commentReference/)

  const commentsXml = entries.get('word/comments.xml')
  assert.match(commentsXml, /金额与合同页对应/)
  assert.match(commentsXml, /E01（第 2 页）/)

  const footerXml = entries.get('word/footer1.xml')
  assert.match(footerXml, /PAGE/)
  assert.match(footerXml, /NUMPAGES/)
  assert.match(footerXml, /导出时间/)
})

test('导出产物：关闭批注时退化为灰色小字批注行', async () => {
  const { bytes, usedComments } = await buildCertificateWordBytes(baseContext, { useWordComments: false })
  assert.equal(usedComments, false)

  const entries = readZipEntries(bytes)
  // docx 始终会打包 comments.xml，关闭批注时里面不应有实际批注。
  const commentsXml = entries.get('word/comments.xml') ?? ''
  assert.doesNotMatch(commentsXml, /<w:comment /)
  const documentXml = entries.get('word/document.xml')
  assert.match(documentXml, /批注：/)
  assert.doesNotMatch(documentXml, /commentReference/)
})

test('导出产物：仅导出正文时不带附录', async () => {
  const { bytes } = await buildCertificateWordBytes({
    ...baseContext,
    options: { evidenceCatalog: false, verificationRecord: false, declaration: false, useWordComments: true },
  })
  const documentXml = readZipEntries(bytes).get('word/document.xml')
  assert.doesNotMatch(documentXml, /附录一/)
  assert.doesNotMatch(documentXml, /附录二/)
  assert.doesNotMatch(documentXml, /附录三/)
  assert.match(documentXml, /民事起诉状/)
})
