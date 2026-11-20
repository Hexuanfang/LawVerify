import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { classifyCaseSimilarity, verifyLegalDeclarations } from '../../src/intelligence/verification/legal.ts'
import { createLegalStatuteAdapter } from '../../src/integrations/legal-statute.ts'
import { extractDeclarations } from '../../src/intelligence/verification/extract.ts'
import { applyDeclarationDependencies } from '../../src/intelligence/verification/dependencies.ts'

const law = '《测试法》第一条'
const caseNumber = '（2023）京01民终1号'
const make = (type, quote, start = 0) => ({ id: type + start, type, quote, location: { paragraphId: 'p', paragraphIndex: 0, start, end: start + quote.length }, verdict: 'pending', checks: {}, sources: [], reason: '', conf: null })
const article = { id: 'article', articleNumber: '第一条', content: '测试原文。', plainText: '测试原文。' }
const statute = { id: 'law', title: '测试法', effectiveStatus: 'effective', effectiveDate: '2020-01-01', version: '2020', sourceProvider: 'npc_flk', sourceDocumentId: 'test', sourceVerifiedAt: '2025-01-01', sourceUrl: 'https://flk.npc.gov.cn/detail2.html?bbbs=test', docType: '法律', articles: [article] }
const verify = (declarations, text, statutes = [statute], cases = []) => verifyLegalDeclarations({ paragraphs: [{ id: 'p', text }] }, declarations, { knowledgeStatutes: statutes, knowledgeCases: cases })

const detail = { id: 'article', law_name: '测试法', article_number: '第一条', text: '测试原文。',
  url: statute.sourceUrl, validity: 'VALID', version: '2020', effective_date: '2020-01-01' }
const verifyDetail = (quote, text, transport, official, context = []) => verifyLegalDeclarations(
  { paragraphs: [{ id: 'p', text }] }, [make('E-LAW', quote, text.indexOf(quote)), ...context],
  { knowledgeStatutes: [], knowledgeCases: [] }, createLegalStatuteAdapter(transport),
  undefined, official && createLegalStatuteAdapter(official),
)

test('权威详情查无判 B1 fail，普通检索空结果、超时和鉴权失败保持 pending', async () => {
  for (const [response, expected] of [
    [{ outcome: 'authoritative-not-found' }, 'fail'], [{ items: [] }, 'pending'],
    [{ outcome: 'timeout' }, 'pending'], [{ outcome: 'forbidden' }, 'pending'],
  ]) {
    const [result] = await verifyDetail(law, law, async () => response)
    assert.equal(result.checks.B1.outcome, expected)
    assert.equal(result.verdict, expected)
    assert.deepEqual(result.sources, [])
  }
})

test('详情必须匹配法名、条和款项，保留确切来源', async () => {
  const quote = '《测试法》第1条第2款第1项'
  const text = `2023年3月15日交付。${quote}：“测试原文。”`
  const matched = { ...detail, article_number: '第一条第二款第一项' }
  const [valid] = await verifyDetail(quote, text, async () => ({ items: [matched] }))
  assert.equal(valid.checks.B1.outcome, 'pass')
  assert.equal(valid.sources[0].locator, '第一条第二款第一项')
  for (const other of [detail, { ...matched, law_name: '其他测试法' }, { ...matched, article_number: '第一条第三款第一项' }]) {
    const [invalid] = await verifyDetail(quote, text, async () => ({ items: [other] }))
    assert.equal(invalid.checks.B1.outcome, 'miss')
    assert.deepEqual(invalid.sources, [])
  }
})

test('陈旧候选 ID 查无后按原法名和条号复查，保留同一条款的新详情', async () => {
  const [result] = await verifyDetail(law, law, async request => {
    if (request.action === 'search_article') return { items: [{ ...detail, id: 'stale-id' }] }
    if (request.id) return { outcome: 'authoritative-not-found' }
    assert.equal(request.law_name, '测试法')
    assert.equal(request.article_number, '第一条')
    return { items: [detail] }
  })
  assert.equal(result.checks.B1.outcome, 'pass')
  assert.equal(result.sources[0].id, 'article')
})

test('废止日期当天起排除旧版本，废止前的历史适用单独记录', async () => {
  const response = async () => ({ items: [{ ...detail, validity: 'REPEALED', repeal_date: '2021-01-01' }] })
  const [old] = await verifyDetail(law, `2020年3月15日交付。${law}：“测试原文。”`, response)
  assert.equal(old.statuteVerification.validity, 'REPEALED')
  assert.equal(old.statuteVerification.applicability, 'applicable')
  assert.equal(old.statuteVerification.factDate, '2020-03-15')
  assert.equal(old.checks.B2.outcome, 'warn')
  const [recent] = await verifyDetail(law, `2021年1月1日交付。${law}：“测试原文。”`, response)
  assert.equal(recent.statuteVerification.applicability, 'inapplicable')
  assert.equal(recent.checks.B2.outcome, 'fail')
  const [ambiguous] = await verifyDetail(law, `2020年3月15日交付，2021年3月15日续签。${law}：“测试原文。”`, response)
  assert.equal(ambiguous.statuteVerification.applicability, 'uncertain')
  assert.equal(ambiguous.checks.B2.outcome, 'warn')
  const [publication] = await verifyDetail(law, `该解释于2023年3月15日发布。${law}：“测试原文。”`, response)
  assert.equal(publication.statuteVerification.factDate, undefined)
  assert.equal(publication.checks.B2.outcome, 'warn')
})

test('七态保留原始效力语义，效力存疑、尚未生效和置信度不足不通过', async () => {
  const variants = [
    ['现行有效', 'VALID', 'pass'], ['已修订', 'AMENDED', 'warn'], ['部分失效', 'PARTIAL', 'warn'],
    ['已废止', 'REPEALED', 'warn'], ['已失效', 'EXPIRED', 'warn'], ['尚未生效', 'PENDING', 'warn'], ['未知状态', 'UNCERTAIN', 'warn'],
  ]
  for (const [validity, normalized, outcome] of variants) {
    const [result] = await verifyDetail(law, `2023年3月15日交付。${law}：“测试原文。”`, async () => ({ items: [{ ...detail, validity }] }))
    assert.equal(result.statuteVerification.validity, normalized)
    assert.equal(result.checks.B2.outcome, outcome)
  }
  const [medium] = await verifyDetail(law, `2023年3月15日交付。${law}：“测试原文。”`, async () => ({ items: [{ ...detail, url: 'https://example.invalid/database/1' }] }))
  assert.equal(medium.statuteVerification.confidence, 'MEDIUM')
  assert.equal(medium.checks.B2.outcome, 'warn')
})

test('有明确官方发布与废止日期时采用官方原文并留两轨证据', async () => {
  const [result] = await verifyDetail(law, `2023年3月15日交付。${law}：“测试原文。”`,
    async () => ({ items: [{ ...detail, url: 'https://example.invalid/database/1' }] }),
    async () => ({ items: [{ ...detail, id: 'official', validity: 'REPEALED', repeal_date: '2021-01-01' }] }),
  )
  assert.equal(result.checks.B2.outcome, 'fail')
  assert.equal(result.statuteVerification.provider.url, 'https://example.invalid/database/1')
  assert.equal(result.statuteVerification.official.url, statute.sourceUrl)
  assert.equal(result.sources[0].id, 'official')
  assert.match(result.checks.B2.reason, /采用官方详情/u)
})

test('工作区多版同条按可证实的事实期间取详情，重叠或无时点保持待核', async () => {
  const old = { ...statute, id: 'stored-old', version: '旧版', effectiveStatus: 'repealed', effectiveDate: '2019-01-01',
    publishDate: '2018-01-01', revisionDate: '2021-01-01', sourceVerifiedAt: '2025-01-01',
    articles: [{ ...article, id: 'old-detail', plainText: '旧版原文。' }] }
  const current = { ...statute, id: 'stored-current', version: '新版', effectiveDate: '2021-01-01', sourceVerifiedAt: '2025-01-01',
    articles: [{ ...article, id: 'new-detail', plainText: '新版原文。' }] }
  const run = (prefix, quote, rows = [old, current]) => verify([make('E-LAW', law, prefix.length)], `${prefix}${law}：“${quote}”`, rows)
  const [historic] = await run('2020年3月2日交付。', '旧版原文。')
  assert.equal(historic.statuteVerification.applicability, 'applicable')
  assert.equal(historic.sources[0].id, 'old-detail')
  assert.equal(historic.checks.B3.outcome, 'pass')
  const [recent] = await run('2023年3月2日交付。', '新版原文。')
  assert.equal(recent.checks.B2.outcome, 'pass')
  assert.equal(recent.sources[0].id, 'new-detail')
  const [ambiguous] = await run('2023年3月2日交付。', '新版原文。', [{ ...old, revisionDate: undefined }, current])
  assert.equal(ambiguous.checks.B2.outcome, 'warn')
  assert.deepEqual(ambiguous.sources, [])
  const [undated] = await run('', '新版原文。')
  assert.deepEqual(undated.sources, [])
})

test('B3 保留引文差异；取得详情后可标出明确的要旨归纳', async () => {
  const transport = async () => ({ items: [detail] })
  const [altered] = await verifyDetail(law, `${law}：“错误原文。”`, transport)
  assert.equal(altered.checks.B3.outcome, 'fail')
  assert.deepEqual(altered.differences, [{ field: '引文', document: '错误原文。', source: '测试原文。' }])
  const [summary] = await verifyDetail(law, `${law}（要旨归纳）：测试条文的含义。`, transport)
  assert.equal(summary.checks.B3.outcome, 'warn')
  const [citationOnly] = await verifyDetail(law, `${law}。下一段说明要旨归纳。`, transport)
  assert.equal(citationOnly.checks.B3.outcome, 'miss')
})

const loan = { ...detail, law_name: '民法典', article_number: '第六百七十五条',
  text: '借款人应当按照约定的期限返还借款。', doc_type: '法律', issuer: '全国人民代表大会' }
const sale = { ...detail, id: 'sale', law_name: '民法典', article_number: '第六百二十六条',
  text: '买受人应当按照约定的数额和支付方式支付价款。', doc_type: '法律', issuer: '全国人民代表大会' }

const cite = provision => `依据《${provision.law_name}》${provision.article_number}：“${provision.text}”`

async function verifyDocument(texts, provisions = [loan], { facts = [], docKey = 'qs', failLookups = false } = {}) {
  const certificate = { id: 'statute-rules', docKey, paragraphs: texts.map((text, index) => ({ id: `p${index}`, text })) }
  const { declarations } = extractDeclarations(certificate)
  const anchored = declarations.map(item => item.type === 'E-FACT' && facts.includes(item.quote) ? { ...item, verdict: 'pass',
    sources: [{ tier: 'l1', name: '受控材料', id: 'material', locator: item.location.paragraphId }] } : item)
  const adapter = createLegalStatuteAdapter(async request => failLookups ? { outcome: 'timeout' } : { items:
    provisions.filter(item => request.id ? request.id === item.id : request.law_name === item.law_name && request.article_number === item.article_number) })
  return verifyLegalDeclarations(certificate, anchored, { knowledgeStatutes: [], knowledgeCases: [] }, adapter)
}

async function verifyRequest({ request, provision, prefix = '', fact, docKey = 'qs' }) {
  const lawQuote = provision && `《${provision.law_name}》${provision.article_number}`
  const parts = [fact?.quote, request, lawQuote && `${prefix}${lawQuote}：“${provision.text}”`].filter(Boolean)
  const text = parts.join('，')
  const claim = make('E-CLAIM', request, text.indexOf(request))
  const declarations = [claim]
  if (fact) declarations.push({ ...make('E-FACT', fact.quote, text.indexOf(fact.quote)), ...fact })
  if (lawQuote) declarations.push(make('E-LAW', lawQuote, text.indexOf(lawQuote)))
  return verifyLegalDeclarations({ docKey, paragraphs: [{ id: 'p', text }] }, declarations,
    { knowledgeStatutes: [], knowledgeCases: [] }, createLegalStatuteAdapter(async () => ({ items: provision ? [provision] : [] })))
}

test('B4 仅根据对应请求和已核事实判断适配并记录依赖', async () => {
  const fact = { quote: '2023年3月15日交付借款本金且约定还款期已届满', verdict: 'pass',
    sources: [{ tier: 'l1', id: 'loan-contract', locator: '第 1 页', name: '借款合同' }] }
  const request = '请求判令被告返还借款本金'
  const aligned = (await verifyRequest({ request, provision: loan, fact })).at(-1)
  assert.equal(aligned.checks.B4.outcome, 'pass')
  assert.deepEqual(aligned.dependencies, [{ id: 'E-FACT0', check: 'B4' }])
  const wrong = (await verifyRequest({ request, provision: sale, fact })).at(-1)
  assert.equal(wrong.checks.B4.outcome, 'fail')
  const unproven = (await verifyRequest({ request, provision: loan, fact: { ...fact, verdict: 'pending', sources: [] } })).at(-1)
  assert.equal(unproven.checks.B4.outcome, 'pending')
  const negated = (await verifyRequest({ request, provision: loan, fact: { ...fact, quote: '2023年3月15日未交付借款本金且约定还款期已届满' } })).at(-1)
  assert.equal(negated.checks.B4.outcome, 'warn')
  const firstInstance = { ...detail, doc_type: '法律', text: '第一审人民法院应当自受理之日起依法审理。' }
  const wrongStage = (await verifyRequest({ request: '请求撤销原判并改判', provision: firstInstance, prefix: '依据', docKey: 'ss' })).at(-1)
  assert.equal(wrongStage.checks.B4.outcome, 'fail')
})

test('B5 校验规范层级与可证实的适用地域', async () => {
  const request = '请求判令被告返还借款本金'
  assert.equal((await verifyRequest({ request, provision: loan })).at(-1).checks.B5.outcome, 'pass')
  const regulation = { ...detail, doc_type: '部门规章', issuer: '某部门' }
  assert.equal((await verifyRequest({ request, provision: regulation, prefix: '依据法律' })).at(-1).checks.B5.outcome, 'fail')
  const local = { ...regulation, doc_type: '地方性法规', issuer: '北京市人大常委会', region: '北京市' }
  const fact = { quote: '合同履行地为上海市', verdict: 'pass', sources: [{ tier: 'l1', name: '合同', id: 'contract', locator: '第 1 页' }] }
  assert.equal((await verifyRequest({ request, provision: local, fact })).at(-1).checks.B5.outcome, 'fail')
  assert.equal((await verifyRequest({ request, provision: { ...regulation, doc_type: '规范性文件' } })).at(-1).checks.B5.outcome, 'warn')
})

test('B6 按请求区分依据齐备、部分遗漏和正文完全缺依据', async () => {
  const fact = { quote: '2023年3月15日交付借款本金且约定还款期已届满', verdict: 'pass',
    sources: [{ tier: 'l1', id: 'loan-contract', locator: '第 1 页', name: '借款合同' }] }
  const request = '请求判令被告返还借款本金'
  assert.equal((await verifyRequest({ request, provision: loan, fact }))[0].checks.B6.outcome, 'pass')
  const [partial] = await verifyRequest({ request: `${request}并支付利息`, provision: loan, fact })
  assert.equal(partial.checks.B6.outcome, 'warn')
  assert.match(partial.checks.B6.reason, /利息/u)
  const [missing] = await verifyRequest({ request, fact })
  assert.equal(missing.checks.B6.outcome, 'miss')
  assert.equal(missing.verdict, 'miss')
  assert.equal(missing.location.start, `${fact.quote}，`.length)
  assert.equal((await verifyRequest({ request, provision: sale, fact }))[0].checks.B6.outcome, 'miss')
})

test('已抽取但暂无分类规则的请求，全文缺法条时仍报告 B6', async () => {
  const certificate = { id: 'request-no-basis', docKey: 'qs', paragraphs: [{ id: 'p', text: '请求判令被告停止侵害。' }] }
  const { declarations } = extractDeclarations(certificate)
  const [request] = (await verifyLegalDeclarations(certificate, declarations, { knowledgeStatutes: [], knowledgeCases: [] }))
    .filter(item => item.type === 'E-CLAIM')
  assert.equal(request.checks.B6.outcome, 'miss')
  assert.equal(request.verdict, 'miss')
})

test('B4 跨段关联唯一请求和已核事实，保留所用事实声明的依赖', async () => {
  const fact = '2023年3月15日交付借款本金且约定还款期已届满。'
  const result = await verifyDocument(['请求判令被告返还借款本金。', fact, cite(loan)], [loan], { facts: [fact] })
  const item = result.find(entry => entry.type === 'E-LAW')
  assert.equal(item.checks.B4.outcome, 'pass')
  assert.deepEqual(item.dependencies, [{ id: result.find(entry => entry.type === 'E-FACT').id, check: 'B4' }])
  assert.equal(result.find(entry => entry.type === 'E-CLAIM').checks.B6.outcome, 'pass')
})

test('冻结种子 q1 → q6 在受控法源及补充事实下重开 B4，修复后保留独立的 B3 阻断', async () => {
  const seed = JSON.parse(readFileSync(new URL('./fixtures/seed/documents.json', import.meta.url), 'utf8')).find(item => item.id === 'c1-qs')
  const texts = ['请求判令被告偿还借款本金。', seed.paragraphs[1], '原告已交付借款本金且约定还款期限已届满。', seed.paragraphs[6]]
  const document = { id: seed.id, docKey: seed.docKey, paragraphs: texts.map((text, index) => ({ id: `p${index}`, text })) }
  const { declarations } = extractDeclarations(document)
  const q1 = declarations.find(item => item.type === 'E-FACT' && item.location.paragraphId === 'p1' && item.quote.includes('借条'))
  const q6 = declarations.find(item => item.type === 'E-LAW' && item.location.paragraphId === 'p3' && item.quote.includes('第六百七十五条'))
  assert.ok(q1 && q6)
  const adapter = createLegalStatuteAdapter(async request => request.article_number === loan.article_number || request.id === loan.id
    ? { items: [loan] } : { outcome: 'not-queried' })
  const run = async pass => applyDeclarationDependencies(await verifyLegalDeclarations(document,
    declarations.map(item => item.type === 'E-FACT' ? { ...item, verdict: item.id === q1.id && !pass ? 'pending' : 'pass',
      sources: [{ id: 'fixture', tier: 'l1', name: '受控借款凭证', quote: item.quote, locator: '第 1 页' }] } : item),
    { knowledgeStatutes: [], knowledgeCases: [] }, adapter)).find(item => item.id === q6.id)
  const pending = await run(false)
  assert.equal(pending.checks.B4.outcome, 'pending')
  assert.ok(pending.dependencies.some(edge => edge.id === q1.id && edge.check === 'B4'))
  const repaired = await run(true)
  assert.equal(repaired.checks.B4.outcome, 'pass')
  assert.equal(repaired.checks.B3.outcome, 'miss')
  assert.equal(repaired.verdict, 'miss')
})

test('B4 对跨段的审级错配判 fail，且不拼接不同合同的已核事实', async () => {
  const first = { ...loan, text: '第一审人民法院应当自受理之日起依法审理。' }
  const mismatched = await verifyDocument(['请求撤销原判并改判。', cite(first)], [first], { docKey: 'ss' })
  assert.equal(mismatched.find(item => item.type === 'E-LAW').checks.B4.outcome, 'fail')
  const fact1 = '2023年3月15日交付第一笔借款本金。'
  const fact2 = '另案已经到期，被告确认第二笔借款的还款期限已届满。'
  const separated = await verifyDocument(['请求判令被告返还借款本金。', fact1, fact2, cite(loan)], [loan], { facts: [fact1, fact2] })
  assert.equal(separated.find(item => item.type === 'E-LAW').checks.B4.outcome, 'warn')
})

test('B5 核对发文主体、用途和跨段的已核履行地', async () => {
  const wrongIssuer = { ...loan, issuer: '北京市人民政府' }
  const wrong = await verifyDocument([cite(wrongIssuer)], [wrongIssuer])
  assert.equal(wrong.find(item => item.type === 'E-LAW').checks.B5.outcome, 'fail')
  const informal = { ...loan, doc_type: '规范性文件', issuer: '北京市人民政府' }
  const formal = await verifyDocument([`将《${informal.law_name}》${informal.article_number}作为裁判依据。`], [informal])
  assert.equal(formal.find(item => item.type === 'E-LAW').checks.B5.outcome, 'fail')
  const local = { ...loan, doc_type: '地方性法规', issuer: '广东省人民代表大会常务委员会', region: '广东省' }
  const fact = '合同在广东省深圳市交付货物，履行地为广东省深圳市。'
  const valid = await verifyDocument(['请求判令被告支付货款。', fact, cite(local)], [local], { facts: [fact] })
  assert.equal(valid.find(item => item.type === 'E-LAW').checks.B5.outcome, 'pass')
})

test('B5 根据已核规范类型核对正文明确主张的冲突取舍', async () => {
  const upper = { ...loan, law_name: '上位测试法', article_number: '第一条' }
  const lower = { ...sale, law_name: '配套测试规定', article_number: '第一条', doc_type: '部门规章', issuer: '国家市场监督管理总局' }
  const text = '《上位测试法》第一条与《配套测试规定》第一条冲突，优先适用后者。'
  const rules = (await verifyDocument([text], [upper, lower])).filter(item => item.type === 'E-LAW')
  assert.equal(rules[1].checks.B5.outcome, 'fail')
  const sameLevel = { ...lower, doc_type: '法律', issuer: '全国人民代表大会常务委员会' }
  const conflict = (await verifyDocument([text], [upper, sameLevel])).filter(item => item.type === 'E-LAW')
  assert.ok(conflict.every(item => item.checks.B5.outcome === 'warn' && /同位阶/u.test(item.checks.B5.reason)))
})

test('B5 不把否定的优先适用表述当成下位规范优先', async () => {
  const upper = { ...loan, law_name: '上位测试法', article_number: '第一条' }
  const lower = { ...sale, law_name: '配套测试规定', article_number: '第一条', doc_type: '部门规章', issuer: '国家市场监督管理总局' }
  for (const choice of ['不优先适用后者', '不应优先适用后者', '不能优先适用后者']) {
    const text = `《上位测试法》第一条与《配套测试规定》第一条冲突，${choice}。`
    const rules = (await verifyDocument([text], [upper, lower])).filter(item => item.type === 'E-LAW')
    assert.equal(rules.length, 2)
    assert.ok(rules.every(item => item.checks.B5.outcome === 'warn'), choice)
  }
})

test('B6 不跨请求借用已有引文，仍待取详情的关联引用保留 pending', async () => {
  const fact = '2023年3月15日交付借款本金且约定还款期已届满。'
  const texts = [`请求判令被告支付货款，${cite(loan)}`, '请求判令被告返还借款本金。', fact]
  const result = await verifyDocument(texts, [loan], { facts: [fact] })
  assert.deepEqual(result.filter(item => item.type === 'E-CLAIM').map(item => item.checks.B6.outcome), ['miss', 'miss'])
  const unqueried = await verifyDocument(['请求判令被告返还借款本金。', cite(loan)], [loan], { failLookups: true })
  assert.equal(unqueried.find(item => item.type === 'E-CLAIM').checks.B6.outcome, 'pending')
})

test('B6 已失效的条文和只有条号的引用不能掩盖依据遗漏', async () => {
  const fact = '2023年3月15日交付借款本金且约定还款期已届满。'
  const request = '请求判令被告返还借款本金。'
  const expired = { ...loan, validity: 'REPEALED', repeal_date: '2022-01-01' }
  const wrong = await verifyDocument([fact, request, cite(expired)], [expired], { facts: [fact] })
  assert.equal(wrong.find(item => item.type === 'E-LAW').checks.B2.outcome, 'fail')
  assert.equal(wrong.find(item => item.type === 'E-CLAIM').checks.B6.outcome, 'miss')
  const bare = await verifyDocument([fact, request, `《${loan.law_name}》${loan.article_number}。`], [loan], { facts: [fact] })
  assert.equal(bare.find(item => item.type === 'E-LAW').checks.B3.outcome, 'miss')
  assert.equal(bare.find(item => item.type === 'E-CLAIM').checks.B6.outcome, 'miss')
  const unassigned = await verifyDocument([fact, request, '请求判令被告支付货款。', cite(expired)], [expired], { facts: [fact] })
  assert.deepEqual(unassigned.filter(item => item.type === 'E-CLAIM').map(item => item.checks.B6.outcome), ['miss', 'miss'])
})

test('已核替代条文独立于旧引用，未知详情仅提示，采纳后按新引用重核', async () => {
  const oldCitation = '《合同法》第一百零七条'
  const newCitation = '《民法典》第五百七十七条'
  const legalText = '当事人一方不履行合同义务，应当承担违约责任。'
  const old = { ...detail, id: 'old', law_name: '合同法', article_number: '第一百零七条', text: legalText,
    validity: 'REPEALED', effective_date: '1999-10-01', repeal_date: '2021-01-01' }
  const updated = { ...detail, id: 'new', law_name: '民法典', article_number: '第五百七十七条', text: legalText,
    effective_date: '2021-01-01', version: '2021' }
  const transport = (replacement) => async request => ({ items: [request.id === 'old' || request.law_name === '合同法' ? old : replacement] })
  const fact = '2023年3月15日签订借款合同，被告到期未履行还款义务。'
  const prefix = `${fact}请求被告承担违约责任。`
  const facts = [{ ...make('E-FACT', fact), verdict: 'pass', sources: [{ tier: 'l1', name: '借款合同与催告回执', id: 'contract', locator: '第 1 页' }] }]
  const request = make('E-CLAIM', '请求被告承担违约责任。', fact.length)
  const [failed] = await verifyDetail(oldCitation, `${prefix}${oldCitation}：“${legalText}”`, transport(updated), undefined, [...facts, request])
  assert.equal(failed.checks.B2.outcome, 'fail')
  assert.equal(failed.verdict, 'fail')
  assert.deepEqual(failed.sources.map(item => item.id), ['old'])
  assert.deepEqual(failed.verifiedSources.map(item => item.id), ['new'])
  assert.equal(failed.verifiedText, `${newCitation}：“${legalText}”`)
  const [unverified] = await verifyDetail(oldCitation, `${prefix}${oldCitation}：“${legalText}”`, transport({ ...updated, text: '' }), undefined, [...facts, request])
  assert.equal(unverified.verifiedText, undefined)
  assert.equal(unverified.verifiedSources, undefined)
  assert.match(unverified.checks.B2.reason, /替代条文待核/u)
  const otherRequest = make('E-CLAIM', '请求判令停止侵害。', fact.length)
  const [wrong] = await verifyDetail(oldCitation, `${fact}${otherRequest.quote}${oldCitation}：“${legalText}”`, transport(updated), undefined, [...facts, otherRequest])
  assert.equal(wrong.verifiedText, undefined)
  assert.equal(wrong.verifiedSources, undefined)
  const [accepted] = await verifyDetail(newCitation, prefix + failed.verifiedText, transport(updated))
  assert.equal(accepted.checks.B2.outcome, 'pass')
  assert.deepEqual(accepted.sources.map(item => item.id), ['new'])
  assert.equal(accepted.verifiedText, undefined)
})

test('通过检索找到其他失效条文的适用替代，多个同样适用的候选不可自动采纳', async () => {
  const oldCitation = '《合同法》第一百五十九条'
  const text = '买受人应当按照约定的数额支付价款。'
  const old = { ...detail, id: 'old-sale', law_name: '合同法', article_number: '第一百五十九条', text,
    validity: 'REPEALED', effective_date: '1999-10-01', repeal_date: '2021-01-01' }
  const replacement = { ...detail, id: 'new-sale', law_name: '民法典', article_number: '第六百二十六条', text,
    effective_date: '2021-01-01', issuer: '全国人民代表大会', doc_type: '法律' }
  const other = { ...replacement, id: 'other', law_name: '受控买卖法', article_number: '第九条' }
  const unrelated = { ...replacement, id: 'loan', article_number: '第六百七十五条', text: '借款人应当按照约定的期限返还借款。' }
  const fact = '2023年3月15日卖方交付了货物，合同约定货款为100元。'
  const claim = '请求判令被告支付货款。'
  const context = [{ ...make('E-FACT', fact), verdict: 'pass', sources: [{ tier: 'l1', id: 'sale', name: '买卖合同与交货凭证' }] },
    make('E-CLAIM', claim, fact.length)]
  const run = candidates => verifyDetail(oldCitation, `${fact}${claim}${oldCitation}：“${text}”`, async request => {
    if (request.action === 'semantic') {
      assert.equal(request.refer_date, '2023-03-15')
      return { items: candidates }
    }
    return { items: [old, ...candidates.filter(item => item !== old)].filter(item => request.id ? item.id === request.id
      : item.law_name === request.law_name && item.article_number === request.article_number) }
  }, undefined, context)
  const [result] = await run([old, unrelated, replacement])
  assert.equal(result.verdict, 'fail')
  assert.deepEqual(result.sources.map(item => item.id), ['old-sale'])
  assert.deepEqual(result.verifiedSources?.map(item => item.id), ['new-sale'])
  assert.equal(result.verifiedText, `《民法典》第六百二十六条：“${text}”`)
  const [ambiguous] = await run([replacement, other])
  assert.equal(ambiguous.verifiedText, undefined)
  assert.match(ambiguous.checks.B2.reason, /替代条文待核/u)
})

test('法条缺正文、无可信出处和错误引文不能放行；准确引文的事实适配仍需复核', async () => {
  const declaration = make('E-LAW', law)
  assert.equal((await verify([declaration], law, []))[0].verdict, 'miss')
  assert.equal((await verify([declaration], law, [{ ...statute, sourceUrl: undefined }]))[0].verdict, 'miss')
  assert.equal((await verify([declaration], law, [{ ...statute, articles: [{ ...article, plainText: '官方原文已定位' }] }]))[0].verdict, 'miss')
  assert.equal((await verify([declaration], `${law}：“错误原文。”`))[0].checks.B3.outcome, 'fail')
  const [exact] = await verify([declaration], `${law}：“测试原文。”`)
  assert.equal(exact.checks.B3.outcome, 'pass')
  assert.equal(exact.checks.B4.outcome, 'pending')
  assert.notEqual(exact.verdict, 'pass')
})

test('法条序号允许同义数字写法，B3 仅忽略空白和中英文逗号', async () => {
  const citation = '《测试法》第1条'
  const source = '不予支持，另有规定的除外。'
  const document = { ...statute, articles: [{ ...article, plainText: source }] }
  const declaration = make('E-LAW', citation)
  for (const quote of [source, '不予支持另有规定的除外。', '不予支持,\n 另有规定的除外。']) {
    const [result] = await verify([declaration], `${citation}：“${quote}”`, [document])
    assert.equal(result.checks.B1.outcome, 'pass', quote)
    assert.equal(result.checks.B3.outcome, 'pass', quote)
    assert.equal(result.differences, undefined, quote)
  }
  for (const quote of ['不予支持，另有规定的除外', '不予支持，另有规定的除外.', '不予支持；另有规定的除外。',
    '不予支持，另有规定的例外。', '不予支持，另有规定的外。']) {
    const [result] = await verify([declaration], `${citation}：“${quote}”`, [document])
    assert.equal(result.checks.B3.outcome, 'fail', quote)
    assert.equal(result.verdict, 'fail', quote)
    assert.deepEqual(result.differences, [{ field: '引文', document: quote, source }])
  }
})

test('B3 句号差异阻断审阅版与清洁版 Word 的共用导出入口', async () => {
  const { exportCertificateToWord } = await import('../../../app/src/export-word.ts')
  const { DEFAULT_EXPORT_OPTIONS } = await import('../../../app/src/export-context.ts')
  const text = `${law}：“测试原文”`
  const [result] = await verify([make('E-LAW', law)], text)
  assert.equal(result.checks.B3.outcome, 'fail')
  const workspace = { evidences: [], certificates: [{ id: 'quote-doc', linkageInputKey: 'current',
    paragraphs: [{ id: 'p', text }], verification: { inputKey: 'current', declarations: [result] } }] }
  const download = () => assert.fail('被阻断的导出不得创建下载链接')
  const oldCreateObjectURL = URL.createObjectURL
  URL.createObjectURL = download
  try {
    for (const review of [true, false]) {
      await assert.rejects(exportCertificateToWord(workspace, 'quote-doc', { appVersion: 'test',
        options: { ...DEFAULT_EXPORT_OPTIONS, useWordComments: review, bodyAnnotations: review } }),
      /还有 1 项不通过、缺源或待核验/u)
    }
  } finally {
    URL.createObjectURL = oldCreateObjectURL
  }
})

test('可识别的旧法不被默认当现行，新法期失效与时点不明分开', async () => {
  const text = `2025年3月2日交付。${law}：“测试原文。”`
  const declaration = make('E-LAW', law, text.indexOf(law))
  const old = { ...statute, effectiveStatus: 'repealed', revisionDate: '2021-01-01' }
  assert.equal((await verify([declaration], text, [old, { ...statute, id: 'replacement', version: '2021', effectiveDate: '2021-01-01' }]))[0].checks.B2.outcome, 'warn')
  assert.equal((await verify([declaration], text, [old]))[0].checks.B2.outcome, 'warn')
  const dated = { ...old, sourceVerifiedAt: '2026-01-01', publishDate: '2019-01-01' }
  assert.equal((await verify([declaration], text, [dated]))[0].checks.B2.outcome, 'fail')
  assert.equal((await verify([declaration], text, [{ ...dated, publishDate: '2021-01-01' }]))[0].checks.B2.outcome, 'warn')
})

test('案例索引要旨不能当判决原文，五维阈值不取整', async () => {
  const declaration = make('E-CASE', caseNumber)
  const candidate = { id: 'case', caseNumber, title: '测试案例', courtName: '某法院', judgmentDate: '2023-05-01', sourceUrl: 'https://www.court.gov.cn/test', excerpts: [{ content: '仅供检索的要旨', locator: '本院认为' }] }
  const [result] = await verify([declaration], caseNumber, [], [candidate])
  assert.equal(result.verdict, 'miss')
  assert.equal(result.checks.C1.outcome, 'miss')
  assert.deepEqual(result.sources, [])
  assert.equal(classifyCaseSimilarity([0, 1, 1, 0, 0]).match, 'analogous')
  assert.equal(classifyCaseSimilarity([1, 1, 0.8, 0, 0]).match, 'strict')
  assert.equal(classifyCaseSimilarity([0, 1, 0.99, 0, 0]).match, 'irrelevant')
})
