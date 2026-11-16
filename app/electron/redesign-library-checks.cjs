const assert = require('node:assert/strict')

module.exports = async function checkLibrary({ evaluate, wait, clickText, fill, readWorkspace, writeWorkspace, runWithWorkspaceAccount, account }) {
  const saved = fn => runWithWorkspaceAccount(account, async () => fn(await readWorkspace()))
  const original = await saved(state => ({ statutes: state.knowledgeStatutes, cases: state.knowledgeCases }))
  const projectNames = await saved(state => state.cases.map(item => item.name))
  await saved(async state => {
    state.knowledgeStatutes = ['A', 'B'].map(letter => ({
      id: `qa-law-${letter}`, title: `惰性加载法条 ${letter}`, docType: '法律', issuer: '测试机构', effectiveStatus: 'effective', effectiveDate: '2026-11-16', publishDate: '', version: '1', keywords: [],
      articles: Array.from({ length: 1500 }, (_, index) => ({ id: `article-${index % 8}`, documentId: `qa-law-${letter}`, articleNumber: `第${index + 1}条`, content: `法律条文 ${letter} ${index + 1} 正文。`, plainText: `法律条文 ${letter} ${index + 1} 正文。`, aliases: [], topicTags: [] })),
    }))
    state.knowledgeCases = Array.from({ length: 5 }, (_, index) => ({
      id: `article-${7 - index}`, title: `隔离案例 ${index}`, caseNumber: `案例案号 ${index}`, courtName: '测试法院', courtLevel: '', region: '', trialLevel: '', caseType: '民事', cause: '', judgmentDate: '', effectiveDate: '', issueSummary: '', holdingSummary: `案例要旨 ${index}`, reasoningSummary: '', resultSummary: '', sourceType: 'manual', keywords: [], focusTags: [], referencedStatutes: [], excerpts: [],
    }))
    await writeWorkspace(state)
  })
  await evaluate('location.reload()'); await wait("document.querySelector('#pg-home')")
  await evaluate("document.querySelector('.dock-ava').click()")
  await wait("document.querySelector('.acct-grid')")
  await clickText('[role=tab]', '法条库'); await wait("document.querySelector('.lrow-t')")
  const firstRows = await evaluate("document.querySelectorAll('.rowlist .lrow').length")
  await clickText('[role=tab]', '案例库'); await wait("document.querySelector('.lib-head h2')?.textContent==='案例库'")
  const caseRows = await evaluate("Array.from(document.querySelectorAll('.rowlist .lrow-t button')).map(item=>item.textContent)")
  await clickText('[role=tab]', '案件库'); await wait("document.querySelector('.lib-head h2')?.textContent==='案件库'")
  const projectRows = await evaluate("Array.from(document.querySelectorAll('.rowlist .lrow-t button')).map(item=>item.textContent)")
  console.log('Library transition metrics: '+JSON.stringify({ firstRows, caseRows:caseRows.length, projectRows:projectRows.length, expectedProjects:projectNames.length }))
  assert.deepEqual(projectRows.sort(), projectNames.sort(), '正向切换到案件库不能遗留法条或案例行')
  assert.equal(caseRows.length, 5)
  assert.ok(caseRows.every(title => title.startsWith('案例案号')))
  assert.equal(firstRows, 40, '法条库首批只渲染40条，不能一次渲染3000条')
  await clickText('[role=tab]', '案例库'); await wait("document.querySelector('.lib-head h2')?.textContent==='案例库'")
  assert.equal(await evaluate("document.querySelectorAll('.rowlist .lrow').length"), 5)
  await clickText('[role=tab]', '法条库'); await wait("document.querySelectorAll('.rowlist .lrow').length===40")
  await fill('.lib-search input', '惰性加载法条 B 第1500条')
  await wait("document.querySelectorAll('.rowlist .lrow').length===1 && document.querySelector('.lrow-t button')?.textContent==='惰性加载法条 B 第1500条'")
  await fill('.lib-search input', '')
  await wait("document.querySelectorAll('.rowlist .lrow').length===40")
  await evaluate("document.querySelector('.lib').scrollTop=document.querySelector('.lib').scrollHeight")
  try { await wait("document.querySelectorAll('.rowlist .lrow').length===80") }
  catch(error) {
    console.log(await evaluate("JSON.stringify({rows:document.querySelectorAll('.rowlist .lrow').length,scroll:document.querySelector('.lib').scrollTop,height:document.querySelector('.lib').clientHeight,full:document.querySelector('.lib').scrollHeight,sentinel:document.querySelector('.library-load-more')?.getBoundingClientRect().toJSON()})"))
    throw error
  }
  await clickText('.lib-tools button', '⟳ 同步资料库')
  await wait("document.querySelector('.toast')?.textContent.includes('已刷新当前工作区资料库')")
  assert.equal(await evaluate("document.querySelectorAll('.rowlist .lrow').length"), 80, '相同法条数据刷新不能丢失已加载的列表进度')
  await clickText('[role=tab]', '案件库'); await wait("document.querySelector('.lib-head h2')?.textContent==='案件库'")
  assert.deepEqual((await evaluate("Array.from(document.querySelectorAll('.rowlist .lrow-t button')).map(item=>item.textContent)")).sort(), projectNames.sort())
  await saved(async state => { state.knowledgeStatutes=original.statutes;state.knowledgeCases=original.cases;await writeWorkspace(state) })
  await evaluate('location.reload()'); await wait("document.querySelector('#pg-home')")
}
