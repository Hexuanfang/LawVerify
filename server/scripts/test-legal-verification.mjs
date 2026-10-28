import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inspectLegalText, rankCases, isValidCaseNumber, normalizeCaseNumber, isOfficialCaseUrl, extractStatuteCitations } from '../src/intelligence/legal-verification.ts'
import { checkOfficialJudgment } from '../src/intelligence/official-case-verification.ts'

const law = (overrides = {}) => ({
  id: 'law', title: '中华人民共和国合同法', effectiveStatus: 'repealed',
  articles: [{ articleNumber: '第六十条', content: '当事人应当按照约定全面履行自己的义务。' }],
  sourceUrl: 'https://flk.npc.gov.cn/detail.html?id=test', sourceVerifiedAt: '2026-01-01T00:00:00Z', ...overrides,
})
const entry = (id, courtName, judgeNames = [], title = '合同履行争议') => ({
  id, title, courtName, judgeNames, caseNumber: '(2024)京01民终1号', cause: '合同纠纷',
  issueSummary: '', holdingSummary: '', reasoningSummary: '', keywords: [], focusTags: [],
})

test('废止法律在全部重复引用处标红，精确返回原文位置', () => {
  const text = '根据《合同法》第60条，另参照《合同法》第六十条。'
  const result = inspectLegalText(text, [law()], [])
  assert.equal(result.length, 2)
  assert.ok(result.every(f => f.status === 'repealed' && text.slice(f.from, f.to) === f.text))
})
test('中文条号、并列条号和条之编号不会混淆', () => {
  const text = '《民法典》第五百零九条、第五百一十条及第511条。'
  assert.equal(extractStatuteCitations(text).length, 3)
  const statutes = [law({ title: '民法典', effectiveStatus: 'effective', articles: [
    { articleNumber: '第509条', content: '真实条文' }, { articleNumber: '第五百一十条', content: '真实条文' },
  ] })]
  assert.deepEqual(inspectLegalText(text, statutes, []).map(f => f.status), ['verified', 'verified', 'unverified'])
  assert.equal(inspectLegalText('《民法典》第509条之一', statutes, [])[0].status, 'unverified')
})
test('未找到法律或条文、占位正文及多版本均显示未能核实', () => {
  assert.equal(inspectLegalText('《不存在的法律》第1条', [], [])[0].status, 'unverified')
  assert.equal(inspectLegalText('《合同法》第99条', [law({ effectiveStatus: 'effective' })], [])[0].status, 'unverified')
  assert.equal(inspectLegalText('《合同法》第60条', [law({ effectiveStatus: 'effective', articles: [
    { articleNumber: '第六十条', content: '官方原文已定位，未直接返回结构化正文' },
  ] })], [])[0].status, 'unverified')
  assert.equal(inspectLegalText('《合同法》第60条', [law(), law({ id: 'second' })], [])[0].status, 'unverified')
  assert.equal(inspectLegalText('阅读《证据研究》后', [], []).length, 0)
})
test('修订版本和未注明条号的废止法律也有风险提示', () => {
  assert.equal(inspectLegalText('《合同法》', [law()], [])[0].status, 'repealed')
  assert.equal(inspectLegalText('《合同法》第60条', [law({ effectiveStatus: 'amended' })], [])[0].status, 'amended')
  assert.equal(inspectLegalText('根据合同法第60条', [law()], [])[0].status, 'repealed')
})
test('案号格式有效不等于真实性已经核实', () => {
  assert.equal(normalizeCaseNumber('（2024） 京01民终218号'), '(2024)京01民终218号')
  assert.ok(isValidCaseNumber('（2024）京01民终218号'))
  assert.equal(isValidCaseNumber('(2099)京01民终218号'), false)
  const result = inspectLegalText('参见（2024）京01民终218号裁判。', [], [
    { ...entry('case', '北京法院'), caseNumber: '(2024)京01民终218号', sourceUrl: 'https://wenshu.court.gov.cn/' },
  ])
  assert.equal(result[0].status, 'unverified')
  assert.equal(isOfficialCaseUrl('https://wenshu.court.gov.cn/'), false)
  assert.equal(isOfficialCaseUrl('https://court.gov.cn.evil.example/judgment.html'), false)
  assert.equal(isOfficialCaseUrl('http://court.gov.cn/judgment.html'), false)
  assert.equal(isOfficialCaseUrl('https://www.court.gov.cn/fabu/xiangqing/123.html'), true)
})
test('法官法院权重可调，不把正文出现的人名当成法官', () => {
  const items = [entry('a', '甲法院'), entry('b', '乙法院', ['张某']), entry('c', '乙法院', [], '张某合同履行争议')]
  assert.equal(rankCases(items, { keyword: '合同', courtName: '乙法院', judgeName: '张某', courtWeight: 2, judgeWeight: 3 })[0].id, 'b')
  assert.equal(rankCases(items, { keyword: '合同', courtName: '甲法院', judgeName: '张某', courtWeight: 5, judgeWeight: 0 })[0].id, 'a')
  assert.equal(rankCases(items, { judgeName: '张某' }).find(i => i.id === 'c').searchMatches.judgeMatched, false)
})
test('保留外部语义召回，不因缺少相同关键词丢弃真实语义结果', () => {
  const semantic = entry('remote', '甲法院', [], '买卖合同的责任承担')
  assert.equal(rankCases([semantic], { keyword: '逾期交付货物' }, new Map([['remote', 0]])).length, 1)
  assert.equal(rankCases([semantic], { keyword: '完全不相关' }).length, 0)
})
test('案号权威查证要求官方正文包含对应号码，脚本、首页和其他案号不算已核实', async () => {
  const url = 'https://www.court.gov.cn/fabu/xiangqing/123.html'
  const number = '(2024)京01民终218号'
  assert.equal(await checkOfficialJudgment(url, number, async () => new Response(`<h1>民事判决书</h1><p>（2024）京01民终218号</p>`)), true)
  assert.equal(await checkOfficialJudgment(url, number, async () => new Response(`<h1>民事判决书</h1><p>（2024）京01民终219号</p>`)), false)
  assert.equal(await checkOfficialJudgment(url, number, async () => new Response(`<h1>判决书查询</h1><script>const q='${number}'</script>`)), false)
  assert.equal(await checkOfficialJudgment('https://wenshu.court.gov.cn/', number, () => { throw new Error('must not fetch a homepage') }), false)
  assert.equal(await checkOfficialJudgment(url, number, async () => new Response('不可用', { status: 503 })), false)
  assert.equal(await checkOfficialJudgment(url, number, async () => new Response(`判决书${number}${'x'.repeat(2_000_001)}`)), false)
})
