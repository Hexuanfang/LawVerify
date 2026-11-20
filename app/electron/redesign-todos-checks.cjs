const assert = require('node:assert/strict')

function seed(workspace) {
  const doc = workspace.certificates[0]
  const cases = [
    ['p2', 'fail', doc.paragraphs[1].text, '原声明的金额与银行流水不一致。'],
    ['p4', 'warn', '利息金额仍需复算。', '缺少计息过程。'],
    ['p5', 'warn', '已忽略的材料格式预警。', '附件格式待核对。'],
    ['p6', 'note', '已核对借款日期。', '与合同一致。'],
    ['p7', 'pass', '已核对借款本金。', '与银行流水一致。'],
  ]
  const source = { tier: 'l1', id: 'qa-evidence', name: '招商银行流水', locator: '第2段', quote: '2023年4月11日收到35,000元利息。' }
  for (const [id, verdict, quote, reason] of cases) {
    if (!doc.paragraphIds.includes(id)) {
      doc.paragraphIds.push(id)
      doc.paragraphs.push({ id, text: quote, richText: `<p>${quote}</p>`, verified: false, links: [] })
    }
    doc.verification.declarations.push({
      id: `todo-${id}`, type: 'E-FACT', quote, verdict, reason, checks: {}, conf: null, sources: [source],
      location: { paragraphId: id, paragraphIndex: doc.paragraphIds.indexOf(id), start: 0, end: quote.length },
      ...(id === 'p2' && { verifiedText: source.quote, verifiedSources: [source] }),
      ...(id === 'p5' && { review: { revision: 'qa', ignored: true } }),
      ...(id === 'p6' && { review: { revision: 'qa', note: '核对借款合同原件。' } }),
    })
  }
  workspace.certificates.push({
    ...doc, id: 'qa-empty-document', title: '空白核验文书', verification: undefined, paragraphIds: [], paragraphs: [],
  })
}

async function check({ evaluate, wait, clickText, screenshot, window }) {
  const buttons = '.review-todo-tabs button'
  const overviewVisible = "document.querySelector('.review-todos:not([hidden])')"
  await wait(overviewVisible)
  assert.equal(await evaluate("document.querySelector('.review-todos-count strong').textContent"), '3')
  assert.equal(await evaluate("document.querySelector('.review-todos-progress progress').value"), 4)
  assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('.review-todo-card'), item => item.dataset.verdict)"),
    ['fail', 'miss', 'pending', 'warn'])
  assert.match(await evaluate("document.querySelector('.review-todo-fix').textContent"), /35,000元/)
  assert.match(await evaluate("document.querySelector('.review-todo-card .review-todo-reason').textContent"), /金额与银行流水不一致/)
  await screenshot('review-todos')
  await clickText(buttons, '预警 2')
  assert.equal(await evaluate("document.querySelectorAll('.review-todo-card').length"), 2)
  await clickText(buttons, '标注 1')
  assert.match(await evaluate("document.querySelector('.review-todo-card').textContent"), /核对借款合同原件/)
  await clickText(buttons, '已通过 1')
  assert.equal(await evaluate("document.querySelector('.review-todo-card').dataset.verdict"), 'pass')
  await evaluate("document.querySelector('.review-todo-card').click()")
  await wait("document.querySelector('.review-detail-bar h2')?.textContent === '本句核验' && document.querySelector('[data-el=todo-p7].sel')")
  await screenshot('review-detail')
  await clickText('.review-detail-bar button', '返回待办')
  await wait(overviewVisible)
  assert.equal(await evaluate(`document.querySelector('${buttons}[aria-selected=true]').textContent`), '已通过 1')
  await clickText(buttons, '待办 3')
  await evaluate("document.querySelector('.review-todo-warnings summary').click()")
  await clickText('.review-todo-warnings button', '查看全部预警')
  assert.equal(await evaluate(`document.querySelector('${buttons}[aria-selected=true]').textContent`), '预警 2')
  await clickText('.review-todo-actions button', '＋ AI 起草')
  await wait("document.querySelector('.workspace-ai-card[data-mode=document][aria-pressed=true]')")
  await clickText('.workspace-ai-header button', '关闭 AI 助手')
  await clickText('.review-todo-actions button', '查看核验报告')
  await wait("document.querySelector('#pg-report')")
  assert.equal(await evaluate("document.querySelector('.report-actions button').disabled"), true)
  await clickText('#pg-report .topbar button', '← 返回工作台')
  await wait(overviewVisible)
  window.setSize(390, 900)
  await wait("document.querySelector('.ws.no-r')")
  await clickText('.workspace-doc-strip button', '核验结果')
  await wait("getComputedStyle(document.querySelector('.pane-r')).visibility === 'visible'")
  assert.equal(await evaluate("document.querySelector('.review-todos-content').scrollWidth <= document.querySelector('.review-todos-content').clientWidth"), true)
  await screenshot('review-todos-390')
  window.setSize(1440, 960)
  await clickText('.workspace-doc-strip [role=tab]', '空白核验文书')
  await wait("document.querySelector('.review-todos-empty button')?.textContent === 'AI 核验当前文书'")
  await screenshot('review-todos-empty')
}

module.exports = { seed, check }
