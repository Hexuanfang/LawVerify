import assert from 'node:assert/strict'
import test from 'node:test'
import { markAssistantVerificationPending, recheckAssistantDeclarations } from '../src/assistant/recheck.ts'
import { createLegalCaseAdapter } from '../src/integrations/legal-case.ts'
import { createLegalStatuteAdapter } from '../src/integrations/legal-statute.ts'
import { normalizeCaseNumber } from '../src/intelligence/legal-verification.ts'
import { extractDeclarations } from '../src/intelligence/verification/extract.ts'
import { profile } from '../src/intelligence/verification/profile.ts'

const fingerprint = 'materials-current'
const lawText = '借款人应当按照约定的期限返还借款。'
const number = '（2023）京0105民初123号'
const workspace = { evidences: [], evidenceFragments: [], evidenceInsights: [], knowledgeStatutes: [], knowledgeCases: [] }
const paragraph = (id, text) => ({ id, text, verified: false })

function oldDocument() {
  const paragraphs = [
    paragraph('edit', '原告于2023年3月5日支付货款。被告曾签署收据。'),
    paragraph('law', `《民法典》第六百七十五条：“${lawText}”`),
    paragraph('case', `${number}`),
    paragraph('unrelated', '原告收到通知。'),
  ]
  const certificate = { id: 'certificate-1', caseId: 'case-1', docKey: 'qs', title: '民事起诉状', paragraphs, linkageInputKey: fingerprint }
  const { declarations } = extractDeclarations(certificate)
  const find = (type, id) => declarations.find(item => item.type === type && item.location.paragraphId === id)
  const fact = find('E-FACT', 'edit')
  const law = find('E-LAW', 'law')
  const legalCase = find('E-CASE', 'case')
  for (const item of declarations) Object.assign(item, { verdict: 'pass', reason: '保留既有核验结果' })
  law.checks = { B1: { outcome: 'pass', reason: '条文真实' }, B4: { outcome: 'pass', reason: '适配' } }
  law.dependencies = [{ id: fact.id, check: 'B4' }]
  legalCase.checks = { C1: { outcome: 'pass', reason: '裁判真实' }, C6: { outcome: 'pass', reason: '生效' } }
  legalCase.dependencies = [{ id: law.id, check: 'C6' }]
  certificate.verification = { version: 1, profileVersion: profile.version, inputKey: fingerprint, docKey: 'qs', classificationRequired: false, declarations }
  return certificate
}

function rewrite(previous, text) {
  return { ...previous, paragraphs: previous.paragraphs.map(item => item.id === 'edit'
    ? { ...item, text, verified: false, aiOrigin: 'rewrite' } : item) }
}

test('采纳选择性标记目标声明和显式依赖链，保留同段可重新锚定的独立声明', () => {
  const previous = oldDocument()
  const certificate = rewrite(previous, '原告于2023年3月5日实际支付了货款。被告曾签署收据。')
  const marked = markAssistantVerificationPending(certificate, 'edit', fingerprint, previous)
  const find = (type, id) => marked.verification.declarations.find(item => item.type === type && item.location.paragraphId === id)
  const changed = find('E-FACT', 'edit')
  const unchanged = marked.verification.declarations.find(item => item.quote === '被告曾签署收据。')
  assert.equal(marked.hasCurrentBaseline, true)
  assert.equal(changed.aiOrigin, 'rewrite')
  assert.equal(changed.verdict, 'pending')
  assert.equal(unchanged.verdict, 'pass')
  assert.equal(unchanged.aiOrigin, undefined)
  assert.equal(unchanged.location.start, certificate.paragraphs[0].text.indexOf(unchanged.quote))
  assert.equal(find('E-LAW', 'law').checks.B4.outcome, 'pending')
  assert.equal(find('E-CASE', 'case').checks.C6.outcome, 'pending')
  assert.equal(find('E-FACT', 'unrelated').reason, '保留既有核验结果')
  assert.deepEqual(new Set(marked.dirtyIds), new Set([changed.id, find('E-LAW', 'law').id, find('E-CASE', 'case').id]))
})

test('材料指纹变化时旧结果降为待核，局部只处理目标段', async () => {
  const previous = oldDocument()
  const certificate = rewrite(previous, '原告已支付约定货款。')
  const marked = markAssistantVerificationPending(certificate, 'edit', 'changed-materials', previous)
  assert.equal(marked.hasCurrentBaseline, false)
  assert.ok(marked.verification.declarations.every(item => item.verdict === 'pending' && !item.sources.length))
  const verified = await recheckAssistantDeclarations(certificate, marked, workspace)
  assert.equal(verified.declarations.find(item => item.location.paragraphId === 'edit').verdict, 'miss')
  assert.ok(verified.declarations.filter(item => item.location.paragraphId !== 'edit').every(item => item.verdict === 'pending'))
})

test('局部重核只查询受影响法条并保留其余声明结果', async () => {
  const previous = oldDocument()
  const certificate = rewrite(previous, '原告于2023年3月5日实际支付了货款。被告曾签署收据。')
  const marked = markAssistantVerificationPending(certificate, 'edit', fingerprint, previous)
  const statute = { id: 'article', law_name: '民法典', article_number: '第六百七十五条', text: lawText, validity: 'VALID',
    version: '2020', url: 'https://flk.npc.gov.cn/detail2.html?law', effective_date: '2021-01-01' }
  const calls = []
  const statuteAdapter = createLegalStatuteAdapter(async request => {
    calls.push(request.action)
    return { items: [statute] }
  })
  const result = await recheckAssistantDeclarations(certificate, marked, workspace, { statuteAdapter })
  assert.deepEqual(calls, ['search_article', 'article_detail'])
  assert.equal(result.declarations.find(item => item.location.paragraphId === 'edit').verdict, 'miss')
  assert.equal(result.declarations.find(item => item.type === 'E-LAW').checks.B1.outcome, 'pass')
  assert.equal(result.declarations.find(item => item.location.paragraphId === 'unrelated').reason, '保留既有核验结果')
})

test('法源超时时向调用方抛出失败并保留原待核快照供重试', async () => {
  const previous = oldDocument()
  const certificate = rewrite(previous, '原告于2023年3月5日实际支付了货款。')
  const marked = markAssistantVerificationPending(certificate, 'edit', fingerprint, previous)
  const snapshot = structuredClone(marked.verification)
  const statuteAdapter = createLegalStatuteAdapter(async () => ({ outcome: 'timeout' }))
  await assert.rejects(recheckAssistantDeclarations(certificate, marked, workspace, { statuteAdapter }), /局部重核/u)
  assert.deepEqual(marked.verification, snapshot)
})

test('上游变化只重开依赖检查并保留独立红灯', () => {
  const previous = oldDocument()
  const law = previous.verification.declarations.find(item => item.type === 'E-LAW')
  law.checks.B1 = { outcome: 'fail', reason: '权威详情确认查无' }
  law.verdict = 'fail'
  const certificate = rewrite(previous, '原告实际支付了货款。被告曾签署收据。')
  const { verification } = markAssistantVerificationPending(certificate, 'edit', fingerprint, previous)
  const affected = verification.declarations.find(item => item.type === 'E-LAW')
  assert.equal(affected.verdict, 'fail')
  assert.equal(affected.checks.B4.outcome, 'pending')
  assert.deepEqual(affected.checks.B1, law.checks.B1)
})

test('同案局部重核保留后审对原审的撤销关系', async () => {
  const previous = oldDocument()
  const retrial = '（2023）京03民终789号'
  const court = '北京市第三中级人民法院'
  const appeal = paragraph('appeal', retrial)
  previous.paragraphs.push(appeal)
  const original = previous.verification.declarations.find(item => item.type === 'E-CASE')
  const parent = extractDeclarations(previous).declarations.find(item => item.location.paragraphId === appeal.id)
  const groupId = normalizeCaseNumber(number)
  original.caseVerification = { groupId, caseNumber: number }
  parent.caseVerification = { groupId, caseNumber: retrial }
  previous.verification.declarations.push(parent)

  const certificate = rewrite(previous, '原告实际支付了货款。被告曾签署收据。')
  const marked = markAssistantVerificationPending(certificate, 'edit', fingerprint, previous)
  const judgment = (id, case_number, history, ruling) => ({ id, case_number, court, name: '某民事判决书', judgment_date: '2023-07-09',
    effect: 'effective', level: 'ordinary', url: `https://rmfyalk.court.gov.cn/${id}`,
    body: `${court}\n民事判决书\n${case_number}\n${history}\n本院认为：应当按约履行。\n判决如下：${ruling}` })
  const results = [judgment('original', number, '', '被告支付货款。'), {
    ...judgment('appeal', retrial, `上诉人不服${number}民事判决，向本院提起上诉。`, '撤销原判。'),
    related_cases: [{ case_number: number, relation: 'prior' }],
  }]
  const caseAdapter = createLegalCaseAdapter('fixture', async request => ({ items: results.filter(item =>
    'id' in request ? request.id === item.id : 'case_number' in request && request.case_number === item.case_number) }))
  const verified = await recheckAssistantDeclarations(certificate, marked, workspace, { caseAdapter })
  const lower = verified.declarations.find(item => item.id === original.id)
  assert.equal(lower.caseVerification.effect, 'vacated')
  assert.equal(lower.caseVerification.allowCitation, false)
  assert.equal(lower.checks.C6.outcome, 'fail')
})
