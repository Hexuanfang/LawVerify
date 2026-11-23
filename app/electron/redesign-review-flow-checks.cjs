const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

module.exports = async function checkReviewFlow({ evaluate, wait, clickText, screenshot, verification, selectReviewedFixture, saved, reload, enter }) {
  await evaluate(`new Promise((resolve, reject) => {
    const request = indexedDB.open('lawverify-review-history')
    request.onupgradeneeded = () => request.result.createObjectStore('audits', { keyPath: 'id' })
    request.onsuccess = () => {
      const transaction = request.result.transaction('audits', 'readwrite')
      transaction.objectStore('audits').add({ id: 'other-account', account: 'other@test.invalid', certificateId: 'qa-document', paragraphId: 'p1', elementId: 'qa-document:p1:paragraph', t: new Date().toISOString(), msg: '其他账号记录' })
      transaction.objectStore('audits').add({ id: 'current-account', account: 'redesign-qa@test.invalid', certificateId: 'qa-document', paragraphId: 'p1', elementId: 'qa-fact', t: new Date().toISOString(), msg: '当前账号记录' })
      transaction.oncomplete = () => { request.result.close(); resolve() }
      transaction.onerror = () => reject(transaction.error)
    }
    request.onerror = () => reject(request.error)
  })`)
  await reload()
  await enter('王某诉李某民间借贷纠纷')
  await clickText('.review-todo-tabs button', '标注 1')
  await selectReviewedFixture()
  await wait("document.querySelector('.audit')?.textContent.includes('当前账号记录')")
  assert.doesNotMatch(await evaluate("document.querySelector('.audit').textContent"), /其他账号记录/)
  await clickText('.add-mat', '导入材料或文书')
  await wait("document.querySelector('.new-upload')")
  await evaluate(`(() => {
    const input = document.querySelector('input[aria-label="上传材料或文书"]')
    const files = new DataTransfer()
    for (const name of ['批量甲', '批量乙', '批量丙']) files.items.add(new File(['民事起诉状\\n借款已交付。'], name + '.txt', { type: 'text/plain' }))
    input.files = files.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
  verification.progressTexts = [
    '原材料与证据解析 · 共 2 份 · 已就绪 0 份 · 解析中 0 份 · 待解析 0 份 · 跳过 2 份',
    '正在读取文书与案件材料', '正在梳理案件背景、争议焦点与证据薄弱点',
    '正在核对第 1 组内容的证据原文与句级关联', '正在核验争议对应的法律依据',
    '正在核验相关案例与裁判规则', '正在保存联动结果',
  ]
  verification.skippedMaterials = [
    { evidenceId: 'parse-failed', fileName: '流水原件.pdf', status: 'failed', reason: '解析服务不可用' },
    { evidenceId: 'parse-review', fileName: '聊天截图.png', status: 'review_required', reason: '仅识别到图形' },
  ]
  await evaluate(`(() => {
    window.__verificationStages = []
    window.__verificationObserver = new MutationObserver(() => {
      const stage = document.querySelector('#pg-proc .pst.on .pst-i')?.textContent
      if (stage && !window.__verificationStages.includes(stage)) window.__verificationStages.push(stage)
    })
    window.__verificationObserver.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true })
  })()`)
  verification.importProbe = true
  verification.importDelay = 500
  verification.enabled = true
  verification.failNext = 2
  await wait("document.querySelector('.upload-actions .btn-pri:not(:disabled)')")
  await clickText('.upload-actions button', '导入并核验')
  await wait("document.querySelector('#pg-proc .ppct')?.textContent.includes('正在解析文书')")
  assert.equal(await evaluate("Boolean(document.querySelector('.new-upload'))"), false, '上传解析应在共用流程页显示')
  assert.equal(await evaluate("document.querySelector('#pg-proc .pst.on .pst-i')?.textContent"), '1')
  assert.equal(verification.calls.length, 0, '解析完成前不能启动核验')
  await screenshot('upload-verification-parsing')
  await wait("document.querySelector('#pg-proc .proc-actions')?.textContent.includes('重试')")
  assert.equal(await evaluate("document.querySelectorAll('#pg-proc .pst.on').length"), 0, '失败后不能继续显示处理中')
  assert.match(await evaluate("document.querySelector('#pg-proc .proc-t').textContent"), /《批量乙》/)
  assert.deepEqual(await evaluate('window.__verificationStages'), ['1', '2', '3', '4', '5', '6', '7'], '七个实际处理阶段都应显示')
  const ids = await saved(state => ['批量甲', '批量乙', '批量丙'].map(title => state.certificates.find(item => item.title === title).id))
  assert.deepEqual(verification.calls, ids.slice(0, 2), '失败后应停止，尚未执行后续文书')
  await clickText('.proc-actions button', '重试')
  await wait("document.querySelector('#pg-proc .ppct')?.textContent.includes('核验完成')")
  assert.equal(await evaluate("document.querySelectorAll('#pg-proc .pst.done').length"), 7, '完成时七个步骤都必须显示完成')
  assert.match(await evaluate("document.querySelector('#pg-proc .proc-skipped').previousElementSibling.textContent"), /生成文档与保存结果/)
  assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('#pg-proc .proc-skipped li'), item => item.textContent)"), [
    '流水原件.pdf解析失败 · 解析服务不可用', '聊天截图.png待人工审核 · 仅识别到图形',
  ])
  verification.skippedMaterials = undefined
  assert.equal(await evaluate("document.querySelectorAll('#pg-proc .pst.on').length"), 0)
  await evaluate("new Promise(resolve=>setTimeout(resolve,200))")
  assert.equal(await evaluate("Boolean(document.querySelector('#pg-proc'))"), true, '完成后不能自动退出进度页')
  await screenshot('verification-complete')
  await clickText('.proc-actions button', '查看核验结果')
  await wait("document.querySelector('#pg-ws .ctool h1')?.textContent === '批量丙'")
  assert.match(await evaluate("document.querySelector('#pg-ws .topbar').textContent"), /王某诉李某民间借贷纠纷/)
  assert.deepEqual(verification.calls, [ids[0], ids[1], ids[1], ids[2]], '重试仅执行失败及剩余文书，不能漏核或重复已完成文书')
  await clickText('.add-mat', '导入材料或文书')
  await wait("document.querySelector('.new-upload')")
  await evaluate(`(() => {
    const input = document.querySelector('input[aria-label="上传材料或文书"]')
    const files = new DataTransfer()
    for (const name of ['取消甲', '取消乙', '取消丙']) files.items.add(new File(['民事起诉状\\n借款已交付。'], name + '.txt', { type: 'text/plain' }))
    input.files = files.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
  verification.holdAt = 6
  await wait("document.querySelector('.upload-actions .btn-pri:not(:disabled)')")
  await clickText('.upload-actions button', '导入并核验')
  await wait("document.querySelector('#pg-proc .ppct')?.textContent.includes('第 2/3 份') && document.querySelector('#pg-proc .pst.on .pst-i')?.textContent === '4'")
  await clickText('.proc-actions button', '取消核验')
  await wait("document.querySelector('#pg-proc .ppct')?.textContent.includes('核验已取消')")
  assert.match(await evaluate("document.querySelector('#pg-proc .proc-t').textContent"), /《取消乙》/)
  assert.equal(await evaluate("document.querySelectorAll('#pg-proc .pst.on').length"), 0, '取消后当前步骤应停止')
  assert.equal(await evaluate("document.querySelectorAll('#pg-proc .pbar .indeterminate').length"), 0, '取消后进度条应停止动画')
  await screenshot('verification-cancelled')
  const cancelledIds = await saved(state => ['取消甲', '取消乙', '取消丙'].map(title => state.certificates.find(item => item.title === title).id))
  assert.deepEqual(verification.calls.slice(4), cancelledIds.slice(0, 2), '取消后不能再执行第三份文书')
  await clickText('.proc-actions button', '重试')
  await wait("document.querySelector('#pg-proc .ppct')?.textContent.includes('核验完成')")
  assert.equal(await evaluate("document.querySelectorAll('#pg-proc .pst.done').length"), 7, '完成时七个步骤都必须显示完成')
  assert.equal(await evaluate("Boolean(document.querySelector('#pg-proc .proc-skipped'))"), false, '没有跳过材料时不显示提示')
  assert.equal(await evaluate("document.querySelectorAll('#pg-proc .pst.on').length"), 0)
  await evaluate("new Promise(resolve=>setTimeout(resolve,200))")
  assert.equal(await evaluate("Boolean(document.querySelector('#pg-proc'))"), true, '完成后不能自动退出进度页')
  await screenshot('verification-complete')
  await clickText('.proc-actions button', '查看核验结果')
  await wait("document.querySelector('#pg-ws .ctool h1')?.textContent === '取消丙'")
  assert.match(await evaluate("document.querySelector('#pg-ws .topbar').textContent"), /王某诉李某民间借贷纠纷/)
  assert.deepEqual(verification.calls.slice(4), [cancelledIds[0], cancelledIds[1], cancelledIds[1], cancelledIds[2]])
  await require('./redesign-import-flow-checks.cjs')({ evaluate, wait, clickText, screenshot, verification, saved })
  await evaluate('window.__verificationObserver.disconnect(); true')
  verification.importProbe = false
  verification.progressTexts = []
  verification.enabled = false
  process.stdout.write('PASS batch verification, failure/cancellation resume and local history isolation\n')
}

module.exports.checkWordExport = async function checkWordExport({
  evaluate, wait, clickText, downloadWord, screenshot, directory, documentTest, editorOnly, assistantReportOnly, session, account,
  linkageMaterialFingerprint, saved, writeWorkspace,
}) {
  const caseId = 'qa-t1-case'
  const caseTitle = 'T1 Word 闸门回归案件'
  const readyId = 'qa-t1-ready'
  const readyTitle = 'T1 清稿'
  const evidenceId = 'qa-t1-receipt'
  const originalText = '被告已经交付借款。'
  const warningReason = '测试黄灯：需核对付款凭证签章。'
  const noteText = '测试人工核验标注。'
  const evidence = { id: evidenceId, caseId, number: '证据1', name: 'T1 付款凭证', fileName: 'T1 付款凭证.txt',
    type: 'text', ocrText: originalText, uploadedAt: '2026-11-15' }
  const omitted = { ...evidence, id: 'qa-t3-identity', number: '证据2', name: '原告身份证', fileName: '原告身份证.txt', ocrText: '受控身份材料' }
  const catalogTitle = 'T3 证据清单'
  const diagnosticText = '卷内材料未列入证据清单，请复核是否应补列。'
  const dependencyTitle = 'T6 跨段联动报告'
  const lawQuote = '《合同法》第一百零七条'
  const dependencyReason = '依赖事实待核验，重新检查法律适配。'
  const reviewTitle = 'T6 逐声明人工复核'
  const reviewId = 'qa-t6-declaration-review'
  const reviewFirst = '被告已经交付借款'
  const reviewSecond = '利息详见凭证'
  const reviewBody = `${reviewFirst}，${reviewSecond}。`
  const reviewNote = '该借款交付已逐条核对'
  const deleteTitle = 'T6 缺源声明删除'
  const deleteId = 'qa-t6-declaration-delete'
  const repeatedText = '被告已交付款项。'
  const missingId = `${deleteId}:${deleteId}-body:0:${repeatedText.length}:E-FACT`
  const caseReportTitle = 'T7 案例报告文书'
  const caseReportId = 'qa-t7-report'
  const caseQuery = 'T7案例报告检索'
  const sampleCase = (id, name, index) => ({ id, title: `${caseQuery} · ${name}`, caseNumber: `（2024）京01民终${index}号`,
    courtName: '测试法院', courtLevel: '', region: '', trialLevel: '', caseType: '', cause: '', judgmentDate: '2024-06-01', effectiveDate: '',
    issueSummary: '', holdingSummary: `${name}裁判摘要`, reasoningSummary: '', resultSummary: '', sourceUrl: `https://example.invalid/cases/${id}`,
    sourceType: 'qa-fixture', keywords: [], focusTags: [], referencedStatutes: [], excerpts: [],
  })
  const linkedCase = sampleCase('qa-t7-linked', '文书关联类案', 1)
  const selectedCase = sampleCase('qa-t7-selected', '选入待核类案', 2)
  const skippedCase = sampleCase('qa-t7-skipped', '未选类案', 3)
  const blockedCase = sampleCase('qa-t7-blocked', '不可引用类案', 4)
  const titles = { fail: 'T1 不通过', miss: 'T1 缺源', pending: 'T1 待核', empty: 'T1 空稿', stale: 'T1 旧快照', warn: 'T1 黄灯', note: 'T1 标注' }
  const wordButtons = '#pg-report .report-actions button'
  const wordModes = ['导出审阅版 Word', '清洁版 + 报告']
  let materialKey
  const makeDocument = (verdict, id = `qa-t1-${verdict}`, title = titles[verdict], text = originalText) => {
    const paragraphId = `${id}-body`
    const paragraph = { id: paragraphId, text, richText: `<p>${text}</p>`, verified: verdict === 'pass' || verdict === 'note',
      ...(verdict === 'note' ? { note: noteText } : {}) }
    const declaration = { id: `${id}-declaration`, type: 'E-FACT', quote: text, verdict, conf: null,
      location: { paragraphId, paragraphIndex: 0, start: 0, end: text.length },
      checks: { A1: { outcome: verdict === 'note' ? 'pass' : verdict, reason: 'T1 测试' } },
      reason: verdict === 'warn' ? warningReason : 'T1 回归用例',
      sources: verdict === 'miss' ? [] : [{ tier: 'l1', id: evidenceId, name: evidence.name, quote: originalText, locator: '段落 1' }],
    }
    return { id, title, caseId, role: 'plaintiff', docKey: 'qs', focus: '', createdAt: '2026-11-15',
      linkageInputKey: materialKey, linkageStale: verdict === 'stale',
      paragraphs: verdict === 'empty' ? [] : [paragraph], paragraphIds: verdict === 'empty' ? [] : [paragraphId],
      verification: { version: 1, profileVersion: 'qa', inputKey: materialKey, docKey: 'qs', classificationRequired: false,
        declarations: ['empty', 'stale'].includes(verdict) ? [] : [declaration] },
    }
  }
  await saved(async state => {
    state.cases.push({ id: caseId, name: caseTitle, description: '', status: 'draft', createdAt: '2026-11-15',
      agent: { position: { role: 'plaintiff', party: '测试原告', confirmedAt: '2026-11-15', version: 1, goals: [], admissions: [], disputes: [], boundaries: [] } } })
    state.evidences.push(evidence, omitted)
    materialKey = linkageMaterialFingerprint([evidence, omitted], [])
    const catalog = makeDocument('pass', 'qa-t3-catalog', catalogTitle, evidence.name)
    catalog.docKey = catalog.verification.docKey = 'zj'
    catalog.verification.declarations[0].type = 'E-EVID'
    catalog.verification.documentDiagnostics = [{ code: 'A3', verdict: 'warn', reason: diagnosticText,
      sources: [{ tier: 'l1', id: omitted.id, name: omitted.name, locator: '第 1 段' }] }]
    const dependent = makeDocument('miss', 'qa-t6-dependency', dependencyTitle)
    const lawId = 'qa-t6-dependency-law'
    dependent.paragraphs.push({ id: lawId, text: lawQuote, verified: false })
    dependent.paragraphIds.push(lawId)
    dependent.verification.declarations.push({ id: lawId, type: 'E-LAW', quote: lawQuote, verdict: 'pending', conf: null,
      location: { paragraphId: lawId, paragraphIndex: 1, start: 0, end: lawQuote.length },
      checks: { B4: { outcome: 'pending', reason: dependencyReason } }, reason: dependencyReason,
      dependencies: [{ id: dependent.verification.declarations[0].id, check: 'B4' }],
      sources: [{ tier: 'l2', id: 'qa-t6-statute', name: '测试合同法', locator: '第一百零七条', version: '受控版本' }],
    })
    const caseDocument = makeDocument('fail', caseReportId, caseReportTitle)
    const [fact] = caseDocument.verification.declarations
    const caseLocation = entry => {
      const paragraphId = `${entry.id}-body`
      const text = entry.caseNumber
      const paragraphIndex = caseDocument.paragraphs.length
      caseDocument.paragraphs.push({ id: paragraphId, text, verified: false })
      caseDocument.paragraphIds.push(paragraphId)
      return { paragraphId, paragraphIndex, start: 0, end: text.length }
    }
    const caseVerification = (entry, allowCitation) => ({
      caseNumber: entry.caseNumber, name: entry.title, court: entry.courtName, judgmentDate: entry.judgmentDate,
      provider: 'qa-fixture', queryOutcome: 'ok', detailOutcome: 'ok', checkedAt: '2026-11-15', allowCitation,
      effect: allowCitation ? 'effective' : 'vacated', match: allowCitation ? 'strict' : 'irrelevant',
      documents: [{ id: entry.id, caseNumber: entry.caseNumber, provider: 'qa-fixture', url: entry.sourceUrl }],
    })
    caseDocument.verification.declarations.push(
      { ...fact, id: `${fact.id}-linked`, type: 'E-CASE', quote: linkedCase.caseNumber, location: caseLocation(linkedCase),
        verdict: 'warn', caseVerification: caseVerification(linkedCase, true),
        sources: [{ tier: 'l3', id: linkedCase.id, name: linkedCase.title, locator: '裁判理由第 1 段', quote: linkedCase.holdingSummary }] },
      { ...fact, id: `${fact.id}-blocked`, type: 'E-CASE', quote: blockedCase.caseNumber, location: caseLocation(blockedCase),
        caseVerification: caseVerification(blockedCase, false), sources: [] },
    )
    state.knowledgeCases.push(linkedCase, selectedCase, skippedCase, blockedCase)
    const reviewDocument = makeDocument('pending', reviewId, reviewTitle, reviewBody)
    const [first] = reviewDocument.verification.declarations
    reviewDocument.verification.revision = 'qa-t6-v1'
    Object.assign(first, { quote: reviewFirst, location: { ...first.location, end: reviewFirst.length },
      checks: { A1: { outcome: 'pass', reason: '已定位' }, A2: { outcome: 'pending', reason: '律师核对交付凭证' } } })
    reviewDocument.verification.declarations.push({ ...first, id: `${first.id}-second`, quote: reviewSecond, type: 'E-CALC', verdict: 'warn',
      location: { ...first.location, start: reviewFirst.length + 1, end: reviewBody.length - 1 },
      checks: { A3: { outcome: 'warn', reason: warningReason } }, reason: warningReason })
    const deleteDocument = makeDocument('miss', deleteId, deleteTitle, repeatedText.repeat(2))
    deleteDocument.paragraphs[0].richText = `<p>${repeatedText}<strong>${repeatedText}</strong></p>`
    deleteDocument.verification.profileVersion = require('../../server/src/intelligence/verification/doc-element-profile.json').version
    const [missingDeclaration] = deleteDocument.verification.declarations
    missingDeclaration.id = missingId
    missingDeclaration.quote = repeatedText
    missingDeclaration.location.end = repeatedText.length
    missingDeclaration.location.sentenceIndex = 0
    deleteDocument.verification.declarations.push({ ...missingDeclaration, verdict: 'pending',
      id: `${deleteId}:${deleteId}-body:${repeatedText.length}:${repeatedText.length * 2}:E-FACT`,
      location: { ...missingDeclaration.location, sentenceIndex: 1, start: repeatedText.length, end: repeatedText.length * 2 },
      checks: { A1: { outcome: 'pending', reason: '第二处原文待核' } } })
    state.certificates.push(makeDocument('pass', readyId, readyTitle), ...Object.keys(titles).map(verdict => makeDocument(verdict)),
      catalog, dependent, caseDocument, reviewDocument, deleteDocument)
    await writeWorkspace(state)
  })
  const waitTitle = title => wait(`document.querySelector('.ctool h1')?.textContent === ${JSON.stringify(title)}`)
  const switchTo = async title => {
    await evaluate(`Array.from(document.querySelectorAll('.workspace-doc-strip .workspace-doc-name')).find(item=>item.textContent===${JSON.stringify(title)}).closest('[role=tab]').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}))`)
    await waitTitle(title)
    await wait("document.querySelector('.whole-document-content')")
  }
  const openReport = async title => {
    await clickText('.topbar button', '导出文书')
    await wait(`document.querySelector('#pg-report .rp-hero h1')?.textContent === ${JSON.stringify(`${title} · 核验报告`)}`)
  }
  const back = () => clickText('.topbar button', '← 返回工作台')
  const expectModes = async disabled => {
    for (const label of wordModes) await wait(`Array.from(document.querySelectorAll(${JSON.stringify(wordButtons)})).some(button=>button.textContent.trim()===${JSON.stringify(label)}&&button.disabled===${disabled})`)
  }
  const noWord = async (name, work) => {
    const list = () => fs.readdirSync(directory).filter(item => item.endsWith('.docx')).sort()
    const before = list()
    let fail
    const download = new Promise((_resolve, reject) => { fail = reject })
    const unexpected = (event, item) => {
      event.preventDefault()
      fail(new Error(`${name} 触发了意外下载：${item.getFilename()}`))
    }
    session.on('will-download', unexpected)
    try {
      await Promise.race([download, (async () => { await work(); await new Promise(resolve => setTimeout(resolve, 150)) })()])
      assert.deepEqual(list(), before, `${name} 不得产生 DOCX 文件`)
    } finally {
      session.removeListener('will-download', unexpected)
    }
  }
  const refused = (label, message, selector = wordButtons) => noWord(label, async () => {
    if (documentTest.exportSnapshot) await evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(button=>button.textContent.trim()===${JSON.stringify(label)})
      .addEventListener('click',()=>{window.__qaReadExportSnapshot=true},{once:true,capture:true})`)
    await clickText(selector, label)
    await wait("document.querySelector('.new-error')")
    const actual = await evaluate("document.querySelector('.new-error span').textContent")
    assert.ok(actual.includes(message), `${label} 预期被 ${message} 阻断，实际：${actual}`)
    await clickText('.new-error button', '关闭')
    await wait("!document.querySelector('.new-error')")
  })
  const exportBoth = async (tag, marker, expectedText = originalText) => {
    const { extractRawText } = require('mammoth')
    const files = []
    for (const [index, label] of wordModes.entries()) {
      const file = await downloadWord(label, `t1-${tag}-${index}.docx`)
      files.push(file)
      assert.equal(fs.readFileSync(file).subarray(0, 2).toString(), 'PK')
      const { value } = await extractRawText({ path: file })
      assert.ok(value.includes(expectedText) && value.includes('段落核验记录'), `${label} 正文和核验报告应落入文件`)
      if (marker) assert.ok(value.includes(marker), `${label} 应保留 ${marker}`)
    }
    return files
  }
  const checkEditorPersistence = async () => {
    await switchTo(readyTitle)
    const editorButtons = '.document-editor-tools button'
    await wait("Array.from(document.querySelectorAll('.document-editor-tools button')).some(button => button.textContent.trim() === '导出原格式' && !button.disabled)")
    const original = await downloadWord('导出原格式', 't1-original.docx', editorButtons)
    assert.match((await require('mammoth').extractRawText({ path: original })).value, /被告已经交付借款/)
    const setDraft = () => evaluate(`new Promise((resolve,reject)=>{
      const key=${JSON.stringify(JSON.stringify(['lawverify-document', account, readyId]))};
      const request=indexedDB.open('lawverify-drafts',1);
      request.onupgradeneeded=()=>request.result.createObjectStore('paragraphs',{keyPath:'key'});
      request.onerror=()=>reject(request.error);
      request.onsuccess=()=>{
        const db=request.result, tx=db.transaction('paragraphs','readwrite'), store=tx.objectStore('paragraphs');
        store.put({key,text:'[]',richText:'<p>T1 未保存正文</p>',baseText:'[]',baseRichText:'[]',revision:'test'});
        tx.oncomplete=()=>{db.close();resolve(true)};
        tx.onerror=()=>reject(tx.error);
      };
    })`)
    await setDraft()
    await openReport(readyTitle)
    await expectModes(false)
    for (const label of wordModes) await refused(label, '尚未保存的草稿')
    await back()
    await wait("document.querySelector('.document-editor-notice')?.textContent.includes('发现未提交的文书草稿')")
    assert.equal(await evaluate("Array.from(document.querySelectorAll('.document-editor-tools button')).find(button=>button.textContent.trim()==='导出原格式').disabled"), true)
    await clickText('.document-editor-notice button', '使用已保存正文')

    await wait("document.querySelector('.whole-document-content[contenteditable=true]')")
    await evaluate(`(() => {
      const editor = document.querySelector('.whole-document-content');
      editor.focus();
      getSelection().collapse(editor.lastElementChild, editor.lastElementChild.childNodes.length);
      document.execCommand('insertText', false, '已修改。');
    })()`)
    await wait("document.querySelector('.document-editor-status')?.textContent.includes('修改已保存在本机草稿')")
    const saveCalls = documentTest.saveCalls
    documentTest.failSave = true
    try {
      await noWord('文书保存失败', async () => {
        await clickText('.topbar button', '导出文书')
        await wait("document.querySelector('.document-editor-status')?.textContent.includes('测试文书保存失败')")
        assert.equal(await evaluate("Boolean(document.querySelector('#pg-report'))"), false)
        assert.equal(documentTest.saveCalls, saveCalls + 1)
      })
    } finally { documentTest.failSave = false }
    await clickText(editorButtons, '保存文书')
    await wait("document.querySelector('.document-editor-status')?.textContent.includes('整篇文书已保存')")
    assert.match(await saved(state => state.certificates.find(item => item.id === readyId).paragraphs[0].text), /被告已经交付借款。已修改。/)
  }
  await evaluate('location.reload()')
  await wait(`Array.from(document.querySelectorAll('.case-card')).some(item=>item.textContent.includes(${JSON.stringify(caseTitle)}))`)
  await evaluate(`Array.from(document.querySelectorAll('.case-card')).find(item=>item.textContent.includes(${JSON.stringify(caseTitle)})).click()`)
  await waitTitle(readyTitle)
  if (editorOnly) {
    await checkEditorPersistence()
    return
  }
  await openReport(readyTitle)
  await expectModes(false)
  await evaluate(`(() => {
    const fetchWorkspace=window.fetch.bind(window);
    window.__qaRestoreExportFetch=()=>{window.fetch=fetchWorkspace};
    window.fetch=(input,options)=>{
      const url=new URL(input instanceof Request?input.url:input,location.href);
      if(window.__qaReadExportSnapshot&&url.pathname==='/api/workspace'){
        window.__qaReadExportSnapshot=false;
        const headers=new Headers(options?.headers);
        headers.set('x-qa-export-snapshot','1');
        return fetchWorkspace(input,{...options,headers});
      }
      return fetchWorkspace(input,options);
    };
  })()`)
  try {
    for (const [verdict, message] of Object.entries({ fail: '1 项不通过', miss: '1 项不通过', pending: '1 项不通过', empty: '没有可导出的正文', stale: '当前正文或材料尚未完成核验' })) {
      documentTest.exportSnapshot = makeDocument(verdict, readyId, readyTitle)
      await expectModes(false)
      for (const label of wordModes) await refused(label, message)
    }
  } finally {
    delete documentTest.exportSnapshot
    await evaluate('window.__qaRestoreExportFetch()')
  }
  await exportBoth('pass')
  await back()
  for (const verdict of ['fail', 'miss', 'pending', 'empty', 'stale']) {
    await switchTo(titles[verdict])
    await wait("Array.from(document.querySelectorAll('.document-editor-tools button')).some(button=>button.textContent.trim()==='导出原格式'&&button.disabled)")
    await openReport(titles[verdict])
    await expectModes(true)
    if (verdict === 'miss') {
      assert.equal(await evaluate("document.querySelector('#pg-report .report-source-stats .stat b')?.textContent"), '0')
      await evaluate("document.querySelector('#pg-report .iss')?.click()")
      await wait("document.querySelector('#pg-ws .rc .src-dot.l0')")
      assert.equal(await evaluate("Boolean(document.querySelector('#pg-ws .rc .src-dot:is(.l1,.l2,.l3)'))"), false)
      await openReport(titles.miss)
    }
    await noWord(titles[verdict], async () => {
      for (const label of wordModes) await clickText(wordButtons, label)
    })
    await back()
  }
  for (const [verdict, marker] of [['warn', warningReason], ['note', noteText]]) {
    await switchTo(titles[verdict])
    await openReport(titles[verdict])
    await expectModes(false)
    await exportBoth(verdict, marker)
    await back()
  }
  await switchTo(catalogTitle)
  await openReport(catalogTitle)
  await wait("Array.from(document.querySelectorAll('#pg-report .report-section h2')).some(item=>item.textContent==='文书级预警')")
  await expectModes(false)
  await clickText('#pg-report .report-case-list button', `${omitted.name} · 第 1 段`)
  await wait(`document.querySelector('.new-drawer .dwt')?.textContent === ${JSON.stringify(omitted.name)}`)
  await clickText('.new-drawer button', 'Close')
  await wait("!document.querySelector('.new-drawer')")
  await exportBoth('catalog-warning', diagnosticText, evidence.name)
  console.log('PASS T3 L0 badge, document diagnostic and both Word downloads')
  await back()
  await switchTo(dependencyTitle)
  await wait("document.querySelector('.mat-scroll .mat-it .mat-nm') && document.querySelector('.mat-scroll').textContent.includes('测试合同法')")
  await openReport(dependencyTitle)
  await expectModes(true)
  await wait(`document.querySelector('.report-case-list .report-location')?.closest('li').textContent.includes(${JSON.stringify(dependencyReason)})`)
  await wait("document.querySelector('#pg-report main').textContent.includes('测试合同法 受控版本')")
  await clickText('.report-location', `依赖声明 · ${originalText}`)
  await wait(`document.querySelector('#pg-ws .rc-q')?.textContent === ${JSON.stringify(originalText)}`)
  await openReport(dependencyTitle)
  await clickText('.report-location', `受影响声明 · ${lawQuote}`)
  await wait(`document.querySelector('#pg-ws .rc-q')?.textContent === ${JSON.stringify(lawQuote)}`)
  await switchTo(readyTitle)
  assert.equal(await evaluate("document.querySelector('.mat-scroll').textContent.includes('测试合同法')"), false)
  if (!assistantReportOnly) {
    await switchTo(reviewTitle)
    await evaluate(`Array.from(document.querySelectorAll('.review-todo-card')).find(item=>item.textContent.includes(${JSON.stringify(reviewFirst)})).click()`)
    await wait("document.querySelectorAll('.declaration-checks input').length === 2")
    assert.equal(await evaluate("Array.from(document.querySelectorAll('.rc .ops button')).find(item=>item.textContent.trim()==='确认声明').disabled"), true)
    await evaluate("document.querySelectorAll('.declaration-checks input').forEach(input=>input.click())")
    await clickText('.rc .ops button', '确认声明')
    await wait("document.querySelector('.rc .user-tag')?.textContent === '声明已人工确认'")
    await clickText('.rc .ops button', '批注')
    await evaluate(`(() => {
      const input = document.querySelector('.note-box textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(reviewNote)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`)
    await clickText('.note-box button', '保存批注')
    await wait(`!document.querySelector('.note-box') && document.querySelector('.rc').textContent.includes(${JSON.stringify(reviewNote)})`)
    await clickText('.pane-r button', '返回待办')
    await evaluate(`Array.from(document.querySelectorAll('.review-todo-card')).find(item=>item.textContent.includes(${JSON.stringify(reviewSecond)})).click()`)
    await wait("Array.from(document.querySelectorAll('.rc .ops button')).some(item=>item.textContent==='忽略预警'&&!item.disabled)")
    await clickText('.rc .ops button', '忽略预警')
    await wait("document.querySelector('.rc .ops button') && Array.from(document.querySelectorAll('.rc .ops button')).some(item=>item.textContent==='恢复预警')")
    await clickText('.pane-r button', '返回待办')
    await wait("document.querySelector('.review-todo-tabs button')?.textContent === '待办 0'")
    await openReport(reviewTitle)
    await expectModes(false)
  const [reviewDocx, cleanDocx] = await exportBoth('declaration-review', undefined, reviewBody)
    const readZip = file => require('jszip').loadAsync(fs.readFileSync(file))
    const reviewZip = await readZip(reviewDocx)
    const reviewXml = await reviewZip.file('word/document.xml').async('string')
    const commentsXml = await reviewZip.file('word/comments.xml').async('string')
    const commentId = [...commentsXml.matchAll(/<w:comment\b[^>]*w:id="(\d+)"[^>]*>[\s\S]*?<\/w:comment>/gu)].find(([part]) => part.includes(reviewNote))?.[1]
    assert.ok(commentId, '声明批注应落为原生 Word 批注')
    const commentRange = reviewXml.split(`<w:commentRangeStart w:id="${commentId}"/>`)[1]?.split(`<w:commentRangeEnd w:id="${commentId}"/>`)[0] ?? ''
    assert.equal([...commentRange.matchAll(/<w:t(?:\s[^>]*?)?>([^<]*)<\/w:t>/gu)].map(([, value]) => value).join(''), reviewFirst)
    const cleanZip = await readZip(cleanDocx)
  assert.doesNotMatch(await cleanZip.file('word/comments.xml')?.async('string') ?? '', /<w:comment\b/u)
  const cleanXml = await cleanZip.file('word/document.xml').async('string')
  assert.doesNotMatch(cleanXml, /<w:commentRangeStart\b/u)
  assert.ok(cleanXml.includes(reviewNote))
  assert.match(cleanXml, /律师已忽略此预警/u)
    const reviewed = await saved(state => state.certificates.find(item => item.id === reviewId).verification.declarations)
    assert.equal(reviewed[0].review.note, reviewNote)
    assert.equal(reviewed[1].review.ignored, true)
    assert.equal(reviewed[1].review.decision, undefined)
    await back()
  }
  await switchTo(caseReportTitle)
  const activeBadge = ".workspace-doc-strip [aria-selected=true] .workspace-doc-badge"
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(activeBadge)}).title`), '2 项待处理')
  await wait("document.querySelector('.review-todo-tabs button[aria-selected=true]')?.textContent === '待办 3'")
  assert.equal(await evaluate("document.querySelectorAll('.review-todo-card').length"), 3)
  await evaluate("document.querySelector('.review-todo-card[data-type=E-FACT]').click()")
  await wait(`document.querySelector('.whole-document-content [data-el="${caseReportId}-declaration"].sel')`)
  await wait(`document.querySelector('.rc-q')?.textContent === ${JSON.stringify(originalText)}`)
  await wait("document.querySelector('button.rc-loc')")
  await evaluate("document.querySelector('button.rc-loc').click()")
  await wait(`document.querySelector('.new-drawer .dwt')?.textContent === ${JSON.stringify(evidence.name)}`)
  await clickText('.new-drawer button', 'Close')
  await openReport(caseReportTitle)
  await expectModes(true)
  const previewText = await evaluate("Array.from(document.querySelectorAll('#pg-report summary')).find(item=>item.textContent.includes('案例检索报告预览')).parentElement.textContent")
  const linkedMarkers = [linkedCase.title, '裁判效力：生效', '命中层级：严格命中', '裁判理由第 1 段', linkedCase.holdingSummary]
  for (const marker of linkedMarkers) assert.ok(previewText.includes(marker), `报告页预览缺少 ${marker}`)
  await noWord('跨段报告中的文书 Word 闸门', async () => {
    for (const label of wordModes) await clickText(wordButtons, label)
  })
  const linkedReport = await downloadWord('导出案例检索报告', 't6-linked-case-report.docx')
  const { value: linkedText } = await require('mammoth').extractRawText({ path: linkedReport })
  for (const marker of [...linkedMarkers, linkedCase.sourceUrl]) assert.ok(linkedText.includes(marker), `案例报告缺少 ${marker}`)
  for (const entry of [blockedCase, selectedCase, skippedCase]) assert.ok(!linkedText.includes(entry.title))
  await back()
  await clickText('.review-detail-bar button', '返回待办')
  await wait("document.querySelector('.review-todo-card[data-type=E-CASE][data-verdict=warn]')")
  await evaluate("document.querySelector('.review-todo-card[data-type=E-CASE][data-verdict=warn]').click()")
  await wait(`document.querySelector('.whole-document-content [data-el="${caseReportId}-declaration-linked"].sel')`)
  await evaluate("document.querySelector('button.rc-loc').click()")
  await wait(`document.querySelector('.new-drawer')?.textContent.includes(${JSON.stringify(linkedCase.holdingSummary)})`)
  await clickText('.new-drawer button', 'Close')
  const singleReport = await downloadWord('导出本句案例', 't6-single-case-report.docx', '.rc button')
  const { value: singleText } = await require('mammoth').extractRawText({ path: singleReport })
  for (const marker of [...linkedMarkers, linkedCase.sourceUrl]) assert.ok(singleText.includes(marker), `单案报告缺少 ${marker}`)
  assert.ok(!singleText.includes(blockedCase.title))
  console.log('PASS T6 report dependency links, current-document authorities, Word blocking and independent case DOCX')
  await clickText('.workspace-right-tablist [role=tab]', 'AI 助手')
  await wait("document.querySelector('.workspace-ai-modes button[aria-label=\"查类案\"]:not(:disabled)')")
  await clickText('.workspace-ai-modes button', '查类案')
  const send = () => clickText('.assistant-composer button', '发送')
  const fillPrompt = value => evaluate(`(() => {
    const input = document.querySelector('.assistant-composer textarea')
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(value)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  const openSkills = async () => {
    await evaluate("document.querySelector('.workspace-ai-more').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}))")
    await wait("document.querySelector('[role=menu][data-state=open]')")
  }
  await fillPrompt(caseQuery)
  await send()
  const result = name => `Array.from(document.querySelectorAll('.workspace-ai-result')).find(item=>item.querySelector('h3')?.textContent===${JSON.stringify(name)})`
  try {
    await wait(`${result(blockedCase.title)} && ${result(skippedCase.title)} && ${result(selectedCase.title)}`)
  } catch (error) {
    const actual = await evaluate("document.querySelector('.workspace-ai-lookup')?.innerText")
    throw new Error(`助手类案检索未展示预期夹具：${actual}`, { cause: error })
  }
  await wait(`${result(selectedCase.title)}.querySelector('input[type=checkbox]')`)
  assert.equal(await evaluate(`${result(blockedCase.title)}.querySelector('input[type=checkbox]') === null`), true)
  await evaluate(`${result(selectedCase.title)}.querySelector('input[type=checkbox]').click()`)
  await openSkills()
  await clickText('.workspace-ai-menu [role=menuitemradio]', '案例报告')
  await fillPrompt('')
  await wait("document.querySelector('.workspace-ai-more[data-active] b')?.textContent === '案例报告'")
  assert.equal(await evaluate("document.querySelector('.assistant-composer button[type=submit]').disabled"), false)
  await evaluate("document.querySelector('.assistant-composer textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))")
  await wait("document.querySelector('.assistant-case-report')")
  const preview = await evaluate("Array.from(document.querySelectorAll('.assistant-case-report .workspace-ai-result'), item => item.textContent)")
  assert.equal(preview.length, 2)
  const expected = [linkedCase.title, linkedCase.caseNumber, '文书关联 · 黄·待核对 · 待人工审阅',
    '裁判效力：生效', '命中层级：严格命中', '裁判理由第 1 段', linkedCase.sourceUrl]
  expected.forEach(marker => assert.ok(preview[0].includes(marker), `预览缺少 ${marker}`))
  const supplemental = [selectedCase.title, selectedCase.caseNumber, '补充检索 · 待核对 · 仅作检索线索', selectedCase.sourceUrl]
  supplemental.forEach(marker => assert.ok(preview[1].includes(marker), `补充案例预览缺少 ${marker}`))
  const previewButton = '.assistant-case-report button'
  const confirmButton = '[role=dialog][data-state=open] button'
  await noWord('助手案例报告取消导出', async () => {
    await clickText(previewButton, '导出案例检索报告')
    await wait("document.querySelector('[role=dialog][data-state=open]')?.textContent.includes('确认导出案例报告')")
    await clickText(confirmButton, '取消')
    await wait("!document.querySelector('[role=dialog][data-state=open]')")
  })
  await clickText(previewButton, '导出案例检索报告')
  await wait("document.querySelector('[role=dialog][data-state=open]')?.textContent.includes('确认导出案例报告')")
  const caseFile = await downloadWord('确认导出 DOCX', 't7-assistant-case-research.docx', confirmButton)
  const { value: caseText } = await require('mammoth').extractRawText({ path: caseFile })
  for (const marker of ['检索任务', '检索结果概览', '逐案摘录', '核验声明', ...expected, ...supplemental]) {
    assert.ok(caseText.includes(marker), `实际案例报告缺少 ${marker}`)
  }
  for (const entry of [skippedCase, blockedCase]) {
    assert.ok(!preview.some(row => row.includes(entry.title)) && !caseText.includes(entry.title), `不应收录 ${entry.title}`)
  }
  console.log('PASS T7 assistant case report preview, confirmation and independent DOCX while document Word is blocked')

  await checkEditorPersistence()

  await clickText('.workspace-right-tablist [role=tab]', 'AI 助手')
  await wait("document.querySelector('.workspace-ai-modes')")
  await clickText('.workspace-ai-modes button', '起草文书')
  await send()
  await wait("Array.from(document.querySelectorAll('.document-generated-preview button')).some(button=>button.textContent.trim()==='采纳并保存草稿'&&!button.disabled)")
  await saved(state => assert.equal(state.certificates.some(item => item.caseId === caseId && item.title === '原告质证意见'), false))
  await clickText('.document-generated-preview button', '采纳并保存草稿')
  await waitTitle('原告质证意见')
  const drafted = await saved(state => state.certificates.find(item => item.caseId === caseId && item.title === '原告质证意见'))
  assert.ok(drafted.paragraphs.some(item => item.aiOrigin === 'draft' && !item.verified && item.links.some(link => link.evidenceId === evidenceId)))
  await wait("Array.from(document.querySelectorAll('.review-todo-card')).some(item=>item.textContent.includes('待核验'))")
  await openReport(drafted.title)
  await wait("document.querySelector('#pg-report .pill.text-pending')")
  await expectModes(true)
  await noWord('AI 起草经关联仍待核验', async () => {
    for (const label of wordModes) await clickText(wordButtons, label)
  })
  await screenshot('t1-ai-draft-export-blocked')

  await back()
  await wait("document.querySelector('.workspace-doc-strip')")
  if (!await evaluate("document.querySelector('.workspace-ai-panel')?.checkVisibility()")) await clickText('.workspace-right-tablist [role=tab]', 'AI 助手')
  await wait("document.querySelector('.workspace-ai-more')")
  for (const [skill, field] of [['证据三性', '真实性'], ['论证链检查', '论证断链'], ['金额复算', '算式'],
    ['风险与补强', '补证动作'], ['争议焦点', '共同争点'], ['时间线梳理', '日期待核']]) {
    await openSkills()
    await clickText('.workspace-ai-menu [role=menuitemradio]', skill)
    await send()
    await wait("document.querySelector('.workspace-ai-lookup .workspace-ai-result')")
    if (skill === '时间线梳理') {
      assert.ok(await evaluate("document.querySelector('.workspace-ai-lookup .workspace-ai-result ul')"))
    } else {
      assert.match(await evaluate("document.querySelector('.workspace-ai-lookup .workspace-ai-result').textContent"), new RegExp(field))
    }
  }
  await clickText('.workspace-ai-modes button', '查法条')
  await fillPrompt('《本地测试不存在的法规》第九十九条')
  await send()
  await wait("document.querySelector('.workspace-ai-lookup [role=status]')")
  assert.doesNotMatch(await evaluate("document.querySelector('.workspace-ai-lookup').textContent"), /确认引用到文末/)
  await openSkills()
  await clickText('.workspace-ai-menu [role=menuitemradio]', '卷内检索')
  await fillPrompt('交付借款')
  await send()
  await wait("document.querySelector('.workspace-ai-lookup .workspace-ai-result summary')")
  const beforeCitation = await saved(state => state.certificates.find(item => item.id === drafted.id).paragraphs.length)
  await clickText('.workspace-ai-lookup .workspace-ai-result summary', '预览拟引用原文')
  await clickText('.workspace-ai-lookup .workspace-ai-result button', '确认引用到文末')
  await wait("!Array.from(document.querySelectorAll('.workspace-ai-lookup button')).some(button=>button.textContent.trim()==='确认引用到文末')")
  await saved(state => {
    const written = state.certificates.find(item => item.id === drafted.id)
    assert.equal(written.paragraphs.length, beforeCitation + 1)
    const citation = written.paragraphs.at(-1)
    assert.equal(citation.aiOrigin, 'citation')
    assert.ok(written.verification.declarations.some(item => item.location.paragraphId === citation.id && item.verdict === 'pending'))
  })
  console.log('PASS T7 six analysis cards, missing statute citation and verified materials adoption')

  if (!assistantReportOnly) {
    await switchTo(deleteTitle)
    await wait("document.querySelector('.review-todo-tabs button[aria-selected=true]')?.textContent === '待办 2'")
    assert.equal(await evaluate("document.querySelector('.workspace-doc-strip [aria-selected=true] .workspace-doc-badge')?.title"), '2 项待处理')
    await evaluate("Array.from(document.querySelectorAll('.review-todo-card')).find(item=>item.textContent.includes('缺源')).click()")
    await clickText('.rc .ops button', '删除缺源声明')
    await clickText('[aria-label="确认修改声明"] button', '取消')
    await saved(state => assert.equal(state.certificates.find(item => item.id === deleteId).paragraphs[0].text, repeatedText.repeat(2)))
    await clickText('.rc .ops button', '删除缺源声明')
    await clickText('[aria-label="确认修改声明"] button', '确认删除')
    await wait("document.querySelector('#pg-proc .ppct')?.textContent.includes('核验完成')")
    const rechecked = await saved(state => {
      const current = state.certificates.find(item => item.id === deleteId)
      assert.equal(current.paragraphs[0].text, repeatedText)
      assert.equal(current.paragraphs[0].richText, `<p><strong>${repeatedText}</strong></p>`)
      assert.equal(current.verification.dirty, undefined)
      const deleted = current.verification.audit.find(item => item.action === 'delete')
      assert.equal(deleted?.declarationId, missingId)
      assert.equal(deleted.quote, repeatedText)
      assert.equal(current.verification.audit.at(-1).note, '局部重核')
      assert.deepEqual(current.verification.declarations.map(item => [item.quote, item.verdict]), [[repeatedText, 'miss']])
      assert.ok(current.verification.verifiedAt)
      return current.verification
    })
    await clickText('.proc-actions button', '查看核验结果')
    await wait("document.querySelector('.review-todo-tabs button[aria-selected=true]')?.textContent === '待办 1'")
    assert.equal(await evaluate("document.querySelector('.workspace-doc-strip [aria-selected=true] .workspace-doc-badge')?.title"), '1 项待处理')
    assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('.review-todo-quote'), item => item.textContent)"), [repeatedText])
    await openReport(deleteTitle)
    assert.equal(await evaluate("document.querySelector('.report-footnote time')?.dateTime"), rechecked.verifiedAt)
    assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('#pg-report .report-section .iss-t'), item => item.textContent)"), [repeatedText])
    assert.match(await evaluate("document.querySelector('.report-conclusion').textContent"), /1 项不通过或缺源/)
    await clickText('.report-section summary h2', '人工操作与核验记录')
    await wait(`Array.from(document.querySelectorAll('.report-audits > div')).some(item=>item.textContent.includes('删除缺源声明') && item.textContent.includes(${JSON.stringify(repeatedText)}))`)
    await screenshot('t9-local-recheck-report')
    console.log('PASS T6 missing-source deletion preserves adjacent formatting and audit')
  }
}
