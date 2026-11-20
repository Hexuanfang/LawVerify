const assert = require('node:assert/strict')

module.exports = async function checkDocument({ evaluate, wait, clickText, fill, screenshot, window, saved, writeWorkspace, reload, enter }) {
  const open = async () => {
    if (!await evaluate("Boolean(document.querySelector('#pg-ws'))")) await enter('必要工作流测试')
    await wait("document.querySelector('.whole-document-content')")
    if (await evaluate("document.querySelector('.workspace-edit-toggle').getAttribute('aria-pressed') === 'false'")) {
      await clickText('.workspace-document-heading button', '在线编辑')
    }
  }
  const selectBlock = async (index, position = 'all') => {
    await evaluate(`(() => {
      const node=document.querySelector('.whole-document-content').children[${index}];node.focus();
      const range=document.createRange();range.selectNodeContents(node);
      ${position === 'all' ? '' : `range.collapse(${position === 'start'});`}
      const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
      document.querySelector('.whole-document-content').focus();
    })()`)
  }
  const replaceBlock = async (index, text) => {
    await selectBlock(index)
    await window.webContents.insertText(text)
    await wait("!document.querySelector('.document-save-button').disabled")
  }
  const key = async keyCode => {
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode })
  }
  const save = async () => {
    await clickText('.document-editor-tools button', '保存文书')
    await wait("document.querySelector('.document-editor-status')?.textContent.includes('整篇文书已保存')")
    await wait("document.querySelector('.document-save-button').disabled")
  }
  const close = async () => {
    await clickText('.topbar button', '首页')
    await wait("document.querySelector('#pg-home')")
  }

  await open()
  await wait("document.querySelector('.whole-document-content[contenteditable=true]')")
  assert.match(await evaluate("document.querySelector('.whole-document-content').textContent"), /审阅测试.*借款已交付。尚未还款。/)
  await selectBlock(1)
  await evaluate("document.querySelector('.document-editor-toolbar [aria-label=加粗]').click()")
  await save()
  await saved(state => {
    const paragraphs = state.certificates.find(item => item.id === 'essential-doc').paragraphs
    assert.match(paragraphs[1].richText, /<strong>/)
    assert.equal(paragraphs[1].references.length, 2)
  })
  await replaceBlock(1, '临时修改待保存。')
  assert.equal(await evaluate("document.querySelector('.whole-document-content').children[1].querySelectorAll('.mk').length"), 0, '修改中的段落不能保留旧高亮')
  await evaluate("document.querySelector('.document-editor-toolbar [aria-label=撤销]').click()")
  await wait("document.querySelector('.whole-document-content').children[1].textContent==='借款已交付。尚未还款。'")
  await wait("document.querySelector('.whole-document-content').children[1].querySelector('.mk')")
  await save()
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
  await wait("Array.from(document.querySelectorAll('.document-editor-inline button')).some(item=>item.textContent==='恢复草稿')")
  await clickText('.document-editor-inline button', '恢复草稿')
  await close()
  await open()
  await wait("Array.from(document.querySelectorAll('.document-editor-inline button')).some(item=>item.textContent==='恢复草稿')")
  await clickText('.document-editor-inline button','恢复草稿')
  await save()
  await saved(state => assert.equal(state.certificates.find(item => item.id === 'essential-doc').paragraphs[0].text, '旧版段落草稿'))
  await close(); await open()
  await wait("document.querySelector('.whole-document-content[contenteditable=true]')")
  assert.equal(await evaluate("Array.from(document.querySelectorAll('.document-editor-inline button')).some(item=>item.textContent==='恢复草稿')"),false,'已保存的旧段落草稿不能再次出现')


  await replaceBlock(0, '草稿恢复测试标题')
  await close()
  await open()
  await wait("Array.from(document.querySelectorAll('.document-editor-inline button')).some(item=>item.textContent==='恢复草稿')")
  await clickText('.document-editor-inline button', '恢复草稿')
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
  await wait("Array.from(document.querySelectorAll('.document-editor-inline button')).some(item=>item.textContent==='恢复草稿')")
  await clickText('.document-editor-inline button', '恢复草稿')
  assert.equal(await evaluate("document.querySelector('.document-save-button').disabled"), true)
  await saved(state => assert.equal(state.certificates.find(item => item.id === 'essential-doc').paragraphs[0].text, '外部新正文'))
  await clickText('.document-editor-inline button', '已核对，以最新版本为基线继续')
  await save()

  await replaceBlock(1, '第一行。')
  const beforeSplit = await evaluate("document.querySelector('.whole-document-content').children.length")
  await key('Return')
  await wait("document.querySelector('.whole-document-content').children.length==="+(beforeSplit+1))
  await window.webContents.insertText('第二行。')
  await save()
  await saved(state => {
    const paragraphs = state.certificates.find(item => item.id === 'essential-doc').paragraphs
    assert.equal(paragraphs.length, 3)
    assert.equal(paragraphs[1].text, '第一行。')
    assert.equal(paragraphs[2].text, '第二行。')
    assert.notEqual(paragraphs[1].id, paragraphs[2].id)
  })
  await selectBlock(2, 'start'); await key('Backspace')
  await wait("document.querySelector('.whole-document-content').children.length===2")
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
  await wait("document.querySelector('.whole-document-content[contenteditable=true]')")
  await selectBlock(1)
  await evaluate("document.querySelector('.document-editor-toolbar [aria-label=减少缩进]').click()")
  await evaluate("document.querySelector('.document-editor-toolbar [aria-label=居中]').click()")
  await evaluate("dispatchEvent(new KeyboardEvent('keydown',{key:'s',ctrlKey:true,bubbles:true}))")
  await wait("document.querySelector('.document-editor-status')?.textContent.includes('整篇文书已保存')")
  await saved(state => {
    const html=state.certificates.find(item=>item.id==='essential-doc').paragraphs[1].richText
    assert.doesNotMatch(html,/margin-left/)
    assert.match(html,/text-align:\s*center/)
  })
  await close(); await open(); await wait("document.querySelector('.whole-document-content[contenteditable=true]')")

  await evaluate("Array.from(document.querySelectorAll('.mk')).find(item=>item.textContent==='第一行。').click()")
  await clickText('.ops button', '修改声明')
  await fill('[aria-label="修改声明"]', '第一行已修改。')
  await clickText('.inline-actions button', '保存并局部重核')
  await wait("document.querySelector('.new-error')")
  assert.doesNotMatch(await evaluate("document.querySelector('.new-error').textContent"), /不一致|未找到原声明/)
  await saved(state => assert.equal(state.certificates.find(item => item.id === 'essential-doc').paragraphs[1].text, '第一行已修改。第二行。'))
  await clickText('.inline-actions button', '取消'); await clickText('.new-error button', '关闭')
  await clickText('.ops button', '管理引用')
  await wait("document.querySelector('.essential-reference-dialog')")
  await saved(async state => {
    state.certificates.find(item => item.id === 'essential-doc').paragraphs[1].references = [{ id: 'external-ref', type: 'statute', targetId: 'essential-article', sourceTitle: '外部新增引用', label: '第一条', locator: '第一条', quote: '后台刚新增的引用' }]
    await writeWorkspace(state)
  })
  await clickText('.fm-ft button', '保存引用')
  await wait("document.querySelector('.new-error')?.textContent.includes('引用已有更新')")
  await saved(state => assert.equal(state.certificates.find(item => item.id === 'essential-doc').paragraphs[1].references[0].quote, '后台刚新增的引用'))
  await clickText('.fm-ft button', '取消'); await clickText('.new-error button', '关闭')
  await saved(async state => {
    const doc=state.certificates.find(item=>item.id==='essential-doc')
    doc.paragraphs.push({id:'imported-table',text:'表头合并单元格',verified:false,richText:'<table><tbody><tr><th colspan="2"><p>表头</p></th></tr><tr><td rowspan="2"><p>合并单元格</p></td><td><p></p></td></tr></tbody></table><p><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" alt="导入图片"></p>'})
    doc.paragraphIds=doc.paragraphs.map(p=>p.id)
    await writeWorkspace(state)
  })
  await reload(); await enter('必要工作流测试'); await open()
  await wait("document.querySelector('.whole-document-content[contenteditable=true]')")
  assert.equal(await evaluate("document.querySelector('.whole-document-content th').getAttribute('colspan')"),'2')
  assert.equal(await evaluate("document.querySelector('.whole-document-content td').getAttribute('rowspan')"),'2')
  assert.ok(await evaluate("document.querySelector('.whole-document-content img').src.startsWith('data:image/gif')"))
  await selectBlock(0)
  await evaluate("document.querySelector('.document-editor-toolbar [aria-label=增加缩进]').click()")
  await save()
  await saved(state => {
    const paragraphs=state.certificates.find(item=>item.id==='essential-doc').paragraphs
    assert.ok(paragraphs.some(p=>p.richText.includes('colspan="2"')))
    assert.ok(paragraphs.some(p=>p.richText.includes('data:image/gif')))
    assert.equal(new Set(paragraphs.map(p=>p.id)).size,paragraphs.length)
  })
  await close()

  await open()
  await wait("document.querySelector('.whole-document-content[contenteditable=true]')")
  await selectBlock(0)
  await evaluate("document.querySelector('[aria-label=段落样式]').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,pointerType:'mouse'}))")
  await wait("document.querySelector('[role=option]')");await clickText('[role=option]','正文')
  await replaceBlock(0,'甲方：张三')
  window.webContents.sendInputEvent({type:'keyDown',keyCode:'Return',modifiers:['shift']})
  window.webContents.sendInputEvent({type:'keyUp',keyCode:'Return',modifiers:['shift']})
  await wait("document.querySelector('.whole-document-content').children[0].querySelector('br')")
  await window.webContents.insertText('乙方：李四')
  await save()
  await saved(state=>assert.equal(state.certificates.find(item=>item.id==='essential-doc').paragraphs[0].text,'甲方：张三\n乙方：李四'))
  await close(); await open(); await wait("document.querySelector('.whole-document-content[contenteditable=true]')")
  await evaluate("Array.from(document.querySelectorAll('.mk')).find(item=>item.textContent==='乙方：李四').click()")
  await clickText('.ops button','修改声明')
  await fill('[aria-label="修改声明"]','乙方：李某')
  await clickText('.inline-actions button','保存并局部重核')
  await wait("document.querySelector('.new-error')")
  await saved(state=>assert.equal(state.certificates.find(item=>item.id==='essential-doc').paragraphs[0].text,'甲方：张三\n乙方：李某'))
  await clickText('.inline-actions button','取消');await clickText('.new-error button','关闭')
  await open();await wait("document.querySelector('.whole-document-content[contenteditable=true]')")
  await replaceBlock(0,'第一项');const beforeList=await evaluate("document.querySelector('.whole-document-content').children.length");await key('Return');await wait("document.querySelector('.whole-document-content').children.length==="+(beforeList+1));await window.webContents.insertText('第二项')
  await evaluate("(()=>{const root=document.querySelector('.whole-document-content');const range=document.createRange();range.setStart(root.children[0],0);range.setEnd(root.children[1],root.children[1].childNodes.length);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);root.focus()})()")
  await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))")
  await evaluate("document.querySelector('.document-editor-toolbar [aria-label=无序列表]').click()")
  await save()
  await saved(state=>assert.ok(state.certificates.find(item=>item.id==='essential-doc').paragraphs.some(p=>p.richText.includes('<ul')&&p.text==='第一项\n第二项')))
  await close()

  await open(); await wait("document.querySelector('.whole-document-content[contenteditable=true]')")
  await replaceBlock(0, '导出前保存正文。')
  await evaluate("document.querySelector('.workspace-report-button').click()")
  await wait("document.querySelector('#pg-report')")
  await saved(state => assert.ok(state.certificates.find(item => item.id === 'essential-doc').paragraphs.some(p => p.text.includes('导出前保存正文。'))))
  await clickText('.topbar button', '← 返回工作台')
  await wait("document.querySelector('.whole-document-content[contenteditable=false]')")
  assert.match(await evaluate("document.querySelector('.whole-document-content').textContent"), /导出前保存正文/)
  assert.equal(await evaluate("document.querySelector('.document-save-button').disabled"), true)

}
