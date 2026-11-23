const assert = require('node:assert/strict')

module.exports = async function checkEssential({ evaluate, wait, clickText, fill, screenshot, window, readWorkspace, writeWorkspace, runWithWorkspaceAccount, account, setAccountStatus, linkageMaterialFingerprint }) {
  const saved = async fn => runWithWorkspaceAccount(account, async () => fn(await readWorkspace()))
  const reload = async () => { await evaluate('location.reload()'); await wait("document.querySelector('#pg-home .case-name')") }
  const enter = async name => {
    if (!await evaluate("Boolean(document.querySelector('#pg-home'))")) await clickText('.topbar button.brand-home', 'LawVerify 首页')
    await wait("document.querySelector('#pg-home')")
    await evaluate(`Array.from(document.querySelectorAll('.case-card')).find(item => item.textContent.includes(${JSON.stringify(name)})).click()`)
    await wait("document.querySelector('#pg-ws')")
  }
  const closeSheet = () => clickText('[data-slot=sheet-content] button', 'Close')
  const closeDialog = () => evaluate("document.querySelector('[data-slot=dialog-close]').click()")
  const choose = async (label, text) => {
    await evaluate(`document.querySelector('[aria-label=${JSON.stringify(label)}]').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,pointerType:'mouse'}))`)
    await wait("document.querySelector('[role=option]')")
    await clickText('[role=option]', text)
  }
  const uploadFile = async (label, name, content) => evaluate(`(() => {const input=document.querySelector('input[aria-label='+${JSON.stringify(JSON.stringify(label))}+']');const dt=new DataTransfer();dt.items.add(new File([${JSON.stringify(content)}],${JSON.stringify(name)},{type:'text/plain'}));input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}))})()`)
  const selectLoanStatement = async () => {
    const highlight = "Array.from(document.querySelectorAll('.whole-document-content [data-el]')).find(item => item.textContent.startsWith('借款已交付。'))"
    await wait(highlight)
    await evaluate(`${highlight}.click()`)
    await wait("document.querySelector('.rc-q')?.textContent.startsWith('借款已交付。')")
  }
  await saved(async state => {
    state.cases.push({ id: 'essential-case', name: '必要工作流测试', description: '', createdAt: '2026-11-15', status: 'in_review' })
    const evidence = { id: 'essential-ev', caseId: 'essential-case', name: '回归证据', fileName: '回归证据.txt', number: '证据2', type: 'text', ocrText: '借款已交付。尚未还款。', uploadedAt: '2026-11-15' }
    state.evidences.push(evidence)
    state.certificates.push({ id: 'essential-doc', caseId: 'essential-case', title: '审阅测试文书', role: 'plaintiff', focus: '', createdAt: '2026-11-15', linkageInputKey: linkageMaterialFingerprint([evidence], []), paragraphIds: ['essential-heading', 'essential-multi'], paragraphs: [
      { id: 'essential-heading', text: '审阅测试', richText: '<h2>审阅测试</h2>', verified: false },
      { id: 'essential-multi', text: '借款已交付。尚未还款。', richText: '<p>借款已交付。尚未还款。</p>', verified: false, links: [
        { evidenceId: 'essential-ev', locator: '第一句', quote: '借款已交付。', sentenceIndex: 0, sentenceText: '借款已交付。', relation: 'support' },
        { evidenceId: 'essential-ev', locator: '第二句', quote: '尚未还款。', sentenceIndex: 1, sentenceText: '尚未还款。', relation: 'support' },
      ] },
    ] })
    state.knowledgeStatutes.push({ id: 'essential-law', title: '回归法条', docType: '法律', issuer: '测试', effectiveStatus: 'effective', effectiveDate: '', publishDate: '', version: '1', keywords: [], articles: [{ id: 'essential-article', documentId: 'essential-law', articleNumber: '第一条', content: '真实条文测试正文。', plainText: '真实条文测试正文。', aliases: [], topicTags: [] }] })
    state.knowledgeCases.push({ id: 'essential-case-law', title: '回归案例', caseNumber: '测试案号', courtName: '测试法院', courtLevel: '', region: '', trialLevel: '', caseType: '民事', cause: '', judgmentDate: '', effectiveDate: '', issueSummary: '', holdingSummary: '回归要旨', reasoningSummary: '', resultSummary: '', sourceType: 'manual', keywords: [], focusTags: [], referencedStatutes: [], excerpts: [{ id: 'essential-excerpt', caseId: 'essential-case-law', excerptType: 'reasoning', summary: '', locator: '裁判理由', content: '回归案例片段正文。', keywords: [] }] })
    await writeWorkspace(state)
  })
  await reload(); await enter('必要工作流测试')
  assert.equal(await evaluate("Array.from(document.querySelectorAll('.case-review-bar button')).find(item=>item.textContent==='标记案件完成').disabled"), true)
  await evaluate("Array.from(document.querySelectorAll('.review-todo-card')).find(item => item.querySelector('.review-todo-quote').textContent.startsWith('借款已交付。')).click()")
  await clickText('.ops button', '确认整段')
  await wait("document.querySelector('.essential-confirm-list')")
  assert.equal(await evaluate("document.querySelectorAll('.essential-confirm-list li').length"), 2)
  await clickText('.fm-ft button', '取消')
  await saved(state => assert.equal(state.certificates.find(item => item.id === 'essential-doc').paragraphs[1].verified, false))
  await clickText('.ops button', '确认整段'); await clickText('.fm-ft button', '已核对，确认整段')
  await wait("!document.querySelector('.essential-confirm-list')")
  await wait("document.querySelector('.audit')?.textContent.includes('律师确认整段全部声明')")
  await clickText('.case-review-bar button', '审阅清单')
  await wait("document.querySelector('.essential-review-dialog')")
  await evaluate("Array.from(document.querySelectorAll('.essential-review-dialog .essential-reference-item button')).find(item=>item.textContent==='已核对，确认本段').click()")
  await wait("Array.from(document.querySelectorAll('.essential-review-dialog .essential-reference-item button')).every(item=>item.textContent==='取消本段确认')")
  await closeDialog(); await clickText('.case-review-bar button', '标记案件完成')
  await wait("document.querySelector('.case-review-bar').textContent.includes('待归档')")
  await saved(state => assert.equal(state.cases.find(item => item.id === 'essential-case').status, 'ready'))

  await evaluate("document.querySelector('.mat-it').click()")
  await wait("document.querySelector('.evidence-references')?.textContent.includes('审阅测试文书')")
  assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('.evidence-references li strong'), label => label.textContent)"), ['第 2 段'])
  await screenshot('material-preview'); await closeSheet()
  await selectLoanStatement()
  await clickText('.ops button', '关联出处'); await wait("document.querySelector('.essential-reference-dialog')")
  await fill('[aria-label="引用定位 材料 1"]', '第3页')
  await fill('[aria-label="引用原文 材料 1"]', '已校正引文')
  await evaluate("document.querySelectorAll('.essential-reference-item .bye')[1].click()")
  await clickText('.fm-ft button', '保存引用'); await wait("!document.querySelector('.essential-reference-dialog')")
  await saved(state => { const p = state.certificates.find(item => item.id === 'essential-doc').paragraphs[1]; assert.equal(p.links.length, 1); assert.equal(p.links[0].locator, '第3页') })
  await clickText('.ops button', '关联出处'); await wait("document.querySelector('.essential-reference-dialog')")
  await clickText('.essential-reference-item button', '移除引用')
  await clickText('.fm-ft button', '保存引用'); await wait("!document.querySelector('.essential-reference-dialog')")
  await saved(state => { const p = state.certificates.find(item => item.id === 'essential-doc').paragraphs[1]; assert.equal(p.links.length, 0); assert.equal(p.link, undefined) })
  await selectLoanStatement()
  await clickText('.ops button', '关联出处'); await wait("document.querySelector('.essential-reference-dialog')")
  await choose('引用类型', '法条条文'); await choose('选择引用出处', '回归法条 第一条')
  await clickText('.essential-reference-dialog button', '添加到待保存引用')
  await choose('引用类型', '案例片段'); await choose('选择引用出处', '测试案号 · 裁判理由')
  await clickText('.essential-reference-dialog button', '添加到待保存引用')
  await screenshot('reference-manage')
  await clickText('.fm-ft button', '保存引用'); await wait("!document.querySelector('.essential-reference-dialog')")
  await saved(state => { const p = state.certificates.find(item => item.id === 'essential-doc').paragraphs[1]; assert.equal(p.references.length, 2); assert.ok(p.references.some(item => item.targetId === 'essential-excerpt')) })
  await evaluate("Array.from(document.querySelectorAll('.rc-loc')).find(item=>item.textContent.includes('测试案号')).click()")
  await wait("document.querySelector('.casepv')")
  assert.match(await evaluate("document.querySelector('.casepv').textContent"), /回归案例片段正文/)
  await closeSheet()

  await require('./redesign-document-checks.cjs')({ evaluate, wait, clickText, fill, screenshot, window, saved, writeWorkspace, reload, enter })

  await clickText('.topbar button.brand-home', 'LawVerify 首页'); await clickText('.home-intro-actions button', '新建案件')
  await wait("document.querySelector('#field-name')")
  await fill('#field-name', '独立上传测试')
  await evaluate("document.querySelector('input[name=case-task][value=draft]').click()")
  await uploadFile('选择案件原材料文件', '起草材料.txt', '当事人订立合同。')
  await clickText('.new-case-form .fm-ft button', '创建并起草')
  await wait("document.querySelector('#pg-ws .empty-doc')")
  await saved(state => { const c = state.cases.find(item => item.name === '独立上传测试'); assert.ok(state.evidences.some(item => item.caseId === c.id)); assert.ok(!state.certificates.some(item => item.caseId === c.id)) })
  await clickText('.add-mat', '导入材料或文书'); await wait("document.querySelector('.new-upload')")
  await uploadFile('上传材料或文书', '独立文书.txt', '民事起诉状\n独立文书正文。')
  await wait("document.querySelector('.upload-actions button:not(:disabled)')")
  await clickText('.upload-actions button', '仅导入文书'); await wait("document.querySelector('.doc-paper') && !document.querySelector('.new-upload')")
  await saved(state => { const c = state.cases.find(item => item.name === '独立上传测试'); assert.ok(state.certificates.some(item => item.caseId === c.id)) })

  await clickText('.topbar button.brand-home', 'LawVerify 首页'); await clickText('.home-intro-actions button', '新建案件')
  await wait("document.querySelector('#field-name')")
  await fill('#field-name', '核验附件必传测试')
  await wait("document.querySelector('.case-files-document')")
  await uploadFile('选择案件原材料文件', '案情材料.txt', '双方曾签订合同。')
  assert.equal(await evaluate("document.querySelector('.new-case-form button[type=submit]').disabled"), true)
  await clickText('.case-files-material .chip button', '移除 案情材料.txt')
  await uploadFile('上传已撰写文书', '测试待核验文书.txt', '双方签订合同。')
  assert.equal(await evaluate("document.querySelector('.new-case-form button[type=submit]').disabled"), true)
  await uploadFile('选择案件原材料文件', '案情材料.txt', '双方曾签订合同。')
  await evaluate(`(() => {
    const fetch = window.fetch;
    window.fetch = (input, init) => {
      if (String(input).includes('/api/documents/import')) {
        window.__caseDocumentOnProgressPage = Boolean(document.querySelector('#pg-proc') && !document.querySelector('.new-case-form'));
      }
      return fetch(input, init);
    };
  })()`)
  await clickText('.new-case-form .fm-ft button', '创建并核验')
  await wait("document.querySelector('#pg-proc .proc-actions button:not(:disabled)') && [...document.querySelectorAll('.proc-actions button')].some(button => /返回工作台|查看核验结果/.test(button.textContent))")
  assert.equal(await evaluate('window.__caseDocumentOnProgressPage'), true, '核验文书须在核验动画页发起导入')
  if (await evaluate("[...document.querySelectorAll('.proc-actions button')].some(button => button.textContent === '返回工作台')")) {
    await clickText('.new-error button', '关闭')
    await clickText('.proc-actions button', '返回工作台')
  } else await clickText('.proc-actions button', '查看核验结果')
  await wait("document.querySelector('#pg-ws') && !document.querySelector('.new-case-form')")
  await saved(state => { const c = state.cases.find(item => item.name === '核验附件必传测试'); assert.ok(state.certificates.some(item => item.caseId === c.id)); assert.ok(state.evidences.some(item => item.caseId === c.id)) })
  await evaluate("location.search='?ui=legacy'")
  await wait("document.querySelector('#pg-home')")
  assert.equal(await evaluate("Boolean(document.querySelector('.ide-shell, .legacy-entry'))"), false)
  await evaluate("document.querySelector('.dock-ava').click()")
  await wait("document.querySelector('#pg-account')")
  await clickText('#pg-account .topbar button', '退出登录'); await clickText('.fm-ft button', '确认退出')
  await wait("document.querySelector('.lv-card')")
  assert.equal(await evaluate("sessionStorage.getItem('lawverify-auth-session')"), null)
  assert.equal(await evaluate("sessionStorage.getItem('lawverify-login-account')"), null)
  setAccountStatus(0)
  await evaluate(`sessionStorage.setItem('lawverify-auth-session','qa-local-session');sessionStorage.setItem('lawverify-login-account',${JSON.stringify(account)});localStorage.setItem('lawverify-cloud-token','qa-mocked-token');location.reload()`)
  await wait("document.querySelector('#pg-home')")
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(await evaluate("Boolean(sessionStorage.getItem('lawverify-auth-session'))"), true, '断网不应清空会话')
  setAccountStatus(401)
  await evaluate("dispatchEvent(new Event('focus'))")
  await wait("document.querySelector('.lv-error')")
  assert.match(await evaluate("document.querySelector('.lv-error').textContent"), /其他设备|失效/)
  assert.equal(await evaluate("localStorage.getItem('lawverify-cloud-token')"), null)
}
