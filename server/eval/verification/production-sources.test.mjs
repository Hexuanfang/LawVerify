import assert from 'node:assert/strict'
import test from 'node:test'
import { Document, Packer, Paragraph } from 'docx'
import * as official from '../../src/integrations/official-statute.ts'
import * as yuandian from '../../src/integrations/yuandian-case.ts'

test('从人大历史版本下载匹配的原件，核对事实时点、条文及回查 URL', async () => {
  const title = '中华人民共和国验证法'
  const versions = [{ bbbs: 'new-edition', title, sxrq: '2024-01-01', sxx: 3 }, { bbbs: 'old-edition', title, sxrq: '2022-01-01', sxx: 2 }]
  const records = new Map(versions.map(row => [row.bbbs, { ...row, flxz: '法律', zdjgName: '全国人民代表大会' }]))
  const downloaded = []
  const fetcher = async (input) => {
    const url = new URL(input)
    if (url.pathname.endsWith('/list')) return Response.json({ code: 200, rows: versions })
    if (url.pathname.endsWith('/flfgDetails')) return Response.json({ code: 200, data: records.get(url.searchParams.get('bbbs')) })
    if (url.pathname.endsWith('/pc')) return Response.json({ code: 200, data: { url: `https://flkoss.obs-bj2.cucloud.cn/${url.searchParams.get('bbbs')}` } })
    const edition = url.pathname.slice(1)
    downloaded.push(edition)
    const body = [title, '第一条　适用范围。', '第二条　' + (edition === 'old-edition' ? '旧版条文。' : '现行条文。'), '第三条　自施行之日起执行。']
    return new Response(await Packer.toBuffer(new Document({ sections: [{ children: body.map(text => new Paragraph(text)) }] })))
  }
  const locator = { law_name: '验证法', article_number: '第2条' }
  const adapter = official.createNpcStatuteAdapter(fetcher)
  const historical = await adapter.detail({ ...locator, refer_date: '2023-06-01' })
  const current = await adapter.detail({ ...locator, refer_date: '2025-06-01' })
  assert.equal(historical.item.text, '旧版条文。')
  assert.equal(historical.item.repeal_date, '2024-01-01')
  assert.equal(historical.item.url, 'https://flk.npc.gov.cn/detail2.html?bbbs=old-edition')
  assert.equal(current.item.text, '现行条文。')
  assert.deepEqual(downloaded, ['old-edition', 'new-edition'])
  assert.equal((await adapter.detail({ ...locator, article_number: '第四条', refer_date: '2023-06-01' })).outcome, 'authoritative-not-found')
})

test('元典先查真实索引 ID，再从完整裁判核对身份和判项，摘要无法升格为详情', async () => {
  const number = '（2023）京01民终17号'
  const court = '北京市第一中级人民法院'
  const row = { case_id: 'native-id', case_number: number, title: '受控上诉案', case_kind: '普通案例',
    decision_date: '2023年05月17日', cause_of_action: ['买卖合同纠纷'], url: 'https://ydzk.chineselaw.com/fixture/native-id' }
  const body = `${court}\n民事判决书\n${number}\n本院认为，本案无新增事实。依照有关规定，判决如下：驳回上诉，维持原判。　本判决为终审判决。`
  const calls = []
  const adapter = yuandian.createYuandianCaseAdapter(async (name, args) => {
    calls.push([name, args])
    return { structuredContent: { success: true, ...(name.endsWith('_detail')
      ? { data: [{ ...row, content: body }] } : { result: { lst: [row], total: 1 } }) } }
  })
  const search = await adapter.search({ action: 'keyword', case_number: number })
  assert.deepEqual(search.items.map(item => item.id), [row.case_id])
  const detail = await adapter.detail({ case_number: number, id: row.case_id })
  assert.deepEqual(calls, [['yuandian_search_judicial_cases', { case_number: number, top_k: 6 }],
    ['yuandian_get_case_detail', { case_id: row.case_id }]])
  assert.equal(detail.item.court, court)
  assert.equal(detail.item.effect, 'effective')
  assert.equal(detail.item.level, 'ordinary')
  assert.equal(detail.item.judgment_date, '2023-05-17')
  assert.equal(detail.item.cause, '买卖合同纠纷')
  assert.ok(detail.item.passages.some(passage => passage.kind === 'reasoning' && passage.text.includes('本案无新增事实')))
  assert.match(detail.item.operativeText, /驳回上诉，维持原判/u)
  const summary = yuandian.createYuandianCaseAdapter(async () => ({ structuredContent: { success: true, data: [{ ...row, content: '本案摘要' }] } }))
  assert.equal((await summary.detail({ case_number: number, id: row.case_id })).outcome, 'unverified-detail')
  const unavailable = yuandian.createYuandianCaseAdapter(async () => ({ isError: true, structuredContent: { success: false, message: '余额不足' } }))
  assert.equal((await unavailable.detail({ case_number: number, id: row.case_id })).outcome, 'unavailable')
})

test('元典语义响应从 document 读取索引，多个匹配详情保持冲突待核', async () => {
  const number = '（2023）京01民终17号'
  const alternate = '（2023）京01民终18号'
  const row = { scid: 'semantic-id', case_number: number, url: 'https://ydzk.chineselaw.com/fixture/semantic-id' }
  const adapter = yuandian.createYuandianCaseAdapter(async name => ({ structuredContent: { success: true,
    ...(name.startsWith('yuandian_semantic') ? { results: { document: [row] } }
      : { data: [row, { ...row, scid: 'another-case' }, { ...row, scid: 'alternate-id', case_number: alternate }] }) } }))
  const search = await adapter.search({ action: 'semantic', query: '买卖合同纠纷' })
  assert.deepEqual(search.items, [{ id: 'semantic-id', case_number: number, url: row.url }])
  assert.equal((await adapter.detail({ case_number: number })).outcome, 'conflicting-detail')
  assert.equal((await adapter.detail({ case_number: number, id: 'absent' })).outcome, 'identity-mismatch')
})
