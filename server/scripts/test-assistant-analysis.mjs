import assert from 'node:assert/strict'
import { test } from 'node:test'

function material(id, name, ocrText, extra = {}) {
  return { id, name, ocrText, caseId: 'case-1', number: id, type: 'pdf', fileName: `${name}.pdf`, uploadedAt: '2026-01-01', ...extra }
}

function input(evidences = [], extra = {}) {
  return { caseId: 'case-1', workspace: { evidences, evidenceFragments: [], evidenceInsights: [], caseContextMemories: [] }, ...extra }
}

function declaration(id, type, quote, verdict, extra = {}) {
  return { id, type, quote, verdict, location: { paragraphId: id, paragraphIndex: 0, start: 0, end: quote.length }, checks: {}, sources: [], reason: '示例待核原因', conf: null, ...extra }
}

function certificate(declarations, extra = {}) {
  return { id: 'doc-1', caseId: 'case-1', title: '答辩状', role: 'defendant', focus: '', paragraphs: declarations.map(item => ({ id: item.id, text: item.quote, verified: true })), paragraphIds: declarations.map(item => item.id), createdAt: '2026-01-01', verification: { version: 1, profileVersion: '1', inputKey: '', classificationRequired: false, declarations }, ...extra }
}

test('证据三性对缺原始载体给出待核与补强，明确材料和当前声明的关联', async () => {
  const { runAnalysisSkill } = await import('../src/assistant/analysis.ts')
  const receipt = material('e1', '付款回单', '2025年1月2日转账，银行回单复印件。')
  const claim = declaration('d1', 'E-FACT', '转账已到账。', 'warn', { sources: [{ tier: 'l1', id: 'e1', name: '付款回单', quote: '2025年1月2日转账', locator: '第1页' }] })
  const card = runAnalysisSkill('evidence', input([receipt], { certificate: certificate([claim]) }))
  assert.equal(card.type, 'analysis-card')
  assert.equal(card.status, 'pending')
  assert.match(card.authenticity.join(), /付款回单.*原始载体/)
  assert.match(card.legality.join(), /来源|取得/)
  assert.match(card.relevance.join(), /付款回单.*转账已到账/)
  assert.match(card.probative.join(), /待核/)
  assert.match(card.reinforce.join(), /原件/)
})

test('论证链指出上游断裂后的法条适配与案例分层重核', async () => {
  const { runAnalysisSkill } = await import('../src/assistant/analysis.ts')
  const fact = declaration('f', 'E-FACT', '原告已履行交付。', 'pending')
  const law = declaration('l', 'E-LAW', '《民法典》第五百七十七条', 'pass', { checks: { B2: { outcome: 'pass', reason: '已有记录' } }, dependencies: [{ id: 'f', check: 'B4' }] })
  const precedent = declaration('c', 'E-CASE', '（2025）测试1号', 'pass', { dependencies: [{ id: 'f', check: 'C4' }, { id: 'l', check: 'C6' }] })
  const card = runAnalysisSkill('chain', input([], { certificate: certificate([fact, law, precedent]) }))
  assert.match(card.breaks.join(), /交付.*待核/)
  assert.match(card.breaks.join(), /重新核对.*法条适配/)
  assert.match(card.breaks.join(), /重新核对.*类案命中/)
})

test('金额复算只接受已记录的材料算式，精确显示金额差异，过期及范围外出处降级', async () => {
  const { runAnalysisSkill } = await import('../src/assistant/analysis.ts')
  const source = { tier: 'l1', id: 'e1', name: '计息明细', locator: '第1页', quote: '1000元×10%×36天÷360' }
  const calculation = { kind: 'simple-interest', principal: 1000, rate: 0.1, days: 36, annualDays: 360, amount: 10, sources: [source] }
  const claim = declaration('d1', 'E-CALC', '1000元×10%×36天÷360=11元', 'fail', { calculation, differences: [{ field: '计息结果', document: '11元', source: '10元' }] })
  const materials = [material('e1', '计息明细', source.quote), material('e2', '无关回单', '利率未记载')]
  const card = runAnalysisSkill('calc', input(materials, { certificate: certificate([claim]) }))
  assert.match(card.formula[0], /1000元 × 10% × 36天 ÷ 360天/)
  assert.match(card.inputs[0], /计息明细.*第1页/)
  assert.match(card.result[0], /10元.*11元/)
  for (const extra of [{ materialIds: ['e2'], certificate: certificate([claim]) }, { certificate: certificate([claim], { linkageStale: true }) }]) {
    const pending = runAnalysisSkill('calc', input(materials, extra))
    assert.equal(pending.status, 'pending')
    assert.doesNotMatch(pending.result.join(), /10元|11元/)
  }
})

test('案件材料明列完整计息条件时可复算，缺年化基准时保持待核', async () => {
  const { runAnalysisSkill } = await import('../src/assistant/analysis.ts')
  const withFormula = runAnalysisSkill('calc', input([material('e1', '计息明细', '100,000元 × 9% × 54天 ÷ 360天 = 1300元。')]))
  assert.match(withFormula.formula[0], /100000元 × 9% × 54天 ÷ 360天/)
  assert.match(withFormula.inputs[0], /计息明细.*第1句/)
  assert.match(withFormula.result[0], /1350元.*1300元.*不符/)
  assert.equal(withFormula.status, 'pending')
  const incomplete = runAnalysisSkill('calc', input([material('e1', '计息明细', '100,000元 × 9% × 54天。')]))
  assert.match(incomplete.result[0], /待核/)
  assert.doesNotMatch(incomplete.formula.join(), /365|360|366/)
})

test('风险卡分别列缺源、原文冲突及补证动作', async () => {
  const { runAnalysisSkill } = await import('../src/assistant/analysis.ts')
  const conflict = declaration('d1', 'E-FACT', '被告尚未付款。', 'fail', { checks: { A2: { outcome: 'fail', reason: '正文与回单存在冲突。' } } })
  const missing = declaration('d2', 'E-FACT', '原告已交付。', 'miss', { checks: { A1: { outcome: 'miss', reason: '无对应签收单。' } } })
  const card = runAnalysisSkill('risk', input([material('e1', '回单扫描件', '银行回单复印件。')], { certificate: certificate([conflict, missing]) }))
  assert.match(card.risks.join(), /存在冲突/)
  assert.match(card.risks.join(), /无对应签收单/)
  assert.match(card.actions.join(), /原件/)
  assert.match(card.actions.join(), /补充.*出处/)
})

test('争议焦点按确认立场区分双方主张，无法判断归属的单列为争点', async () => {
  const { runAnalysisSkill } = await import('../src/assistant/analysis.ts')
  const current = input([
    material('e1', '对方起诉状', '原告主张被告尚欠借款。'),
    material('e2', '双方签字的庭审笔录', '争议焦点：借款是否已清偿？'),
  ], { position: { role: 'defendant', party: '被告', goals: ['驳回原告诉讼请求'], disputes: ['借款已清偿'], admissions: [], boundaries: [], confirmedAt: '2026-01-01', version: 1 } })
  const card = runAnalysisSkill('focus', current)
  assert.match(card.ourIssues.join(), /借款已清偿.*？/)
  assert.doesNotMatch(card.ourIssues.join(), /尚欠借款/)
  assert.match(card.theirIssues.join(), /被告尚欠借款.*？/)
  assert.match(card.shared.join(), /借款是否已清偿？/)
})

test('时间线仅记录选定案件卷内原文日期，按日期排序且相对日期待核', async () => {
  const { runAnalysisSkill } = await import('../src/assistant/analysis.ts')
  const card = runAnalysisSkill('timeline', input([
    material('e1', '送达回证', '2025年12月2日送达。次日收到回执。2025年2月30日签收。'),
    material('e2', '转账记录', '2025-01-10被告支付1000元。'),
    material('foreign', '其他案件秘密', '2024年12月2日签署。', { caseId: 'case-2' }),
  ]))
  assert.deepEqual(card.events.map(event => event.date), ['2025-01-10', '2025-12-02', null, null])
  assert.equal(card.events[0].material, '转账记录')
  assert.equal(card.events[0].loc, '第1句')
  assert.equal(card.events[2].status, 'pending')
  assert.match(card.events[2].event, /次日收到回执/)
  assert.ok(!JSON.stringify(card).includes('其他案件秘密'))
})

test('同句的绝对日期和相对日期分别呈现，不推算相对日期', async () => {
  const { runAnalysisSkill } = await import('../src/assistant/analysis.ts')
  const card = runAnalysisSkill('timeline', input([material('e1', '送达回证', '2025年12月2日送达，次日收到回执。')]))
  assert.deepEqual(card.events.map(event => [event.date, event.status]), [['2025-12-02', 'recorded'], [null, 'pending']])
  assert.match(card.events[1].event, /次日收到回执/)
})

test('六项分析在空材料时仍返回完整契约并明确待核', async () => {
  const { validateSkillOutput } = await import('../src/assistant/skill-contract.ts')
  const { isAnalysisSkill, runAnalysisSkill } = await import('../src/assistant/analysis.ts')
  for (const id of ['evidence', 'chain', 'calc', 'risk', 'focus', 'timeline']) {
    assert.equal(isAnalysisSkill(id), true)
    const card = runAnalysisSkill(id, input())
    assert.equal(card.status, 'pending', id)
    validateSkillOutput(id, card)
  }
  assert.equal(isAnalysisSkill('draft'), false)
})
