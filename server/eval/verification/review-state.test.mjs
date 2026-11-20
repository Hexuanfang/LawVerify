import assert from 'node:assert/strict'
import test from 'node:test'
import { applyReviewAction, carryDeclarationReviews, invalidateVerification, prepareDirtyVerification, preserveScopedReferences } from '../../src/intelligence/verification/review-state.ts'
import { declarationEditRange, reviewedVerdict } from '../../src/intelligence/verification/review-status.ts'
import { extractDeclarations } from '../../src/intelligence/verification/extract.ts'

const statement = (id, paragraphId, start, quote, type = 'E-FACT') => ({
  id, type, quote, location: { paragraphId, paragraphIndex: 0, sentenceIndex: 0, start, end: start + quote.length },
  verdict: 'pending', reason: '律师待复核', conf: null,
  checks: { A1: { outcome: 'pass', reason: '已定位' }, A2: { outcome: 'pending', reason: '需人工核对' } },
  sources: [{ tier: 'l1', id: 'source', name: '原件', quote, locator: '第 1 页', version: 'v1' }],
})

function fixture() {
  const first = statement('a', 'p1', 0, '本案款项一百元')
  const sibling = statement('b', 'p1', 0, first.quote, 'E-CALC')
  const downstream = { ...statement('c', 'p2', 0, '适用条文', 'E-LAW'), dependencies: [{ id: 'a', check: 'B4' }] }
  const certificate = { id: 'doc', caseId: 'case', paragraphs: [{ id: 'p1', text: `${first.quote}。`, verified: true, note: '旧整段批注' },
    { id: 'p2', text: `${downstream.quote}。`, verified: false }] }
  const verification = { version: 1, profileVersion: 'rules', revision: 'r1', inputKey: 'materials', classificationRequired: false,
    declarations: [first, sibling, downstream] }
  return { ...certificate, verification }
}

const action = (id, type, extra = {}) => ({ id, declarationId: 'a', revision: 'r1', reviewRevision: null, type, ...extra })
const actor = 'lawyer@example.invalid'

test('同句逐条确认，记录审计，重试保持幂等且红灯和未核完的检查不能通过', () => {
  const document = fixture()
  const verify = action('op1', 'confirm', { checks: ['A1', 'A2'] })
  const saved = applyReviewAction(document.verification, 'a', verify, actor)
  assert.equal(saved.declarations[0].review.decision, 'confirmed')
  assert.equal(saved.declarations[1].review, undefined)
  assert.deepEqual(saved.dirty?.declarationIds, ['c'])
  assert.equal(saved.audit[0].actor, actor)
  assert.equal(saved.audit[0].quote, '本案款项一百元')
  assert.strictEqual(applyReviewAction(saved, 'a', verify, actor), saved)
  assert.throws(() => applyReviewAction(saved, 'a', action('op2', 'note', { note: '旧请求' }), actor), /更新/u)
  assert.throws(() => applyReviewAction(document.verification, 'a', { ...verify, checks: ['A1'] }, actor), /检查/u)
  document.verification.declarations[0].verdict = 'fail'
  assert.throws(() => applyReviewAction(document.verification, 'a', verify, actor), /不通过|缺源/u)
})

test('整段历史仍可读；失效声明及下游不带旧确认，独立声明的批注继续读回', () => {
  const document = fixture()
  const current = document.verification
  const notes = applyReviewAction(current, 'b', action('op1', 'note', { declarationId: 'b', note: '复算批注' }), actor)
  document.verification = applyReviewAction(notes, 'a', action('op2', 'confirm', { checks: ['A1', 'A2'] }), actor)
  const saved = JSON.parse(JSON.stringify(document))
  assert.equal(saved.paragraphs[0].note, '旧整段批注')
  assert.equal(saved.verification.declarations[1].review.note, '复算批注')
  const fresh = fixture().verification.declarations
  fresh[0].sources[0].version = 'v2'
  const merged = carryDeclarationReviews(saved.verification, fresh)
  assert.equal(merged[0].review, undefined)
  assert.equal(merged[1].review.note, '复算批注')
})

test('全文重核保留结论未变的确认，新待核检查不能沿用旧确认', () => {
  const { verification } = fixture()
  const confirmed = applyReviewAction(verification, 'a', action('confirm', 'confirm', { checks: ['A1', 'A2'] }), actor)
  const fresh = fixture().verification.declarations
  assert.equal(reviewedVerdict(carryDeclarationReviews(confirmed, fresh)[0]), 'note')
  fresh[0].checks.A3 = { outcome: 'pending', reason: '新增原件完整性待核项' }
  const [updated] = carryDeclarationReviews(confirmed, fresh)
  assert.equal(updated.review?.decision, undefined)
  assert.equal(reviewedVerdict(updated), 'pending')
})

test('驳回已确认声明重开本项及依赖，忽略黄灯保留原结论', () => {
  const { verification } = fixture()
  verification.declarations[0].verdict = 'pass'
  const confirmed = applyReviewAction(verification, 'a', action('confirm', 'confirm', { checks: ['A1', 'A2'] }), actor)
  const rejected = applyReviewAction(confirmed, 'a', action('reject', 'reject', { reviewRevision: 'confirm' }), actor)
  assert.equal(reviewedVerdict(rejected.declarations[0]), 'pending')
  assert.deepEqual(rejected.dirty.declarationIds, ['a', 'c'])
  assert.equal(rejected.audit.at(-1).previousVerdict, 'pass')
  const warn = { ...verification, declarations: [{ ...verification.declarations[0], verdict: 'warn' }] }
  const ignored = applyReviewAction(warn, 'a', action('ignore', 'ignore'), actor)
  assert.equal(ignored.declarations[0].review.ignored, true)
  assert.equal(reviewedVerdict(ignored.declarations[0]), 'warn')
  assert.equal(ignored.dirty, undefined)
})

test('正文保存只重开改动的声明及跨段依赖，其他已确认声明保留', () => {
  const document = fixture()
  const independent = statement('other', 'p1', 8, '另有付款十元')
  document.paragraphs[0].text += `${independent.quote}。`
  independent.location.sentenceIndex = 1
  document.verification.declarations.push(independent)
  document.verification = applyReviewAction(document.verification, 'other', action('op1', 'confirm', { declarationId: 'other', checks: ['A1', 'A2'] }), actor)
  const paragraphs = document.paragraphs.map(item => ({ ...item, text: item.text.replace('一百', '二百') }))
  const next = invalidateVerification(document, { ...document, paragraphs })
  assert.deepEqual(next.dirty.paragraphIds, ['p1'])
  assert.deepEqual(next.dirty.declarationIds, ['a', 'b', 'c'])
  assert.equal(next.declarations.find(item => item.id === 'other').review.decision, 'confirmed')
})

test('删除唯一法条后，旧文书跨段请求的 B6 重新判定', () => {
  const document = { id: 'basis', caseId: 'case', docKey: 'qs', paragraphs: [
    { id: 'request', text: '请求判令被告偿还借款本金。' },
    { id: 'statute', text: '依据《中华人民共和国民法典》第六百七十五条。' },
  ] }
  const fresh = extractDeclarations(document)
  const claim = fresh.declarations.find(item => item.type === 'E-CLAIM')
  const law = fresh.declarations.find(item => item.type === 'E-LAW')
  assert.ok(claim && law)
  document.verification = { version: 1, profileVersion: 'rules', inputKey: 'materials', docKey: 'qs', classificationRequired: false,
    declarations: [{ ...claim, verdict: 'pass', checks: { B6: { outcome: 'pass', reason: '唯一法律依据' } } }, law] }
  const edited = { ...document, paragraphs: document.paragraphs.slice(0, 1) }
  const invalid = invalidateVerification(document, edited)
  const recheck = prepareDirtyVerification(edited, invalid)
  assert.ok(recheck.dirtyIds.includes(claim.id))
  assert.equal(recheck.verification.declarations.find(item => item.id === claim.id).verdict, 'pending')
})

test('局部重核保留精确锚定的两条模型事实，原红灯不能随重新抽取消失', () => {
  const document = { id: 'split', caseId: 'case', docKey: 'qs', paragraphs: [{ id: 'p', text: '原告签订合同，被告支付100元。' }] }
  const model = [{ type: 'E-FACT', paragraphId: 'p', quote: '原告签订合同' }, { type: 'E-FACT', paragraphId: 'p', quote: '被告支付100元' }]
  const extracted = extractDeclarations(document, model)
  const facts = extracted.declarations.filter(item => item.type === 'E-FACT')
  assert.equal(facts.length, 2)
  const target = facts[1]
  target.verdict = 'fail'
  const snapshot = { version: 1, profileVersion: 'rules', docKey: 'qs', inputKey: 'materials', classificationRequired: false,
    declarations: extracted.declarations, dirty: { paragraphIds: ['p'], declarationIds: [target.id] } }
  const prepared = prepareDirtyVerification(document, snapshot)
  assert.deepEqual(prepared.verification.declarations.filter(item => item.type === 'E-FACT').map(item => item.id), facts.map(item => item.id))
  assert.ok(prepared.dirtyIds.includes(target.id))
})

test('采纳范围包含既有引文，不移除同句的其他内容；保留可定位的同句手工来源', () => {
  const quote = '《合同法》第一百零七条'
  const original = `${quote}规定：‘旧条文’，另有付款十元。`
  const item = { ...statement('law', 'p', 0, quote, 'E-LAW'), verdict: 'fail', verifiedText: '《民法典》第五百七十七条：“新条文”',
    verifiedSources: [{ id: 'replacement', tier: 'l2', name: '民法典', locator: '第五百七十七条', quote: '新条文' }] }
  const range = declarationEditRange(original, item, 'adopt')
  assert.equal(original.slice(0, range.end), `${quote}规定：‘旧条文’`)
  const revised = range.replacement + original.slice(range.end)
  assert.match(revised, /新条文.*另有付款十元/u)
  assert.doesNotMatch(revised, /旧条文/u)
  const unaffected = statement('other', 'p', original.indexOf('另有付款十元'), '另有付款十元')
  const before = { id: 'doc', caseId: 'case', paragraphs: [{ id: 'p', text: original, links: [{ id: 'manual', evidenceId: 'e', locator: '第 1 页', quote: unaffected.quote, sentenceIndex: 0 }] }],
    verification: { version: 1, profileVersion: 'rules', inputKey: 'materials', classificationRequired: false,
      manualReferences: { manual: unaffected.id }, declarations: [item, unaffected] } }
  const next = preserveScopedReferences(before, { ...before, paragraphs: [{ id: 'p', text: revised, links: [] }] })
  assert.equal(next.paragraphs[0].links[0].sentenceText, revised)
  assert.match(next.verification.manualReferences.manual, /^doc:p:\d+:\d+:E-FACT$/u)
  const invalidated = invalidateVerification(before, next)
  assert.ok(invalidated.dirty.declarationIds.includes(next.verification.manualReferences.manual))
})
