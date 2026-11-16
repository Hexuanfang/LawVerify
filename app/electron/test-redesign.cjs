const { app, BrowserWindow, ipcMain } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const http = require('node:http')

const root = path.resolve(__dirname, '..')
const directory = path.join(root, 'tmp', `redesign-qa-${Date.now()}`)
fs.mkdirSync(directory, { recursive: true })
app.setPath('userData', path.join(directory, 'electron-profile'))
app.disableHardwareAcceleration()
let server, window, latestImage
const errors = []
let failedDeleteCase = null
let accountStatus = 0
let cloudLogins = 0, authSampling = false, navigations = 0, workspaceReads = 0, finishedReads = 0, sessionFinishedAt = 0
let billingDelay = 0
const billingLog = []
const loadingMessages = new Set()
ipcMain.handle('redesign-qa-external', (_event, url) => {
  window.webContents.executeJavaScript('window.__accountOpenedUrl=' + JSON.stringify(url))
  return { ok: true }
})
ipcMain.on('redesign-qa-loading', (_event, message) => { if (authSampling) loadingMessages.add(message) })
ipcMain.handle('redesign-qa-account', async (_event, request) => {
  const profile = { user: { email: 'redesign-qa@test.invalid', name: '测试律师' }, organization: { id: 'qa', name: '测试', membershipId: 'qa', role: 'member' } }
  if (request.path === '/api/account/login') {
    cloudLogins++
    await new Promise(resolve => setTimeout(resolve, 150))
    return { status: 200, body: JSON.stringify({ success: true, data: { ...profile, token: 'qa-mocked-login-token' } }) }
  }
  if (accountStatus === 0) {
    const success = data => ({ status: 200, body: JSON.stringify({ success: true, data }) })
    if (request.path === '/api/account/me') return success({ id: 'qa', email: 'redesign-qa@test.invalid', displayName: '测试律师', tierName: '标准', pointsBalance: 2468, subscriptionExpiresAt: '' })
    if (request.path === '/api/account/point-ledger') return success({ items: [{ id: 'qa-ledger', createdAt: '2026-11-16T00:00:00Z', description: '回归充值', delta: 100, balanceAfter: 2468, entryType: 'recharge' }] })
    if (request.path === '/api/account/referrals') return success({ code: 'QA2026', inviteUrl: 'https://lawverify.zhijing.fun/register?invite=QA2026', invited: 3, rewarded: 1, earnedPoints: 100, enabled: true, inviterPoints: 100, inviteePoints: 100, minPaymentFen: 100 })
    if (request.path === '/api/account/feedback') return success({ item: { id: 'qa-feedback', status: 'pending', createdAt: new Date().toISOString() } })
    if (request.path === '/api/account/points/consume') {
      const payload = JSON.parse(request.body)
      billingLog.push({ type: 'charge', payload, headers: request.headers })
      if (billingDelay) await new Promise(resolve => setTimeout(resolve, billingDelay))
      return success({ entry: { id: 'charge-' + billingLog.length, description: '文书生成', createdAt: new Date().toISOString(), delta: -10, balanceAfter: 2458 }, pointsBalance: 2458 })
    }
    if (request.path === '/api/account/points/refund') {
      billingLog.push({ type: 'refund', payload: JSON.parse(request.body), headers: request.headers })
      return success({ entry: { id: 'refund-' + billingLog.length, description: '生成失败退款' }, pointsBalance: 2468 })
    }
  }
  return { status: accountStatus, body: JSON.stringify(accountStatus === 401
    ? { error: { code: 'SESSION_REPLACED', message: '账号已在其他设备登录，会话已失效。' } }
    : { success: true, data: request.path.includes('logout') ? { ok: true } : profile }) }
})
const preload = path.join(directory, 'qa-account-preload.cjs')
fs.writeFileSync(preload, "const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('lawVerifyDesktop',{requestAccount:request=>ipcRenderer.invoke('redesign-qa-account',request),openExternal:url=>ipcRenderer.invoke('redesign-qa-external',url),linkCaseDirectory:payload=>ipcRenderer.invoke('lawverify:case-directories-link',payload),scanCaseDirectories:payload=>ipcRenderer.invoke('lawverify:case-directories-scan',payload),clearCaseDirectories:payload=>ipcRenderer.invoke('lawverify:case-directories-clear',payload),readCaseDirectoryFile:payload=>ipcRenderer.invoke('lawverify:case-directories-read',payload)});window.addEventListener('DOMContentLoaded',()=>{const check=()=>{for(const message of ['正在加载 LawVerify…','正在读取案件工作区…','正在启动 LawVerify…'])if(document.body.textContent.includes(message))ipcRenderer.send('redesign-qa-loading',message)};new MutationObserver(check).observe(document.body,{subtree:true,childList:true,characterData:true});check()})")

app.whenReady().then(async () => {
  try {
    const linkedDirectory = path.join(directory, 'linked-files')
    fs.mkdirSync(linkedDirectory)
    fs.writeFileSync(path.join(linkedDirectory, '测试材料.txt'), '双方于2026年11月15日约定货款100元。')
    require('./case-directories.cjs').registerCaseDirectories({ app, ipcMain, BrowserWindow,
      dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [linkedDirectory] }) } })
    const serverRoot = path.resolve(root, '../server/dist')
    const { env } = await import(pathToFileURL(path.join(serverRoot, 'config/env.js')).href)
    Object.assign(env, { WORKSPACE_DATA_DIR: path.join(directory, 'data'), APP_DATA_ROOT: directory,
      STORAGE_LOCAL_ROOT: 'storage', FRONTEND_DIST_DIR: path.join(root, 'dist'),
      AI_GATEWAY_MODE: 'direct', KNOWLEDGE_RAG_MODE: 'local', LLM_BASE_URL: undefined, LLM_API_KEY: undefined })
    const { readWorkspace, writeWorkspace, runWithWorkspaceAccount } = await import(pathToFileURL(path.join(serverRoot, 'store.js')).href)
    const account = 'redesign-qa@test.invalid'
    await runWithWorkspaceAccount(account, async () => {
      const workspace = await readWorkspace()
      workspace.cases = [{ id: 'qa-case', name: '王某诉李某民间借贷纠纷', description: '北京市朝阳区人民法院', status: 'draft', createdAt: '2026-11-15' }]
      workspace.evidences = [{ id: 'qa-evidence', caseId: 'qa-case', name: '招商银行流水', fileName: '流水.txt', number: '证据1', type: 'text', ocrText: '2023年3月15日转账500,000元。2023年4月11日收到35,000元利息。', uploadedAt: '2026-11-15' }]
      workspace.certificates = [{ id: 'qa-document', caseId: 'qa-case', title: '民事起诉状', role: 'plaintiff', focus: '', createdAt: '2026-11-15', paragraphIds: ['p1', 'p2', 'p3'], paragraphs: [
        { id: 'p1', text: '2023年3月15日，被告向原告借款500,000元。', richText: '<p>2023年3月15日，被告向原告借款<strong><u>500,000元</u></strong>。</p>', verified: false, links: [{ evidenceId: 'qa-evidence', locator: '第1段', quote: '2023年3月15日转账500,000元。', relation: 'support' }] },
        { id: 'p2', text: '被告于2023年4月1日支付利息30,000元。', richText: '<p>被告于2023年4月1日支付利息30,000元。</p>', verified: false, links: [{ evidenceId: 'qa-evidence', locator: '第2段', quote: '2023年4月11日收到35,000元利息。', relation: 'contradict' }] },
        { id: 'p3', text: '被告名下另有房产两套。', richText: '<p>被告名下另有房产两套。</p>', verified: false, links: [] },
      ] }]
      workspace.claimUnits = []; workspace.claimEvidenceMatches = []
      workspace.knowledgeCases = []; workspace.knowledgeStatutes = []
      workspace.user.name = '沈律师'
      await writeWorkspace(workspace)
    })
    const { createApp } = await import(pathToFileURL(path.join(serverRoot, 'app.js')).href)
    const backend = createApp().app
    const assistantMock = require('./redesign-assistant-mock.cjs').createAssistantMock({ readWorkspace, writeWorkspace, runWithWorkspaceAccount, account })
    const documentMock = require('./redesign-document-ai-mock.cjs').createDocumentMock({ readWorkspace, writeWorkspace, runWithWorkspaceAccount, account })
    server = http.createServer(async (request, response) => {
      if (await assistantMock(request, response) || await documentMock.handle(request, response)) return
      const pathname = new URL(request.url, 'http://localhost').pathname
      if (failedDeleteCase && request.method === 'DELETE' && pathname === '/api/cases/' + failedDeleteCase) {
        response.writeHead(503, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ error: { message: '测试删除失败' } }))
        return
      }
      if (authSampling && pathname === '/api/auth/cloud-session') response.once('finish', () => { sessionFinishedAt = performance.now() })
      if (authSampling && pathname === '/api/workspace') {
        workspaceReads++
        response.once('finish', () => { finishedReads++ })
        setTimeout(() => backend(request, response), 800)
      } else backend(request, response)
    }).listen(0, '127.0.0.1')
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
    const url = `http://127.0.0.1:${server.address().port}/?ui=new`
    env.corsOrigins = [new URL(url).origin]
    const index = await (await fetch(url)).text()
    const css = index.match(/href="([^\"]+\.css)"/)
    if (css) {
      const response = await fetch(new URL(css[1], url))
      if (!response.headers.get('content-type')?.includes('text/css')) throw new Error(`Static CSS response ${response.status}: ${await response.text()}; dist=${env.FRONTEND_DIST_DIR}`)
    }
    window = new BrowserWindow({ show: false, width: 1440, height: 960, webPreferences: { preload, backgroundThrottling: false, offscreen: true } })
    window.webContents.on('did-navigate', () => { navigations++ })
    window.webContents.on('paint', (_event, _dirty, image) => { latestImage = image })
    window.webContents.on('console-message', event => { if (failedDeleteCase && /status of 503/.test(event.message)) return; if (event.level === 'error' || event.level === 3 || /Uncaught|Invalid hook|validateDOMNesting/.test(event.message)) errors.push(event.message) })
    const evaluate = async code => { try { return await window.webContents.executeJavaScript(code) } catch (error) { throw new Error(`Renderer failed: ${code}`, { cause: error }) } }
    const wait = async expression => {
      const deadline = Date.now() + 20000
      while (Date.now() < deadline) {
        if (await evaluate(`Boolean(${expression})`)) return
        await new Promise(resolve => setTimeout(resolve, 75))
      }
      throw new Error(`Timeout: ${expression}`)
    }
    const clickText = (selector, label) => evaluate(`(() => {const button=Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(item=>item.textContent.trim()===${JSON.stringify(label)});if(!button)throw new Error('Missing button: '+${JSON.stringify(label)});button.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));button.click();button.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,button:0}))})()`)
    const fill = (selector, value) => evaluate(`(() => {const input=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(input.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}))})()`)
    const screenshot = async name => {
      window.webContents.invalidate()
      await new Promise(resolve => setTimeout(resolve, 500))
      assert.ok(latestImage && !latestImage.isEmpty(), '离屏页面没有生成图像')
      fs.writeFileSync(path.join(directory, name + '.png'), latestImage.toPNG())
    }
    const downloadWord = async (label, name) => {
      const destination = path.join(directory, name)
      const completed = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Download timeout: ${label}`)), 15000)
        window.webContents.session.once('will-download', (_event, item) => {
        item.setSavePath(destination)
        item.once('done', (_event, state) => { clearTimeout(timer); state === 'completed' ? resolve(destination) : reject(new Error(`Download ${state}`)) })
        })
      })
      await clickText('.topbar button', label)
      return completed
    }
    await window.loadURL(url)
    await wait("document.querySelector('.login-card input')")
    await window.webContents.insertCSS('* { animation:none!important; transition:none!important; }')
    await screenshot('login')
    await clickText('.login-card .primary-button', '进入系统')
    await wait("document.querySelector('.login-card .inline-error')")
    assert.match(await evaluate("document.querySelector('.inline-error').textContent"), /邮箱|账号/)
    await fill('.password-input-shell input', 'qa-visibility-only')
    await evaluate("document.querySelector('.password-visibility-button').click()")
    assert.equal(await evaluate("document.querySelector('.password-input-shell input').type"), 'text')
    await evaluate("document.querySelector('.password-visibility-button').click()")
    assert.equal(await evaluate("document.querySelector('.password-input-shell input').type"), 'password')
    await clickText('.login-mode-switch button', '注册')
    assert.equal(await evaluate("document.querySelectorAll('.login-card input').length"), 4)
    await screenshot('register')
    const authWindowSize = window.getSize()
    window.setSize(390, 900)
    await new Promise(resolve => setTimeout(resolve, 200))
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, '注册页窄屏不能横向溢出')
    await screenshot('register-390')
    await clickText('.login-mode-switch button', '登录')
    assert.equal(await evaluate("document.querySelectorAll('.login-card input').length"), 2)
    await screenshot('login-390')
    window.setSize(...authWindowSize)
    authSampling = true
    const navigationStart = navigations
    await fill('.login-card input', account)
    await fill('.password-input-shell input', 'qa-login-only')
    await clickText('.login-card .primary-button', '进入系统')
    await wait("document.querySelector('#pg-home .case-name')")
    const handoffMs = Math.round(performance.now() - sessionFinishedAt)
    const loginMetrics = { reloads: navigations - navigationStart, workspaceReads, homeAfterSessionMs: handoffMs, loadingMessages: [...loadingMessages] }
    console.log('Login startup metrics: '+JSON.stringify(loginMetrics))
    fs.writeFileSync(path.join(directory,'login-startup.json'),JSON.stringify(loginMetrics,null,2))
    assert.equal(cloudLogins,1)
    assert.equal(navigations,navigationStart,'登录后应原位切换首页，不刷新整页')
    assert.ok(handoffMs < 800,'登录接口返回的工作区应立即显示，不等待额外的慢工作区请求')
    assert.ok(workspaceReads <= 1,'不能为旧版和新版重复拉取工作区')
    assert.equal(loadingMessages.has('正在加载 LawVerify…'),false)
    assert.equal(loadingMessages.has('正在读取案件工作区…'),false)
    while (finishedReads < workspaceReads) await new Promise(resolve=>setTimeout(resolve,25))
    loadingMessages.clear()
    await evaluate('location.reload()')
    await wait("document.querySelector('.startup-screen')")
    await wait("document.querySelector('#pg-home .case-name')")
    assert.deepEqual([...loadingMessages], ['正在启动 LawVerify…'], '冷启动只显示统一的启动界面')
    console.log('Cold startup loading: '+JSON.stringify([...loadingMessages]))
    authSampling = false
    await evaluate('document.fonts.ready.then(() => true)')
    await window.webContents.insertCSS('* { animation:none!important; transition:none!important; }')
    assert.equal(await evaluate("document.querySelector('.case-name').textContent"), '王某诉李某民间借贷纠纷')
    const loadedChunks = () => evaluate("performance.getEntriesByType('resource').filter(entry=>entry.name.includes('/assets/')&&entry.name.endsWith('.js')).map(entry=>new URL(entry.name).pathname.split('/').pop())")
    const homeChunks = await loadedChunks()
    for (const name of ['Workspace', 'Library', 'Report', 'DirectoryLinksModal', 'UploadModal', 'FormModal', 'PreviewDrawer', 'export-word', 'LegacyEntry']) {
      assert.equal(homeChunks.some(chunk => chunk.startsWith(name + '-')), false, name + ' 应在使用时加载')
    }
    fs.writeFileSync(path.join(directory, 'home-chunks.json'), JSON.stringify(homeChunks, null, 2))
    await screenshot('home')
    const originalSize = window.getSize()
    for (const width of [820, 390]) {
      window.setSize(width, 900)
      await new Promise(resolve => setTimeout(resolve, 150))
      assert.equal(await evaluate("document.querySelector('#pg-home .home').scrollWidth <= document.querySelector('#pg-home .home').clientWidth"), true, `首页在 ${width}px 下不应横向溢出`)
      await screenshot(`home-${width}`)
    }
    await evaluate("document.querySelector('.home-guide summary').click()")
    assert.equal(await evaluate("document.querySelector('.home-guide').open"), true, '上手流程应能展开')
    await screenshot('home-guide')
    await evaluate("document.querySelector('.home-guide summary').click()")
    window.setSize(...originalSize)
    await evaluate("document.querySelector('.case-card').click()")
    await wait("document.querySelector('.doc-paper u')")
    assert.equal(await evaluate("Array.from(document.querySelectorAll('.add-mat')).some(button=>button.textContent.trim()==='本地文件夹联动')"), true, '材料入口应改为本地文件夹联动')
    assert.equal(await evaluate("Array.from(document.querySelectorAll('.topbar button')).some(button=>button.textContent.trim()==='编辑文书')"),false)
    await wait("document.querySelector('.pane-c .whole-document-content[contenteditable=true]')")
    assert.equal(await evaluate("document.querySelector('.doc-paper u').textContent"), '500,000元')
    await evaluate("document.querySelector('.mk').click()")
    await wait("document.querySelector('.rc-q')")
    assert.ok((await loadedChunks()).some(chunk => chunk.startsWith('Workspace-')), '工作台应能按需加载')
    await screenshot('workspace')
    await clickText('.ops button', '确认通过')
    await wait("document.querySelector('.ops .ok')")
    await clickText('.ops button', '批注')
    await wait("document.querySelector('.note-box textarea')")
    await fill('.note-box textarea', '已核对原件，数字 123 不触发快捷键。')
    await evaluate("document.querySelector('.note-box textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'2',bubbles:true}))")
    await clickText('.note-box button', '保存批注')
    await wait("!document.querySelector('.note-box')")
    await runWithWorkspaceAccount(account, async () => {
      const saved = await readWorkspace()
      const paragraph = saved.certificates[0].paragraphs[0]
      assert.equal(paragraph.verified, true)
      assert.equal(paragraph.note, '已核对原件，数字 123 不触发快捷键。')
      assert.match(paragraph.richText, /<u>/)
    })
    await evaluate("document.querySelector('.rc-loc').click()")
    await wait("document.querySelector('[data-slot=sheet-content]')")
    await screenshot('preview')
    await clickText('[data-slot=sheet-content] button', 'Close')
    await wait("!document.querySelector('[data-slot=sheet-content]')")
    await clickText('.topbar button', '导出 Word')
    await wait("document.querySelector('#pg-report .stats')")
    await screenshot('report')
    assert.equal((await loadedChunks()).some(chunk => chunk.startsWith('export-word-')), false, '打开报告时无需加载 Word 导出库')
    const reviewFile = await downloadWord('导出审阅版 Word', 'review.docx')
    const cleanFile = await downloadWord('清洁版 + 报告', 'clean.docx')
    assert.ok((await loadedChunks()).some(chunk => chunk.startsWith('export-word-')), '实际导出时加载 Word 导出库')
    const mammoth = require('mammoth')
    const reviewText = (await mammoth.extractRawText({ path: reviewFile })).value
    const cleanText = (await mammoth.extractRawText({ path: cleanFile })).value
    assert.match(reviewText, /500,000元/)
    assert.match(cleanText, /已核对原件，数字 123 不触发快捷键/)
    assert.match(cleanText, /段落核验记录/)
    assert.doesNotMatch(cleanText, /批注：/)
    await clickText('.topbar button', '← 返回工作台')
    await clickText('.topbar button', '首页')
    await wait("document.querySelector('#pg-home')")
    await clickText('.home-header button', '新建核验案件')
    await wait("document.querySelector('#field-name')")
    await fill('#field-name', '新版回归测试案件')
    await clickText('.fm-ft button', '保存')
    await wait("document.querySelector('.new-directory')")
    await screenshot('directory-link')
    const modalSize = window.getSize()
    window.setSize(390, 900)
    await new Promise(resolve => setTimeout(resolve, 150))
    assert.equal(await evaluate("document.querySelector('.new-directory').scrollWidth <= document.querySelector('.new-directory').clientWidth"), true, '目录弹窗窄屏不能横向溢出')
    await screenshot('directory-link-390')
    window.setSize(...modalSize)
    await clickText('.new-directory button', '链接目录')
    await wait("document.querySelector('[data-directory-files]')?.textContent.includes('1 个文件') && !document.querySelector('.new-directory button:disabled')")
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.directory-row')).display"), 'flex', '目录列表样式应在 Dialog Portal 中生效')
    await screenshot('directory-linked')
    await clickText('.new-directory button', '完成')
    await wait("document.querySelector('#pg-ws')")
    await clickText('.add-doc', '导入待核验文书')
    await wait("document.querySelector('.new-upload')")
    await screenshot('document-import')
    window.setSize(390, 900)
    await new Promise(resolve => setTimeout(resolve, 150))
    assert.equal(await evaluate("document.querySelector('.new-upload').scrollWidth <= document.querySelector('.new-upload').clientWidth"), true, '文书导入窄屏不能横向溢出')
    await screenshot('document-import-390')
    window.setSize(...modalSize)
    await evaluate(`(() => {
      const input=document.querySelector('input[aria-label="上传已撰写文书"]');const transfer=new DataTransfer();
      transfer.items.add(new File(['民事起诉状\\n\\n双方约定货款100元，被告未付款。'],'测试起诉状.txt',{type:'text/plain'}));input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));
    })()`)
    await clickText('.upload-actions button', '导入并核验')
    await wait("!document.querySelector('.new-upload') && (document.querySelector('#pg-proc') || document.querySelector('#pg-ws'))")
    if (await evaluate("Boolean(document.querySelector('#pg-proc'))")) {
      if (await evaluate("Array.from(document.querySelectorAll('.proc-actions button')).some(item => item.textContent === '取消核验')")) await clickText('.proc-actions button', '取消核验')
      await wait("Array.from(document.querySelectorAll('.proc-actions button')).some(item => item.textContent === '返回工作台' && !item.disabled)")
      await clickText('.proc-actions button', '返回工作台')
    }
    await wait("document.querySelector('#pg-ws')")
    await runWithWorkspaceAccount(account, async () => {
      const saved = await readWorkspace()
      const created = saved.cases.find(item => item.name === '新版回归测试案件')
      assert.ok(saved.evidences.some(item => item.caseId === created.id && item.fileName === '测试材料.txt'))
      assert.ok(saved.certificates.some(item => item.caseId === created.id && item.title === '测试起诉状'))
    })
    await require('./redesign-directory-checks.cjs')({ evaluate, wait, clickText, saved: fn => runWithWorkspaceAccount(account, async () => fn(await readWorkspace())), linkedDirectory, fs, path, setDeleteFailure: id => { failedDeleteCase = id } })
    await clickText('.topbar button', '首页')
    await evaluate("document.querySelector('.dock-ava').click()")
    await wait("document.querySelector('.acct-grid')")
    await require('./redesign-account-checks.cjs')({ evaluate, wait, clickText, fill, screenshot, setAccountStatus: status => { accountStatus = status } })
    await screenshot('account')
    await clickText('[role=tab]', '法条库')
    await screenshot('library')
    await clickText('.topbar button', '＋ 新增')
    await wait("document.querySelector('#field-art')")
    await fill('#field-name', '新版回归测试法条')
    await fill('#field-art', '第一条')
    await fill('#field-gist', '测试法条正文。')
    await clickText('.fm-ft button', '保存')
    await wait("!document.querySelector('.new-form') && document.body.textContent.includes('新版回归测试法条')")
    await runWithWorkspaceAccount(account, async () => assert.ok((await readWorkspace()).knowledgeStatutes.some(item => item.title === '新版回归测试法条')))
    await require('./redesign-library-checks.cjs')({evaluate,wait,clickText,fill,readWorkspace,writeWorkspace,runWithWorkspaceAccount,account})
    const saved = fn => runWithWorkspaceAccount(account, async () => fn(await readWorkspace()))
    const reload = async () => { await evaluate('location.reload()'); await wait("document.querySelector('#pg-home .case-name')") }
    const enter = async name => {
      if (!await evaluate("Boolean(document.querySelector('#pg-home'))")) await clickText('.topbar button', '首页')
      await wait("document.querySelector('#pg-home')")
      await evaluate(`Array.from(document.querySelectorAll('.case-card')).find(item=>item.textContent.includes(${JSON.stringify(name)})).click()`)
      await wait("document.querySelector('#pg-ws')")
    }
    await require('./redesign-document-ai-checks.cjs')({ evaluate, wait, clickText, fill, screenshot, saved, writeWorkspace, reload, enter, documentMock, billingLog, window, setBillingDelay: value => { billingDelay = value } })
    await require('./redesign-case-assistant-checks.cjs')({ evaluate, wait, clickText, fill, screenshot, saved, writeWorkspace, reload, enter })
    await require('./redesign-essential-checks.cjs')({ evaluate, wait, clickText, fill, screenshot, window,
      readWorkspace, writeWorkspace, runWithWorkspaceAccount, account, setAccountStatus: status => { accountStatus = status } })
    assert.deepEqual(errors.filter(message => !/favicon|404/.test(message)), [])
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ passed: true, directory, checks: ['真实工作区首页', 'AI流式起草改写及中断草稿', '客户端扣费与失败退款', '案件助手与代理确认', '积分邀请反馈', '富文本格式', '确认持久化', '批注持久化', '输入框快捷键隔离', '出处抽屉', '报告导航', '审阅版Word', '清洁版正文无批注且报告保留批注', '新建案件', '真实文件夹联动与独立文书导入', '核验启动及失败或取消后恢复', '账号与库导航', '新增法条持久化'] }, null, 2))
    process.stdout.write(`PASS redesign UI, screenshots: ${directory}\n`)
    window.destroy(); await new Promise(resolve => server.close(resolve)); app.exit(0)
  } catch (error) {
    process.stderr.write(`${error.stack}\n${errors.join('\n')}\n`)
    if (window) process.stderr.write(JSON.stringify(await window.webContents.executeJavaScript("({alert:document.querySelector('.new-error')?.textContent,footer:document.querySelector('.essential-editor-footer')?.textContent,inline:document.querySelector('.inline-actions')?.textContent})")) + '\n')
    if (latestImage) fs.writeFileSync(path.join(directory, 'failure.png'), latestImage.toPNG())
    window?.destroy(); server?.close(); app.exit(1)
  }
})

