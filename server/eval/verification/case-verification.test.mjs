import assert from 'node:assert/strict'
import test from 'node:test'
import { createLegalCaseAdapter } from '../../src/integrations/legal-case.ts'
import { extractDeclarations } from '../../src/intelligence/verification/extract.ts'
import { applyDeclarationDependencies } from '../../src/intelligence/verification/dependencies.ts'
import { classifyCaseSimilarity } from '../../src/intelligence/verification/case-context.ts'
import { verifyLegalDeclarations } from '../../src/intelligence/verification/legal.ts'

const appeal = '（2023）京01民终17号'
const first = '（2022）京0108民初28号'
const court = '北京市第一中级人民法院'
const reasoning = '出借人与借款人之间存在借贷关系。'
const ruling = '驳回上诉，维持原判。'
const caseText = `${court}\n民事判决书\n${appeal}\n上诉人不服${first}民事判决，提起上诉。\n本院认为：${reasoning}\n判决如下：${ruling}\n本判决为终审判决。`
const row = { id: 'case-17', name: '受控借款合同纠纷上诉案', case_number: appeal, court, judgment_date: '2023-05-17',
  url: 'https://www.court.gov.cn/fixture/appeal-17', body: caseText, effect: 'effective', level: 'ordinary', cause: '民间借贷纠纷',
  legal_relationship: '民间借贷', party_roles: ['出借人', '借款人'], key_facts: ['借条原件', '银行转账'], issues: ['借贷关系是否成立'],
  rules: ['出借人举证'], procedure: '二审', related_cases: [{ case_number: first, relation: 'prior' }],
  passages: [{ kind: 'reasoning', locator: '第 2 页 · 本院认为', text: reasoning }, { kind: 'operative', locator: '第 3 页 · 判决如下', text: ruling }],
}
const context = '民间借贷纠纷中，出借人向借款人交付借条原件并完成银行转账。争议焦点是借贷关系是否成立，适用出借人举证规则。'
const fixed = (rows = [row]) => async request => ({ items: request.action !== 'detail' ? rows : rows.filter(
  item => request.id ? item.id === request.id : item.case_number === request.case_number) })

async function verify(text, provider = fixed(), lead = context) {
  const document = { id: 'doc', docKey: 'ss', paragraphs: [{ id: 'context', text: lead }, { id: 'citations', text }] }
  const { declarations } = extractDeclarations(document)
  const facts = declarations.map(item => item.type === 'E-FACT' && item.location.paragraphId === 'context'
    ? { ...item, verdict: 'pass', sources: [{ tier: 'l1', id: 'fixture-material', name: '受控卷内材料', locator: '第 1 页' }] } : item)
  const evaluated = await verifyLegalDeclarations(document, facts, { knowledgeCases: [], knowledgeStatutes: [] },
    undefined, undefined, undefined, createLegalCaseAdapter('fixture', provider))
  return { cases: evaluated.filter(item => item.type === 'E-CASE'), evaluated }
}

test('权威查无才给 C1 fail，索引无全文、超时和相似案号保持各自状态', async () => {
  const quote = `参照${appeal}。`
  const missing = (await verify(quote, async () => ({ outcome: 'authoritative-not-found' }))).cases[0]
  assert.equal(missing.checks.C1.outcome, 'fail')
  assert.match(missing.reason, /案号未命中/u)
  for (const [response, outcome] of [[{ items: [] }, 'pending'], [{ outcome: 'timeout' }, 'pending'],
    [{ outcome: 'forbidden' }, 'pending'], [{ items: [{ ...row, body: undefined }] }, 'miss']]) {
    const [caseItem] = (await verify(quote, async () => response)).cases
    assert.equal(caseItem.checks.C1.outcome, outcome)
    assert.deepEqual(caseItem.sources, [])
  }
  const wrong = (await verify(quote, async () => ({ items: [{ ...row, case_number: first,
    body: caseText.replace(appeal, first) }] }))).cases[0]
  assert.equal(wrong.checks.C1.outcome, 'fail')
  assert.deepEqual(wrong.sources, [])
})

test('只有本地索引零候选、详情未查询时保持待核，不能判缺源或查无', async () => {
  const [item] = (await verify(`参照${appeal}。`, async request => request.action === 'detail'
    ? { outcome: 'not-queried' } : { items: [] })).cases
  assert.equal(item.checks.C1.outcome, 'pending')
  assert.equal(item.caseVerification.queryOutcome, 'no-candidates')
  assert.deepEqual(item.sources, [])
})

test('判决观点的引述词与详情中的实际原文分开核对', async () => {
  const [item] = (await verify(`参照${appeal}民事判决认定，${reasoning}`)).cases
  assert.equal(item.checks.C1.outcome, 'pass')
  assert.equal(item.sources[0].quote, reasoning)
  assert.equal(item.caseVerification.allowCitation, true)
})

test('相关性 0.50 与 0.75 使用闭区间下界，法律关系错配降级', () => {
  assert.deepEqual(classifyCaseSimilarity([0, 1, 0.99, 0, 0]), { score: 0.4975, match: 'irrelevant' })
  assert.deepEqual(classifyCaseSimilarity([0, 1, 1, 0, 0]), { score: 0.5, match: 'analogous' })
  assert.deepEqual(classifyCaseSimilarity([1, 1, 0.79, 0, 0]), { score: 0.7475, match: 'analogous' })
  assert.deepEqual(classifyCaseSimilarity([1, 1, 0.8, 0, 0]), { score: 0.75, match: 'strict' })
  assert.deepEqual(classifyCaseSimilarity([0, 1, 1, 1, 1]), { score: 0.7, match: 'analogous' })
})

test('详情确认身份、定位、五维得分和权威类型，并记录事实依赖', async () => {
  const { cases: [item] } = await verify(`参照${appeal}判项原文：“${ruling}”`)
  assert.deepEqual(Object.fromEntries(Object.entries(item.checks).map(([code, check]) => [code, check.outcome])), {
    C1: 'pass', C2: 'pass', C3: 'pass', C4: 'pass', C5: 'pass', C6: 'pass', C7: 'pass',
  })
  assert.equal(item.caseVerification.match, 'strict')
  assert.equal(item.caseVerification.score, 1)
  assert.equal(item.caseVerification.court, court)
  assert.equal(item.caseVerification.judgmentDate, '2023-05-17')
  assert.equal(item.caseVerification.level, 'ordinary')
  assert.deepEqual(item.sources.map(({ tier, locator, quote }) => [tier, locator, quote]), [['l3', '第 3 页 · 判决如下', ruling]])
  assert.ok(item.dependencies.some(edge => edge.check === 'C4'))
})

test('C3 记录各要素的匹配、差异和缺项', async () => {
  const incomplete = { ...row, cause: '劳动合同纠纷', party_roles: [] }
  const [item] = (await verify(`参照${appeal}判项原文：“${ruling}”`, fixed([incomplete]))).cases
  assert.equal(item.checks.C3.outcome, 'warn')
  assert.match(item.checks.C3.reason, /案由未匹配。主体待核。关键事实匹配。争议匹配。/u)
  assert.equal(item.caseVerification.match, 'analogous')
})

test('错误法院或裁判日期、判项反转、要旨冒充判项、普通案例升格均给 fail', async () => {
  for (const [text, code] of [
    [`参照${appeal}，法院：北京市第二中级人民法院。`, 'C1'],
    [`参照${appeal}，裁判日期：2023年5月18日。`, 'C1'],
    [`参照${appeal}判项原文：“支持上诉，撤销原判。”`, 'C1'],
    [`参照${appeal}判项原文：“${reasoning}”`, 'C1'],
    [`参照${appeal}判决支持上诉。`, 'C1'],
    [`参照${appeal}判项原文：“驳回上诉”，并载明“被告承担连带责任”。`, 'C1'],
    [`参照${appeal}要旨归纳：支持上诉，撤销原判。`, 'C1'],
    [`参照指导性案例${appeal}。`, 'C5'],
  ]) {
    const [item] = (await verify(text)).cases
    assert.equal(item.checks[code].outcome, 'fail', text)
    assert.equal(item.verdict, 'fail')
    assert.equal(item.caseVerification.allowCitation, false)
  }
})

test('已撤销裁判不能引用，废法依赖和事实回退只保留近似类比', async () => {
  const text = `参照${appeal}判项原文：“${ruling}”`
  const [vacated] = (await verify(text, fixed([{ ...row, effect: 'vacated' }]))).cases
  assert.equal(vacated.checks.C6.outcome, 'fail')
  assert.equal(vacated.caseVerification.allowCitation, false)
  const [old] = (await verify(text, fixed([{ ...row, relies_on_repealed_law: true }]))).cases
  assert.equal(old.checks.C6.outcome, 'warn')
  assert.equal(old.caseVerification.match, 'analogous')
  const { evaluated } = await verify(text)
  const cascaded = applyDeclarationDependencies(evaluated.map(item => item.type === 'E-FACT' ? { ...item, verdict: 'pending' } : item))
    .find(item => item.type === 'E-CASE')
  assert.equal(cascaded.checks.C4.outcome, 'warn')
  assert.equal(cascaded.caseVerification.match, 'analogous')
})

test('裁判依赖多条法条时，存在一条对应的声明也不能让 C6 提前通过', async () => {
  const tracked = '《民法典》第六百七十五条'
  const untracked = '《民法典》第五百七十七条'
  const [item] = (await verify(`依据${tracked}。参照${appeal}判项原文：“${ruling}”`,
    fixed([{ ...row, referenced_statutes: [tracked, untracked] }]))).cases
  assert.ok(item.dependencies.some(edge => edge.check === 'C6'))
  assert.equal(item.checks.C6.outcome, 'pending')
  assert.equal(item.caseVerification.allowCitation, false)
})

test('同案号的多份详情保留各自出处，多次引用仅计一案', async () => {
  const duplicate = { ...row, id: 'case-17-other', url: 'https://example.invalid/cases/appeal-17' }
  const { cases } = await verify(`参照${appeal}。另见${appeal}。`, fixed([row, duplicate]))
  assert.equal(cases.filter(item => item.caseVerification.counted).length, 1)
  assert.deepEqual(cases[0].caseVerification.documents.map(item => item.id), [row.id, duplicate.id])
})

test('裁判全文确认前后审关系后按同案计数，同时保留两份裁判', async () => {
  const trial = { ...row, id: 'case-28', case_number: first, url: 'https://www.court.gov.cn/fixture/trial-28',
    body: `${court}\n民事判决书\n${first}\n本院认为：${reasoning}\n判决如下：${ruling}`, related_cases: [], procedure: '一审' }
  const { cases } = await verify(`参照${appeal}。另见${first}。`, fixed([row, trial]))
  assert.equal(cases[0].caseVerification.groupId, cases[1].caseVerification.groupId)
  assert.equal(cases.filter(item => item.caseVerification.counted).length, 1)
  assert.deepEqual(new Set(cases[0].caseVerification.documents.map(item => item.caseNumber)), new Set([appeal, first]))
  assert.equal(cases[1].checks.C7.outcome, 'pass')
})

test('跨来源对同一裁判的效力有冲突时两种返回顺序均阻止引用', async () => {
  const conflicting = { ...row, id: 'conflicting-detail', effect: 'vacated', url: 'https://www.court.gov.cn/fixture/review-17' }
  for (const rows of [[row, conflicting], [conflicting, row]]) {
    const { cases: [item] } = await verify(`参照${appeal}判项原文：“${ruling}”`, fixed(rows))
    assert.equal(item.verdict, 'pending')
    assert.equal(item.caseVerification.allowCitation, false)
    assert.deepEqual(item.sources, [])
  }
})

test('同号出现在参照类案说明中不能构成前后审关系', async () => {
  const earlier = { ...row, body: caseText.replace(`上诉人不服${first}民事判决，提起上诉。`, `本案参照${first}民事判决的说理。`) }
  const trial = { ...row, id: 'unrelated-case-28', case_number: first, url: 'https://www.court.gov.cn/fixture/trial-28',
    body: `${court}\n民事判决书\n${first}\n本院认为：${reasoning}\n判决如下：${ruling}`, related_cases: [] }
  const { cases } = await verify(`参照${appeal}。另见${first}。`, fixed([earlier, trial]))
  assert.notEqual(cases[0].caseVerification.groupId, cases[1].caseVerification.groupId)
})

test('裁判理由提及当事人曾在另案上诉，不把另案合并为原审', async () => {
  const earlier = { ...row, body: caseText.replace(`上诉人不服${first}民事判决，提起上诉。`, '')
    .replace(reasoning, `${reasoning}原告曾在另案不服${first}民事判决。`) }
  const unrelated = { ...row, id: 'other-case-28', case_number: first, url: 'https://www.court.gov.cn/fixture/trial-28',
    body: `${court}\n民事判决书\n${first}\n本院认为：${reasoning}\n判决如下：${ruling}`, related_cases: [] }
  const { cases } = await verify(`参照${appeal}。另见${first}。`, fixed([earlier, unrelated]))
  assert.notEqual(cases[0].caseVerification.groupId, cases[1].caseVerification.groupId)
})

test('生效二审明确撤销原判时，旧索引仍标生效的一审也不允许引用', async () => {
  const current = { ...row, body: caseText.replace(ruling, '撤销原判。'), passages: [] }
  const older = { ...row, id: 'trial-case-28', case_number: first, url: 'https://www.court.gov.cn/fixture/trial-28',
    body: `${court}\n民事判决书\n${first}\n本院认为：${reasoning}\n判决如下：${ruling}`, related_cases: [], procedure: '一审' }
  const { cases } = await verify(`参照${appeal}。另见${first}判项原文：“${ruling}”`, fixed([current, older]))
  assert.equal(cases[1].checks.C6.outcome, 'fail')
  assert.equal(cases[1].caseVerification.allowCitation, false)
  assert.deepEqual(cases[1].sources, [])
})

test('文书只引一审时主动核对已定位的后审裁判，后审失联时待核', async () => {
  const current = { ...row, body: caseText.replace(ruling, '撤销原判。'), passages: [] }
  const older = { ...row, id: 'trial-case-28', case_number: first, url: 'https://www.court.gov.cn/fixture/trial-28',
    body: `${court}\n民事判决书\n${first}\n本案二审为${appeal}判决。\n本院认为：${reasoning}\n判决如下：${ruling}`,
    related_cases: [{ case_number: appeal, relation: 'appeal' }], procedure: '一审' }
  const text = `参照${first}判项原文：“${ruling}”`
  const { cases: [corrected] } = await verify(text, fixed([older, current]))
  assert.equal(corrected.checks.C6.outcome, 'fail')
  assert.equal(corrected.caseVerification.effect, 'vacated')
  assert.equal(corrected.caseVerification.allowCitation, false)
  assert.deepEqual(corrected.sources, [])

  const { cases: [unresolved] } = await verify(text, fixed([older]))
  assert.equal(unresolved.checks.C6.outcome, 'pending')
  assert.equal(unresolved.caseVerification.allowCitation, false)
  assert.deepEqual(unresolved.sources, [])
})
