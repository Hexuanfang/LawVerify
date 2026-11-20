import assert from 'node:assert/strict'
import test from 'node:test'
import { createLegalCaseAdapter } from '../../src/integrations/legal-case.ts'
import { readOfficialCaseDetail } from '../../src/intelligence/official-case-verification.ts'

const caseNumber = '（2023）京01民终17号'
const reasoning = '双方存在借贷关系。'
const judgment = '驳回上诉，维持原判。'
const identity = { id: 'provider-17', case_number: caseNumber, name: '借款合同纠纷案', court: '北京市第一中级人民法院', judgment_date: '2023-05-17' }
const row = { ...identity, url: 'https://www.court.gov.cn/fixture/17', gist: reasoning,
  body: `北京市第一中级人民法院\n民事判决书\n${caseNumber}\n本院认为：${reasoning}\n判决如下：${judgment}\n审判长 某某\n二〇二三年五月十七日`,
  passages: [
    { kind: 'reasoning', locator: '第 2 页 · 本院认为', text: reasoning },
    { kind: 'operative', locator: '第 3 页 · 判决如下', text: judgment },
    { kind: 'operative', locator: '冒用判项定位', text: reasoning },
  ] }

test('语义和按案号检索仅返回索引，详情用原始 ID 获取且核对段落原文', async () => {
  const calls = []
  const adapter = createLegalCaseAdapter('fixture', async request => {
    calls.push(request)
    return { items: [row] }
  })
  const semantic = await adapter.search({ action: 'semantic', query: '民间借贷' })
  const exact = await adapter.search({ action: 'keyword', case_number: caseNumber })
  assert.deepEqual(semantic.items, exact.items)
  assert.equal(exact.items[0].id, 'provider-17')
  assert.equal(exact.items[0].body, undefined)
  assert.equal(exact.items[0].gist, undefined)
  const result = await adapter.detail({ id: exact.items[0].id, case_number: caseNumber })
  assert.deepEqual(calls, [
    { action: 'semantic', query: '民间借贷' }, { action: 'keyword', case_number: caseNumber }, { action: 'detail', id: 'provider-17' },
  ])
  assert.equal(result.outcome, 'found')
  assert.equal(result.provider, 'fixture')
  assert.deepEqual(result.item.passages.map(({ kind, locator }) => [kind, locator]), [
    ['reasoning', '第 2 页 · 本院认为'], ['operative', '第 3 页 · 判决如下'],
  ])
})

test('权威查无、无候选、无可核原文和请求失败的语义独立', async () => {
  const get = response => createLegalCaseAdapter('fixture', async () => response)
  const locator = { case_number: caseNumber }
  const negative = get({ outcome: 'authoritative-not-found' })
  assert.equal((await negative.search({ action: 'keyword', ...locator })).outcome, 'no-candidates')
  assert.equal((await negative.detail(locator)).outcome, 'authoritative-not-found')
  assert.equal((await get({ items: [] }).detail(locator)).outcome, 'empty-response')
  assert.equal((await get({ items: [{ ...row, body: undefined }] }).detail(locator)).outcome, 'unverified-detail')
  assert.equal((await get({ items: [{ ...row, url: 'https://www.court.gov.cn/' }] }).detail(locator)).outcome, 'unverified-detail')
  const timeout = createLegalCaseAdapter('fixture', async () => { throw new DOMException('受控超时', 'TimeoutError') })
  assert.equal((await timeout.detail(locator)).outcome, 'timeout')
})

test('官方页面从独立首部和签署区核对身份，网页错误不等同案号查无', async () => {
  const official = 'https://www.court.gov.cn/fixture/judgment-17'
  const html = `<article><p>案件名称：借款合同纠纷案</p><p>案件类型：普通案例</p><p>案由：民间借贷纠纷</p><p>${identity.court}</p>
    <p>民事判决书</p><p>${caseNumber}</p><p>本院认为：${reasoning}</p><p>判决如下：${judgment}</p>
    <p>本判决为终审判决。</p><p>审判长 某某</p><p>二〇二三年五月十七日</p></article>`
  const read = body => readOfficialCaseDetail(official, caseNumber, undefined, async () => new Response(body))
  const result = await read(html)
  assert.equal(result.outcome, 'found')
  assert.equal(result.item.name, identity.name)
  assert.equal(result.item.court, identity.court)
  assert.equal(result.item.judgment_date, identity.judgment_date)
  assert.equal(result.item.effect, 'effective')
  assert.equal(result.item.level, '普通案例')
  assert.equal((await read(html.replace(caseNumber, '（2023）京01民终18号') + `<p>曾检索${caseNumber}</p>`)).outcome, 'identity-mismatch')
  assert.equal((await readOfficialCaseDetail(official, caseNumber, undefined, async () => new Response('', { status: 403 }))).outcome, 'forbidden')
  assert.equal((await readOfficialCaseDetail(official, caseNumber, undefined, async () => new Response('', { status: 404 }))).outcome, 'unavailable')
  assert.equal((await readOfficialCaseDetail('https://user:pass@www.court.gov.cn/fixture/17', caseNumber, undefined,
    async () => assert.fail('不应请求含用户信息的地址'))).outcome, 'unverified-detail')
})

test('详情只接受当前判项，供应商摘录不能截去原文中的否定词', async () => {
  const priorRuling = '被告承担连带责任。'
  const currentRuling = '被告不承担连带责任。'
  const mixed = { ...row, body: `${identity.court}\n民事判决书\n${caseNumber}\n原审判项摘录：\n判决如下：${priorRuling}\n本院认为：责任不成立。\n判决如下：${currentRuling}`,
    passages: [{ kind: 'operative', locator: '原审原文', text: priorRuling }, { kind: 'operative', locator: '截断否定句', text: '承担连带责任。' }] }
  const adapter = createLegalCaseAdapter('fixture', async () => ({ items: [mixed] }))
  const result = await adapter.detail({ case_number: caseNumber })
  assert.equal(result.outcome, 'found')
  assert.deepEqual(result.item.passages.filter(item => item.kind === 'operative').map(item => item.text), [currentRuling])
})

test('详情全文须在本裁判首部核对案号，原审案号出现于正文不足以证实同一身份', async () => {
  const different = '（2023）京01民终18号'
  const mixed = { ...row, body: row.body.replace(caseNumber, `${different}\n此前审理的案号：\n${caseNumber}`) }
  const adapter = createLegalCaseAdapter('fixture', async () => ({ items: [mixed] }))
  assert.equal((await adapter.detail({ case_number: caseNumber })).outcome, 'unverified-detail')
})

test('从官方裁判理由提取可回查的主体、事实、争点和规则特征', async () => {
  const source = 'https://www.court.gov.cn/fixture/features-17'
  const body = `<p>案件名称：借款合同纠纷案</p><p>案由：民间借贷纠纷</p><p>案件类型：普通案例</p><p>${identity.court}</p><p>民事判决书</p><p>${caseNumber}</p>
    <p>当事人称案外人有用人单位的劳动合同。</p><p>本院认为：本案争议焦点是借贷关系是否成立。</p>
    <p>出借人提交借条原件和银行转账凭证，借款人确认收款。出借人应承担举证责任。</p>
    <p>判决如下：${judgment}</p><p>本判决为终审判决。</p><p>审判长 某某</p><p>二〇二三年五月十七日</p>`
  const result = await readOfficialCaseDetail(source, caseNumber, undefined, async () => new Response(body))
  assert.equal(result.outcome, 'found')
  assert.deepEqual(result.item.party_roles, ['出借人', '借款人'])
  assert.deepEqual(result.item.key_facts, ['借条原件', '银行转账'])
  assert.deepEqual(result.item.issues, ['借贷关系是否成立'])
  assert.deepEqual(result.item.rules, ['出借人举证'])
})
