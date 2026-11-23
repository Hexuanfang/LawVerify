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
  const statute = { tier: 'l2', id: 'qa-review-statute-675', name: '中华人民共和国民法典', locator: '第六百七十五条',
    quote: '借款人应当按照约定的期限返还借款。', url: 'https://example.invalid/law/675' }
  const remoteStatute = { ...statute, id: 'qa-review-statute-969', locator: '第九百六十九条',
    quote: '合伙人的出资、因合伙事务依法取得的收益和其他财产，属于合伙财产。' }
  workspace.knowledgeStatutes.push({
    id: 'qa-review-civil-code', title: statute.name, docType: '法律', issuer: '主席令第六十三号', version: '',
    effectiveStatus: 'effective', effectiveDate: '2021-01-01', publishDate: '', sourceUrl: statute.url, keywords: [],
    articles: [{ id: statute.id, documentId: 'qa-review-civil-code', articleNumber: statute.locator,
      content: statute.quote, plainText: statute.quote, aliases: [], topicTags: [] }],
  })
  for (const [id, verdict, quote, reason] of cases) {
    if (!doc.paragraphIds.includes(id)) {
      doc.paragraphIds.push(id)
      doc.paragraphs.push({ id, text: quote, richText: `<p>${quote}</p>`, verified: false, links: [] })
    }
    doc.verification.declarations.push({
      id: `todo-${id}`, type: 'E-FACT', quote, verdict, reason, checks: {}, conf: null,
      sources: id === 'p2' ? [source, statute, remoteStatute] : [source],
      location: { paragraphId: id, paragraphIndex: doc.paragraphIds.indexOf(id), start: 0, end: quote.length },
      ...(id === 'p2' && {
        verifiedText: source.quote, verifiedSources: [source],
        differences: [{ field: '日期', document: '2023-04-01', source: '2023-04-11' },
          { field: '金额', document: '30,000 元', source: '35,000 元' }],
        checks: {
          A1: { outcome: 'pass', reason: '银行流水可回查。' },
          A2: { outcome: 'fail', reason: '文书日期、金额与流水不一致。' },
          A4: { outcome: 'pending', reason: '证明边界待核实。' },
          A5: { outcome: 'warn', reason: '需复核文书中的后续付款陈述。' },
          B1: { outcome: 'pass', reason: '其他核验维度。' },
        },
      }),
      ...(id === 'p5' && { review: { revision: 'qa', ignored: true } }),
      ...(id === 'p6' && { review: { revision: 'qa', note: '核对借款合同原件。' } }),
    })
  }
  workspace.certificates.push({
    ...doc, id: 'qa-empty-document', title: '空白核验文书', verification: undefined, paragraphIds: [], paragraphs: [],
  }, {
    ...doc, id: 'qa-pending-defense', title: '待核验答辩状', linkageInputKey: undefined, verification: undefined,
    paragraphIds: ['qa-defense-title'],
    paragraphs: [{ id: 'qa-defense-title', text: '民事答辩状', richText: '<p>民事答辩状</p>', verified: false,
      note: '导入自答辩状.docx，可继续补充证据定位与核验批注。', links: [] }],
  })
}

async function check({ evaluate, wait, clickText, screenshot, window, saved }) {
  const buttons = '.review-todo-tabs button'
  const rightTabs = '.workspace-right-tablist [role=tab]'
  const overviewVisible = "document.querySelector('.review-todos:not([hidden])')"
  await wait(overviewVisible)
  await wait("document.querySelector('.workspace-right-tablist [aria-label=\"AI 助手\"] img')?.naturalWidth > 0")
  assert.equal(await evaluate("document.querySelector('.review-todos-count strong').textContent"), '3')
  assert.equal(await evaluate("document.querySelector('.review-todos-progress progress').value"), 3)
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
  await evaluate("document.querySelector('.whole-document-content [data-el=todo-p2]').click()")
  await wait("document.querySelector('.review-highlight-result .review-highlight-status')?.textContent === '不通过'")
  assert.equal(await evaluate(`(() => {
    const pane = document.querySelector('.pane-r').getBoundingClientRect();
    return Math.round(pane.width) === 400
      && Math.round(document.querySelector('.pane-l').getBoundingClientRect().width) === 232;
  })()`), true, '桌面高亮详情应恢复截图的三栏宽度')
  assert.equal(await evaluate("document.querySelector('.workspace-right-tablist [aria-label=\"AI 助手\"]').checkVisibility()"), true)
  const conclusion = await evaluate("document.querySelector('.review-highlight-conclusion').textContent")
  assert.match(conclusion, /金额与银行流水不一致/u)
  assert.doesNotMatch(conclusion, /AI结论/u)
  assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('.review-highlight-result .ops button'), button => button.textContent.trim())"),
    ['修改声明', '采纳修改建议', '关联出处'])
  const details = '.review-highlight-result .review-declaration-details'
  const sections = '.review-highlight-result > :is(.review-highlight-conclusion, .review-highlight-sources, .review-declaration-details)'
  assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('${sections}'), section => section.firstElementChild.textContent.trim())`),
    ['不通过', '出处', '核验详情'])
  assert.equal(await evaluate(`document.querySelector('${details}').open`), true)
  await clickText(`${details} > summary`, '核验详情')
  assert.equal(await evaluate(`document.querySelector('${details}').open`), false)
  assert.equal(await evaluate("document.querySelector('.review-highlight-sources .rc-loc').getBoundingClientRect().height > 0"), true)
  await evaluate("document.querySelector('.review-highlight-sources .rc-loc').click()")
  await wait("document.querySelector('.new-drawer .dwt')?.textContent === '招商银行流水'")
  await clickText('.new-drawer button', 'Close')
  await wait("!document.querySelector('.new-drawer')")
  assert.equal(await evaluate("document.querySelectorAll('.review-highlight-sources a').length"), 0, '核验出处只保留预览入口')
  const openStatute = locator => evaluate(`Array.from(document.querySelectorAll('.review-highlight-sources .rc-loc'))
    .find(button => button.textContent.includes(${JSON.stringify(locator)})).click()`)
  await openStatute('第六百七十五条')
  await wait("document.querySelector('.new-drawer .st-x')")
  assert.match(await evaluate("document.querySelector('.new-drawer .st-x').textContent"), /借款人应当按照约定的期限返还借款/)
  assert.match(await evaluate("document.querySelector('.new-drawer .dwb').textContent"), /现行有效.*2021-01-01/)
  assert.equal(await evaluate("document.querySelector('.new-drawer .ocr, .new-drawer a')"), null)
  await clickText('.new-drawer button', 'Close')
  await wait("!document.querySelector('.new-drawer')")
  await openStatute('第九百六十九条')
  await wait("document.querySelector('.new-drawer .dws')?.textContent.includes('第九百六十九条')")
  window.setSize(390, 900)
  await wait("innerWidth <= 390")
  assert.equal(await evaluate(`(() => {
    const header = document.querySelector('.new-drawer .dwh');
    const subtitle = header.querySelector('.dws').getBoundingClientRect();
    const close = document.querySelector('.new-drawer [data-slot=sheet-close], .new-drawer button').getBoundingClientRect();
    return subtitle.bottom < header.getBoundingClientRect().bottom && subtitle.right <= close.left;
  })()`), true, '法条定位信息在窄窗完整显示，且与关闭按钮分开')
  assert.match(await evaluate("document.querySelector('.new-drawer .dwb').textContent"), /核验引用摘录.*属于合伙财产/)
  assert.equal(await evaluate("document.querySelector('.new-drawer .ocr, .new-drawer a')"), null)
  await screenshot('statute-preview-390')
  await clickText('.new-drawer button', 'Close')
  await wait("!document.querySelector('.new-drawer')")
  window.setSize(1440, 960)
  await wait("innerWidth > 1000")
  await clickText(`${details} > summary`, '核验详情')
  assert.equal(await evaluate(`document.querySelectorAll('${details} tbody tr').length`), 2)
  const tags = `${details} .review-highlight-checks li`
  assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('${tags}'), tag =>
    Array.from(tag.childNodes, node => node.nodeType === Node.TEXT_NODE ? node.textContent : '').join('').trim())`),
    ['溯源性 · 通过', '一致性 · 不通过', '完整性 · 未核实', '边界性 · 未核实', '自洽性 · 预警'])
  const backgrounds = await evaluate(`Array.from(document.querySelectorAll('${tags}'), tag => getComputedStyle(tag).backgroundColor)`)
  assert.notEqual(backgrounds[0], backgrounds[1])
  assert.deepEqual(backgrounds.slice(1), Array(4).fill(backgrounds[1]))
  assert.equal(await evaluate("Boolean(document.querySelector('.case-review-bar'))"), false)
  await clickText('.review-highlight-result .ops button', '修改声明')
  assert.equal(await evaluate("document.activeElement.getAttribute('aria-label')"), '修改声明')
  await clickText('.review-highlight-result .inline-actions button', '取消')
  await clickText('.review-highlight-result .ops button', '采纳修改建议')
  await wait("document.querySelector('[aria-label=确认修改声明]')?.textContent.includes('35,000元')")
  await clickText('[aria-label=确认修改声明] button', '取消')
  await clickText('.review-highlight-result .ops button', '关联出处')
  await wait("document.querySelector('.essential-reference-dialog')")
  await clickText('.essential-reference-dialog .fm-ft button', '取消')
  await wait("!document.querySelector('.essential-reference-dialog')")
  await screenshot('review-highlight-conflict')
  await clickText(rightTabs, 'AI 助手')
  await wait("document.querySelector('.workspace-ai-panel')?.checkVisibility()")
  await clickText('.workspace-ai-header button', '关闭 AI 助手')
  await wait("document.querySelector('.review-highlight-result').checkVisibility()")
  await clickText('.review-detail-bar button', '返回待办')
  await wait(overviewVisible)
  assert.equal(await evaluate("document.querySelector('.workspace-right-tablist').checkVisibility()"), true)
  await clickText(buttons, '待办 4')
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
  const assistantShortcut = '.workspace-doc-strip button[aria-label="AI 助手"]'
  assert.equal(await evaluate(`Boolean(document.querySelector(${JSON.stringify(assistantShortcut)})?.checkVisibility())`), true,
    '窄窗收起右栏时也应显示 AI 助手入口')
  await wait(`document.querySelector(${JSON.stringify(assistantShortcut + ' img')})?.naturalWidth > 0`)
  await screenshot('assistant-shortcut-390')
  await clickText('.workspace-doc-strip button', 'AI 助手')
  await wait("document.querySelector('.workspace-ai-panel') && !document.querySelector('.ws.no-r')")
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(assistantShortcut)})`), null)
  await clickText('.workspace-ai-header button', '关闭 AI 助手')
  await wait("document.querySelector('.ws.no-r')")
  await clickText('.workspace-doc-strip button', '核验结果')
  await wait("getComputedStyle(document.querySelector('.pane-r')).visibility === 'visible'")
  assert.equal(await evaluate("document.querySelector('.review-todos-content').scrollWidth <= document.querySelector('.review-todos-content').clientWidth"), true)
  await screenshot('review-todos-390')
  await evaluate("document.querySelector('.whole-document-content [data-el=todo-p4]').click()")
  await wait("document.querySelector('.review-highlight-result') && getComputedStyle(document.querySelector('.pane-r')).visibility === 'visible'")
  assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('.review-highlight-result .ops button'), button => button.textContent.trim())"),
    ['修改声明', '关联出处'])
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('${tags}')).filter(tag => tag.textContent.includes('未核实')).length`), 5)
  assert.equal(await evaluate("document.querySelector('.rp').scrollWidth <= document.querySelector('.rp').clientWidth"), true)
  await screenshot('review-highlight-warning-390')
  window.setSize(1440, 960)
  await clickText('.workspace-doc-strip [role=tab]', '空白核验文书')
  await wait("document.querySelector('.review-todos-empty button')?.textContent === 'AI 核验当前文书'")
  await screenshot('review-todos-empty')
  await evaluate(`(() => {
    const tab = Array.from(document.querySelectorAll('.workspace-doc-name')).find(item => item.textContent === '待核验答辩状').closest('[role=tab]');
    tab.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
  })()`)
  await wait("document.querySelector('.whole-document-content mark')?.textContent === '民事答辩状'")
  window.webContents.focus()
  const pendingMark = await evaluate(`(() => {
    const rect = document.querySelector('.whole-document-content mark').getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  })()`)
  window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...pendingMark })
  window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...pendingMark })
  await wait("document.querySelector('.review-highlight-status')?.textContent === '待核验'")
  assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('.review-detail-bar button'), button => button.textContent.trim())"), ['返回待办'])
  const pendingDetail = "document.querySelector('.review-detail-bar').outerHTML + document.querySelector('.review-highlight-result').outerHTML"
  const detailFromDocument = await evaluate(pendingDetail)
  await clickText('.review-detail-bar button', '返回待办')
  await evaluate("document.querySelector('.review-todo-card[data-verdict=pending]').click()")
  await wait("document.querySelector('.review-detail-bar')")
  await screenshot('review-pending-todo')
  assert.equal(await evaluate("document.querySelector('.review-highlight-status')?.textContent"), '待核验',
    '从待办打开同一个待核验片段时应显示相同的核验详情')
  assert.equal(await evaluate(pendingDetail), detailFromDocument, '正文和待办应显示同一套标题栏和详情内容')
  assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('.review-highlight-result .ops button'), button => button.textContent.trim())"),
    ['修改声明', '关联出处'])
  await clickText('.review-detail-bar button', '返回待办')
  await evaluate("document.querySelector('.review-todo-card[data-verdict=pending]').closest('.review-todo-entry').querySelector('.review-todo-manual').click()")
  await wait("document.querySelector('.rc .user-tag')?.textContent === '整段待人工审阅'")
  assert.match(await evaluate("document.querySelector('.rc').textContent"), /导入自答辩状\.docx/u)
  await clickText('.review-detail-bar button', '返回核验详情')
  await wait("document.querySelector('.review-highlight-status')?.textContent === '待核验'")
  await clickText('.review-detail-bar button', '返回待办')
  await evaluate(`(() => {
    const tab = Array.from(document.querySelectorAll('.workspace-doc-name')).find(item => item.textContent === '民事起诉状').closest('[role=tab]');
    tab.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
  })()`)
  await wait("document.querySelector('.whole-document-content [data-el=todo-p2]')")
  await evaluate("document.querySelector('.whole-document-content [data-el=todo-p2]').click()")
  await clickText('.review-highlight-result .ops button', '采纳修改建议')
  await clickText('[aria-label=确认修改声明] button', '确认替换')
  await wait("document.querySelector('#pg-proc')")
  await saved(state => {
    const doc = state.certificates.find(item => item.id === 'qa-document')
    assert.equal(doc.paragraphs[1].text, '2023年4月11日收到35,000元利息。')
    assert.ok(doc.verification.audit.some(item => item.declarationId === 'todo-p2' && item.action === 'adopt'))
  })
}

module.exports = { seed, check }
