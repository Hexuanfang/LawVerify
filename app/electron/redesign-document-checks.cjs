const assert = require('node:assert/strict')
const { readFile } = require('node:fs/promises')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { openArrayBuffer } = require('mammoth/lib/zipfile.js')
const { bodyParagraphs, editorReady, selectDocxRange } = require('./redesign-docx-input-checks.cjs')
const { sendHighlightClick } = require('./redesign-highlight-checks.cjs')

async function readSavedDocx(document) {
  const serverDist = process.env.LAWVERIFY_REDESIGN_SERVER_DIST ?? path.resolve(__dirname, '../../server/dist')
  const { officePath } = await import(pathToFileURL(path.join(serverDist, 'office/files.js')).href)
  return openArrayBuffer(await readFile(officePath(document.officeFile.id)))
}

module.exports = async function checkDocument({ evaluate, wait, clickText, fill, screenshot, window, saved, writeWorkspace, reload, enter }) {
  const open = async () => {
    if (!await evaluate("Boolean(document.querySelector('#pg-ws'))")) await enter('必要工作流测试')
    await wait("document.querySelector('.whole-document-content')")
  }
  const selectBlock = (index, position = 'all') => selectDocxRange({ evaluate, wait, window },
    `${bodyParagraphs}[${index}]`, undefined, 0, position === 'start' ? 0 : null)
  const clickQuote = async text => {
    await sendHighlightClick({ evaluate, wait, window },
      `Array.from(document.querySelectorAll('.lawverify-review')).find(item=>item.textContent.includes(${JSON.stringify(text)}))`)
    await wait(`document.querySelector('.review-result-details blockquote')?.textContent.includes(${JSON.stringify(text)}) && document.querySelector('.review-result-actions button')`)
  }
  const reviewAction = async label => {
    if (await evaluate(`Array.from(document.querySelectorAll('.review-result-actions button')).some(item => item.textContent.trim() === ${JSON.stringify(label)})`)) {
      await clickText('.review-result-actions button', label)
    } else {
      await clickText('.review-result-actions button', '更多操作')
      await clickText('[role=menuitem]', label)
    }
  }
  const replaceBlock = async (index, text) => {
    await selectBlock(index)
    await window.webContents.insertText(text)
    await wait(`Array.from(${bodyParagraphs}[${index}]?.querySelectorAll('.superdoc-text-run') ?? []).map(run=>run.textContent).join('')===${JSON.stringify(text)}`)
    await wait("!document.querySelector('.document-save-button').disabled")
  }
  const key = async keyCode => {
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode })
  }
  const save = async () => {
    await wait("!document.querySelector('.document-save-button')?.disabled")
    await clickText('.document-editor-tools button', '保存文书')
    await wait("document.querySelector('.document-editor-status')?.textContent.includes('整篇文书已保存')")
    await wait("document.querySelector('.document-save-button').disabled")
  }
  const close = async () => {
    await clickText('.topbar button.brand-home', 'LawVerify 首页')
    await wait("document.querySelector('#pg-home')")
  }
  const restoreDraft = async () => {
    await wait("Array.from(document.querySelectorAll('.document-editor-inline button')).some(item=>item.textContent==='恢复草稿'&&!item.disabled)")
    await clickText('.document-editor-inline button', '恢复草稿')
    await wait("!Array.from(document.querySelectorAll('.document-editor-inline button')).some(item=>item.textContent==='恢复草稿')")
  }

  await open()
  await wait(editorReady)
  assert.match(await evaluate("document.querySelector('.whole-document-content').textContent"), /审阅测试.*借款已交付。尚未还款。/)
  await selectBlock(1)
  await evaluate("document.querySelector('.document-editor-toolbar [aria-label=加粗]').click()")
  await save()
  await saved(state => {
    const paragraphs = state.certificates.find(item => item.id === 'essential-doc').paragraphs
    assert.match(paragraphs[1].richText, /<strong>/)
    assert.equal(paragraphs[1].references.length, 2)
  })
  const readPageMargins = () => saved(async state => {
    const zip = await readSavedDocx(state.certificates.find(item => item.id === 'essential-doc'))
    return (await zip.read('word/document.xml', 'utf8')).match(/<w:pgMar\b[^>]*>/gu) ?? []
  })
  const originalPageMargins = await readPageMargins()
  assert.ok(originalPageMargins.length, 'Word 工作副本应包含页边距')
  await replaceBlock(1, '临时修改待保存。')
  await wait(`${bodyParagraphs}[1].querySelectorAll('.lawverify-review').length===0`)
  await evaluate("document.querySelector('.document-editor-toolbar [aria-label=撤销]').click()")
  await wait(`${bodyParagraphs}[1].textContent==='借款已交付。尚未还款。'`)
  await wait(`${bodyParagraphs}[1].querySelector('.lawverify-review')`)
  await save()
  assert.deepEqual(await readPageMargins(), originalPageMargins, '工作台显示留白调整不得改写 Word 页边距')
  const size = window.getSize()
  window.setSize(390, 900)
  await new Promise(resolve => setTimeout(resolve, 180))
  assert.equal(await evaluate("document.querySelector('.document-editor-inline').scrollWidth <= innerWidth"), true)
  await screenshot('document-editor-390')
  window.setSize(...size)
  await new Promise(resolve => setTimeout(resolve, 120))
  await screenshot('document-editor')


  await close()
  const originalHeading = await saved(state => state.certificates.find(item => item.id === 'essential-doc').paragraphs[0])
  const legacyDraft = { key: JSON.stringify(['redesign-qa@test.invalid', 'essential-doc', originalHeading.id]),
    revision: 'legacy-test-draft', baseText: originalHeading.text, baseRichText: originalHeading.richText,
    text: '旧版段落草稿', richText: '<h2>旧版段落草稿</h2>' }
  await evaluate(`new Promise((resolve,reject)=>{const request=indexedDB.open('lawverify-drafts');request.onsuccess=()=>{const transaction=request.result.transaction('paragraphs','readwrite');transaction.objectStore('paragraphs').put(${JSON.stringify(legacyDraft)});transaction.oncomplete=()=>resolve(true);transaction.onerror=()=>reject(transaction.error)}})`)
  await open()
  await restoreDraft()
  await close()
  await open()
  await restoreDraft()
  await save()
  await saved(state => assert.equal(state.certificates.find(item => item.id === 'essential-doc').paragraphs[0].text, '旧版段落草稿'))
  await close(); await open()
  await wait("document.querySelector('.whole-document-content[data-editable=true] .superdoc-page')")
  assert.equal(await evaluate("Array.from(document.querySelectorAll('.document-editor-inline button')).some(item=>item.textContent==='恢复草稿')"),false,'已保存的旧段落草稿不能再次出现')


  await replaceBlock(0, '草稿恢复测试标题')
  await close()
  await open()
  await restoreDraft()
  assert.match(await evaluate("document.querySelector('.whole-document-content').textContent"), /草稿恢复测试标题/)
  await save()
  await saved(state => {
    const paragraphs = state.certificates.find(item => item.id === 'essential-doc').paragraphs
    assert.equal(paragraphs[0].text, '草稿恢复测试标题')
    assert.equal(paragraphs[0].verified, false)
    assert.equal(paragraphs[1].text, '借款已交付。尚未还款。')
  })

  await replaceBlock(0, '冲突后的本机草稿')
  await wait("document.querySelector('.document-editor-status').textContent.includes('修改已保存在本机草稿')")
  await saved(async state => {
    const paragraph = state.certificates.find(item => item.id === 'essential-doc').paragraphs[0]
    paragraph.text = '外部新正文'; paragraph.richText = '<h2>外部新正文</h2>'
    await writeWorkspace(state)
  })
  await reload(); await enter('必要工作流测试'); await open()
  await restoreDraft()
  assert.equal(await evaluate("document.querySelector('.document-save-button').disabled"), true)
  await saved(state => assert.equal(state.certificates.find(item => item.id === 'essential-doc').paragraphs[0].text, '外部新正文'))
  await clickText('.document-editor-inline button', '已核对，以最新版本为基线继续')
  await save()

  await replaceBlock(1, '第一行。')
  const beforeSplit = await evaluate(`${bodyParagraphs}.length`)
  await key('Return')
  await wait(`${bodyParagraphs}.length===${beforeSplit + 1}`)
  await window.webContents.insertText('第二行。')
  await wait(`${bodyParagraphs}.some(node => node.textContent === '第二行。')`)
  await save()
  await saved(state => {
    const paragraphs = state.certificates.find(item => item.id === 'essential-doc').paragraphs
    assert.equal(paragraphs.length, 3)
    assert.equal(paragraphs[1].text, '第一行。')
    assert.equal(paragraphs[2].text, '第二行。')
    assert.notEqual(paragraphs[1].id, paragraphs[2].id)
  })
  await selectBlock(2, 'start'); await key('Backspace')
  await wait(`${bodyParagraphs}.length===2`)
  await save()
  await saved(state => {
    const paragraphs = state.certificates.find(item => item.id === 'essential-doc').paragraphs
    assert.equal(paragraphs.length, 2)
    assert.equal(paragraphs[1].text, '第一行。第二行。')
  })
  await selectBlock(1)
  await evaluate("document.querySelector('.document-editor-toolbar [aria-label=增加缩进]').click()")
  await save()
  await saved(state => assert.match(state.certificates.find(item => item.id === 'essential-doc').paragraphs[1].richText, /margin-left/))

  await close(); await open()
  await wait("document.querySelector('.whole-document-content[data-editable=true] .superdoc-page')")
  await selectBlock(1)
  await evaluate("document.querySelector('.document-editor-toolbar [aria-label=减少缩进]').click()")
  await wait("document.querySelector('.document-editor-status')?.textContent.includes('修改已保存在本机草稿')")
  await evaluate("document.querySelector('.document-editor-toolbar [aria-label=居中]').click()")
  await wait("document.querySelector('.document-editor-toolbar [aria-label=居中]').getAttribute('aria-pressed')==='true'")
  await evaluate("dispatchEvent(new KeyboardEvent('keydown',{key:'s',ctrlKey:true,bubbles:true}))")
  await wait("document.querySelector('.document-editor-status')?.textContent.includes('整篇文书已保存')")
  await saved(state => {
    const html=state.certificates.find(item=>item.id==='essential-doc').paragraphs[1].richText
    const margin = /margin-left:\s*(-?[\d.]+)/.exec(html)
    assert.equal(Number(margin?.[1] ?? 0), 0)
    assert.match(html,/text-align:\s*center/)
  })
  await close(); await open(); await wait("document.querySelector('.whole-document-content[data-editable=true] .superdoc-page')")

  await clickQuote('第一行。')
  await reviewAction('修改声明')
  await fill('.review-wide-editor textarea', '第一行已修改。')
  await clickText('.review-wide-editor button', '保存并局部重核')
  await wait("document.querySelector('.new-error')")
  assert.doesNotMatch(await evaluate("document.querySelector('.new-error').textContent"), /不一致|未找到原声明/)
  await saved(state => assert.equal(state.certificates.find(item => item.id === 'essential-doc').paragraphs[1].text, '第一行已修改。第二行。'))
  await clickText('.review-wide-editor button', '取消'); await clickText('.new-error button', '关闭')
  await reviewAction('关联出处')
  await evaluate(`(() => {
    const select = document.querySelector('.review-inline-operation select')
    select.value = 'essential-ev'
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
  await fill('[aria-label="出处定位"]', '第3页')
  await fill('[aria-label="出处原文"]', '已核对的新增引文')
  await saved(async state => {
    state.certificates.find(item => item.id === 'essential-doc').paragraphs[1].references = [{ id: 'external-ref', type: 'statute', targetId: 'essential-article', sourceTitle: '外部新增引用', label: '第一条', locator: '第一条', quote: '后台刚新增的引用' }]
    await writeWorkspace(state)
  })
  await clickText('.review-inline-operation button', '保存挂靠')
  await wait("document.querySelector('.new-error')?.textContent.includes('引用已有更新')")
  await saved(state => assert.equal(state.certificates.find(item => item.id === 'essential-doc').paragraphs[1].references[0].quote, '后台刚新增的引用'))
  await clickText('.review-inline-operation button', '取消'); await clickText('.new-error button', '关闭')
  await saved(async state => {
    const doc=state.certificates.find(item=>item.id==='essential-doc')
    doc.officeFile = undefined
    doc.paragraphs.push({id:'imported-table',text:'表头合并单元格',verified:false,richText:'<table><tbody><tr><th colspan="2"><p>表头</p></th></tr><tr><td rowspan="2"><p>合并单元格</p></td><td><p></p></td></tr></tbody></table><p><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" alt="导入图片"></p>'})
    doc.paragraphIds=doc.paragraphs.map(p=>p.id)
    await writeWorkspace(state)
  })
  await reload(); await enter('必要工作流测试'); await open()
  await wait("document.querySelector('.whole-document-content[data-editable=true] .superdoc-page')")
  await wait(`${bodyParagraphs}.some(node => node.textContent.includes('合并单元格'))`)
  await wait("document.querySelector('.whole-document-content .superdoc-page img')?.naturalWidth > 0")
  await selectBlock(0)
  await evaluate("document.querySelector('.document-editor-toolbar [aria-label=增加缩进]').click()")
  await save()
  await saved(async state => {
    const document = state.certificates.find(item => item.id === 'essential-doc')
    const { paragraphs } = document
    assert.ok(paragraphs.some(p=>p.richText.includes('colspan="2"')))
    assert.equal(new Set(paragraphs.map(p=>p.id)).size,paragraphs.length)
    const zip = await readSavedDocx(document)
    const relationships = await zip.read('word/_rels/document.xml.rels', 'utf8')
    const image = relationships.match(/Target="(?:\/word\/)?(media\/[^"/]+\.png)"/)
    assert.ok(image && zip.exists(`word/${image[1]}`), '旧文书的内嵌图片应写入 DOCX')
  })
  await close()

  await open()
  await wait("document.querySelector('.whole-document-content[data-editable=true] .superdoc-page')")
  await selectBlock(0)
  await evaluate("document.querySelector('[aria-label=段落样式]').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,pointerType:'mouse'}))")
  await wait("document.querySelector('[role=option]')");await clickText('[role=option]','正文')
  await replaceBlock(0,'甲方：张三')
  window.webContents.sendInputEvent({type:'keyDown',keyCode:'Return',modifiers:['shift']})
  window.webContents.sendInputEvent({type:'keyUp',keyCode:'Return',modifiers:['shift']})
  await window.webContents.insertText('乙方：李四')
  await save()
  await saved(state => {
    const paragraph = state.certificates.find(item => item.id === 'essential-doc').paragraphs[0]
    assert.equal(paragraph.text, '甲方：张三\n乙方：李四')
    assert.match(paragraph.richText, /^<p\b/, '从标题切换为正文应保存新的段落样式')
  })
  await close(); await open(); await wait("document.querySelector('.whole-document-content[data-editable=true] .superdoc-page')")
  await clickQuote('乙方：李四')
  await reviewAction('修改声明')
  await fill('.review-wide-editor textarea','乙方：李某')
  await clickText('.review-wide-editor button','保存并局部重核')
  await wait("document.querySelector('.new-error')")
  await saved(state=>assert.equal(state.certificates.find(item=>item.id==='essential-doc').paragraphs[0].text,'甲方：张三\n乙方：李某'))
  await clickText('.review-wide-editor button','取消');await clickText('.new-error button','关闭')
  await open();await wait("document.querySelector('.whole-document-content[data-editable=true] .superdoc-page')")
  await replaceBlock(0, '第一项')
  const beforeList = await evaluate(`${bodyParagraphs}.length`)
  await key('Return')
  await wait(`${bodyParagraphs}.length===${beforeList + 1}`)
  await window.webContents.insertText('第二项')
  await selectDocxRange({ evaluate, wait, window }, `${bodyParagraphs}[0]`, `${bodyParagraphs}[1]`)
  await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))")
  await evaluate("document.querySelector('.document-editor-toolbar [aria-label=无序列表]').click()")
  await save()
  await saved(async state => {
    const document = state.certificates.find(item => item.id === 'essential-doc')
    assert.match(document.paragraphs.map(block => block.text).join('\n'), /第一项\n第二项/)
    const zip = await readSavedDocx(document)
    assert.match(await zip.read('word/document.xml', 'utf8'), /<w:numPr>/)
  })
  await close()

  await open(); await wait("document.querySelector('.whole-document-content[data-editable=true] .superdoc-page')")
  await replaceBlock(0, '导出前保存正文。')
  await evaluate("document.querySelector('.workspace-report-button').click()")
  await wait("document.querySelector('#pg-report')")
  await saved(state => assert.ok(state.certificates.find(item => item.id === 'essential-doc').paragraphs.some(p => p.text.includes('导出前保存正文。'))))
  await clickText('.topbar button', '← 返回工作台')
  await wait("document.querySelector('.whole-document-content[data-editable=true] .superdoc-page')")
  assert.match(await evaluate("document.querySelector('.whole-document-content').textContent"), /导出前保存正文/)
  assert.equal(await evaluate("document.querySelector('.document-save-button').disabled"), true)

}
