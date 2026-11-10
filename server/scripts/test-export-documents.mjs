import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inflateRawSync } from 'node:zlib'
import {
  buildDeclarationData,
  buildEvidenceCatalogRows,
  buildParagraphComment,
  buildVerificationRecordRows,
} from '../../app/src/export-declaration.ts'
import { buildCertificateWordBytes } from '../../app/src/export-word.ts'

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
