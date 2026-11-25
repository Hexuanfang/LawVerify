const assert = require('node:assert/strict')
const { sendHighlightClick } = require('./redesign-highlight-checks.cjs')
const paragraphNote = '旧版整段核对记录。'
const declarationNote = '核对借款合同原件。'

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
      ...(id === 'p6' && { review: { revision: 'qa', note: declarationNote } }),
    })
  }
  doc.paragraphs.find(paragraph => paragraph.id === 'p6').note = paragraphNote
  workspace.certificates.push({
    ...doc, id: 'qa-empty-document', title: '空白核验文书', verification: undefined, paragraphIds: [], paragraphs: [],
  }, {
    ...doc, id: 'qa-pending-defense', title: '待核验答辩状', linkageInputKey: undefined, verification: undefined,
    paragraphIds: ['qa-defense-title'],
    paragraphs: [{ id: 'qa-defense-title', text: '民事答辩状', richText: '<p>民事答辩状</p>', verified: false,
      note: '导入自答辩状.docx，可继续补充证据定位与核验批注。', links: [] }],
  })
}

async function check({ evaluate, wait, clickText, fill, screenshot, window, saved }) {
  const clickHighlight = id => sendHighlightClick({ evaluate, wait, window },
    'document.querySelector(' + JSON.stringify('.lawverify-review[data-superdoc-ext-el="' + id + '"]') + ')')
  const buttons = '.review-todo-tabs button'
  const overview = "document.querySelector('.review-todos')?.checkVisibility()"
  const detail = "document.querySelector('.review-sentence')?.checkVisibility()"
  const actions = '.review-result-actions button'
  const modal = '.review-wide-editor'
  const noteInput = modal + ' textarea'
  const returnToList = () => clickText('.review-detail-bar button', '返回待办')
  const more = async label => {
    await clickText(actions, '更多操作')
    await wait("document.querySelector('[role=menuitem]')")
    await clickText('[role=menuitem]', label)
  }
  const openRow = async id => {
    await evaluate('document.querySelector(' + JSON.stringify('.review-todo-card[data-element-id="' + id + '"]') + ').click()')
    await wait(detail)
  }
  const switchTo = title => evaluate(`Array.from(document.querySelectorAll('.workspace-doc-name'))
    .find(item => item.textContent === ${JSON.stringify(title)}).closest('[role=tab]')
    .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))`)

  await wait(overview)
  await wait("document.querySelector('.workspace-right-tablist img')?.naturalWidth > 0")
  assert.equal(await evaluate("document.querySelector('.workspace-doc-strip [aria-label=\"AI 助手\"]')"), null)
  assert.equal(await evaluate(`(() => {
    const report = document.querySelector('.workspace-review-footer .workspace-review-report')
    const assistant = document.querySelector('.workspace-review-footer [aria-label="AI 助手"]')
    return Boolean(report?.checkVisibility() && assistant?.checkVisibility()
      && report.getBoundingClientRect().right <= assistant.getBoundingClientRect().left)
  })()`), true, '核验报告入口应在 AI 助手左侧')
  assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('.review-todo-tabs button'), item => item.textContent)"),
    ['待办 3', '预警 2', '标注 1', '已通过 1'])
  assert.equal(await evaluate("document.querySelector('.review-todos-count strong').textContent"), '3')
  assert.equal(await evaluate("document.querySelector('.review-todos-progress progress').value"), 4)
  assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('.review-todo-card'), item => item.dataset.verdict)"),
    ['fail', 'miss', 'pending', 'warn'])
  assert.match(await evaluate("document.querySelector('.review-todo-fix').textContent"), /35,000元/)
  assert.match(await evaluate("document.querySelector('.review-todo-card .review-todo-reason').textContent"), /金额与银行流水不一致/)
  assert.equal(await evaluate("Array.from(document.querySelectorAll('#workspace-review button')).some(button => button.textContent.trim() === '＋ AI 起草')"), false)
  await wait("document.querySelector('.whole-document-content .lawverify-review')")
  await screenshot('review-todos')

  await clickText(buttons, '预警 2')
  assert.equal(await evaluate("document.querySelectorAll('.review-todo-card').length"), 2)
  await openRow('todo-p4')
  await more('忽略预警')
  await wait("document.querySelector('.review-sentence')?.textContent.includes('已忽略，仍列入报告')")
  await returnToList()
  assert.equal(await evaluate("document.querySelector('.review-todo-tabs [aria-selected=true]').textContent"), '预警 2')
  await wait("document.activeElement.dataset.elementId === 'todo-p4'")

  await clickText(buttons, '标注 1')
  await openRow('todo-p6')
  assert.equal(await evaluate("document.querySelector('.review-result-advice').textContent"), '律师批注 · ' + paragraphNote + '\n' + declarationNote)
  await more('批注')
  await wait("document.querySelector('.review-wide-editor textarea') === document.activeElement")
  assert.equal(await evaluate("document.querySelector('.review-wide-editor textarea').value"), declarationNote)
  await fill(noteInput, '这条草稿随后取消')
  await clickText(modal + ' button', '取消')
  await more('批注')
  assert.equal(await evaluate("document.querySelector('.review-wide-editor textarea').value"), declarationNote)
  const updatedNote = declarationNote + '\n已补充证据页码。'
  await fill(noteInput, updatedNote)
  await clickText(modal + ' button', '保存批注')
  await wait("!document.querySelector('.review-wide-editor')")
  await saved(state => {
    const doc = state.certificates.find(item => item.id === 'qa-document')
    assert.equal(doc.paragraphs.find(paragraph => paragraph.id === 'p6').note, paragraphNote)
    assert.equal(doc.verification.declarations.find(item => item.id === 'todo-p6').review.note, updatedNote)
  })
  await returnToList()

  await clickText(buttons, '已通过 1')
  await openRow('todo-p7')
  assert.equal(await evaluate("document.querySelector('.review-todos')"), null)
  await wait("document.querySelector('.lawverify-review[data-superdoc-ext-el=todo-p7].sel')")
  await returnToList()
  assert.equal(await evaluate("document.querySelector('.review-todo-tabs [aria-selected=true]').textContent"), '已通过 1')

  await clickHighlight('todo-p2')
  await wait(detail)
  assert.equal(await evaluate("document.querySelector('.review-todos')"), null)
  assert.equal(await evaluate("document.querySelector('.review-result-status').textContent"), '不通过·矛盾')
  assert.equal(await evaluate("document.querySelectorAll('.review-result-diff tbody tr').length"), 2)
  assert.equal(await evaluate("document.querySelector('.review-result-details').open"), false)
  assert.equal(await evaluate("document.querySelector('.review-sentence input[type=checkbox]')"), null)
  assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('.review-result-actions button'), button => button.textContent.trim())"),
    ['采纳修改建议', '问 AI', '更多操作'])
  await wait("!document.querySelector('.toast.show')")
  await screenshot('review-detail')
  await evaluate("document.querySelector('.review-result-source').click()")
  await wait("document.querySelector('.new-drawer .dwt')?.textContent === '招商银行流水'")
  await clickText('.new-drawer button', 'Close')
  await wait("!document.querySelector('.new-drawer')")
  await clickText('.review-result-details summary', '核验详情')
  assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('.review-result-checks li'), tag => tag.textContent)"),
    ['溯源性 · 通过', '一致性 · 不通过', '边界性 · 未核实', '自洽性 · 预警', '真实性 · 通过'])
  await screenshot('review-detail-expanded')
  const openStatute = locator => evaluate("Array.from(document.querySelectorAll('.review-result-details .review-result-source'))"
    + '.find(button => button.textContent.includes(' + JSON.stringify(locator) + ')).click()')
  await openStatute('第六百七十五条')
  await wait("document.querySelector('.new-drawer .st-x')")
  assert.match(await evaluate("document.querySelector('.new-drawer .st-x').textContent"), /借款人应当按照约定的期限返还借款/)
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
  })()`), true)
  await screenshot('statute-preview-390')
  await clickText('.new-drawer button', 'Close')
  await wait("!document.querySelector('.new-drawer')")
  window.setSize(1440, 960)
  await wait("innerWidth > 1000")
  await more('修改声明')
  await wait("document.querySelector('.review-wide-editor textarea') === document.activeElement")
  await clickText(modal + ' button', '取消')
  await more('关联出处')
  await wait("document.querySelector('.review-inline-operation select')")
  await clickText('.review-inline-operation button', '取消')
  await clickText(actions, '采纳修改建议')
  await wait("document.querySelector('.review-wide-editor textarea')?.value.includes('35,000元')")
  await clickText(modal + ' button', '取消')
  await clickText(actions, '问 AI')
  await wait("document.querySelector('.workspace-ai-panel')?.checkVisibility()")
  await clickText('.workspace-ai-header button', '关闭 AI 助手')
  await wait(detail)
  await returnToList()

  await clickText(buttons, '待办 3')
  await clickHighlight('qa-fact')
  await wait(detail)
  await clickText(actions, '人工核验')
  const submit = "document.querySelector('.review-inline-operation button[type=submit]')"
  assert.equal(await evaluate(submit + '.disabled'), true)
  await evaluate("document.querySelectorAll('.review-inline-operation input[type=checkbox]').forEach(item => item.click())")
  assert.equal(await evaluate(submit + '.disabled'), true)
  await fill('.review-inline-operation textarea', '已对照原始流水核对借款金额。')
  await clickText(actions, '通过并保留人工标注')
  await wait("document.querySelector('.review-result-status')?.textContent === '通过·标注'")
  await saved(state => {
    const doc = state.certificates.find(item => item.id === 'qa-document')
    assert.ok(doc.verification.audit.some(item => item.declarationId === 'qa-fact' && item.action === 'confirm'
      && item.note === '已对照原始流水核对借款金额。'))
  })
  await returnToList()
  await clickText('.workspace-review-footer .workspace-review-report', '查看核验报告')
  await wait("document.querySelector('#pg-report')")
  assert.equal(await evaluate("document.querySelector('.report-actions button').disabled"), true)
  await clickText('#pg-report .topbar button', '← 返回工作台')
  await wait(overview)

  window.setSize(390, 900)
  await wait("document.querySelector('.ws.no-r')")
  await clickText('.workspace-doc-strip button', '核验结果')
  await wait(overview)
  assert.equal(await evaluate("document.querySelector('.review-todos-content').scrollWidth <= document.querySelector('.review-todos-content').clientWidth"), true)
  await screenshot('review-todos-390')
  await clickText(buttons, '预警 2')
  await openRow('todo-p4')
  assert.equal(await evaluate("document.querySelector('.review-sentence-body').scrollWidth <= document.querySelector('.review-sentence-body').clientWidth"), true)
  await wait("!document.querySelector('.toast.show')")
  await screenshot('review-detail-390')

  window.setSize(1440, 960)
  await switchTo('空白核验文书')
  await wait("document.querySelector('.review-todos-empty button')?.textContent === 'AI 核验当前文书'")
  await screenshot('review-todos-empty')
  await switchTo('待核验答辩状')
  await wait("Array.from(document.querySelectorAll('.lawverify-review'), mark => mark.textContent).join('') === '民事答辩状'")
  await sendHighlightClick({ evaluate, wait, window }, "document.querySelector('.lawverify-review')")
  await wait(detail)
  assert.equal(await evaluate("document.querySelector('.review-result-status').textContent"), '待核验')
  await more('关联出处')
  await evaluate(`(() => {
    const select = document.querySelector('.review-inline-operation select')
    select.value = 'qa-evidence'
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
  await fill('[aria-label="出处定位"]', '第1段')
  await fill('[aria-label="出处原文"]', '2023年3月15日转账500,000元。')
  await clickText('.review-inline-operation button', '保存挂靠')
  await wait("!document.querySelector('.review-inline-operation')")
  await saved(state => {
    const doc = state.certificates.find(item => item.id === 'qa-pending-defense')
    assert.equal(doc.paragraphs[0].links[0].evidenceId, 'qa-evidence')
    assert.equal(doc.paragraphs[0].links[0].locator, '第1段')
  })
  await returnToList()
  await wait("document.querySelector('.review-todos-empty button')?.textContent === 'AI 核验当前文书'")
  await switchTo('民事起诉状')
  await clickHighlight('todo-p2')
  await wait(detail)
  await clickText(actions, '采纳修改建议')
  await clickText(modal + ' button', '保存并局部重核')
  await wait("document.querySelector('#pg-proc')")
  await saved(state => {
    const doc = state.certificates.find(item => item.id === 'qa-document')
    assert.equal(doc.paragraphs[1].text, '2023年4月11日收到35,000元利息。')
    assert.ok(doc.verification.audit.some(item => item.declarationId === 'todo-p2' && item.action === 'adopt'))
  })
}

module.exports = { seed, check }
