const { app, BrowserWindow, ipcMain } = require('electron')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const http = require('node:http')

const root = path.resolve(__dirname, '..')
const c1 = require('../../server/eval/verification/fixtures/seed/documents.json').find(item => item.id === 'c1-qs')
const layoutOnly = process.env.LAWVERIFY_REDESIGN_LAYOUT_ONLY === '1'
const editorOnly = process.env.LAWVERIFY_REDESIGN_EDITOR_ONLY === '1'
const inlineOnly = process.env.LAWVERIFY_REDESIGN_INLINE_ONLY === '1'
const exportOnly = editorOnly || process.env.LAWVERIFY_REDESIGN_EXPORT_ONLY === '1'
const assistantOnly = process.env.LAWVERIFY_REDESIGN_ASSISTANT_ONLY === '1'
const evidenceTreeOnly = process.env.LAWVERIFY_REDESIGN_EVIDENCE_TREE_ONLY === '1'
const reviewTodosOnly = process.env.LAWVERIFY_REDESIGN_REVIEW_TODOS_ONLY === '1'
const caseDeleteOnly = process.env.LAWVERIFY_REDESIGN_CASE_DELETE_ONLY === '1'
const directory = path.join(root, 'tmp', `redesign-qa-${Date.now()}-${randomUUID().slice(0, 8)}`)
fs.mkdirSync(directory, { recursive: true })
app.setPath('userData', path.join(directory, 'electron-profile'))
app.disableHardwareAcceleration()
let server, window, latestImage
const errors = []
let failedDeleteCase = null
let accountStatus = 0
let cloudLogins = 0, authSampling = false, navigations = 0, workspaceReads = 0, finishedReads = 0, sessionFinishedAt = 0
let registeredName = ''
let billingDelay = 0
const verification = { calls: [], failNext: 0 }
const documentTest = { failSave: false, saveCalls: 0 }
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
  if (request.path === '/api/account/register') {
    registeredName = JSON.parse(request.body).ownerName
    return { status: 400, body: JSON.stringify({ error: { message: '测试注册反馈' } }) }
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
    const serverRoot = process.env.LAWVERIFY_REDESIGN_SERVER_DIST ?? path.resolve(root, '../server/dist')
    const { env } = await import(pathToFileURL(path.join(serverRoot, 'config/env.js')).href)
    Object.assign(env, { WORKSPACE_DATA_DIR: path.join(directory, 'data'), APP_DATA_ROOT: directory,
      STORAGE_LOCAL_ROOT: 'storage', FRONTEND_DIST_DIR: process.env.LAWVERIFY_REDESIGN_FRONTEND_DIST ?? path.join(root, 'dist'),
      AI_GATEWAY_MODE: 'direct', KNOWLEDGE_RAG_MODE: 'local', YUANDIAN_API_KEY: undefined, LLM_BASE_URL: undefined, LLM_API_KEY: undefined })
    if (process.env.LAWVERIFY_TEST_PYTHON) env.LAWVERIFY_PYTHON = process.env.LAWVERIFY_TEST_PYTHON
    const { readWorkspace, writeWorkspace, runWithWorkspaceAccount } = await import(pathToFileURL(path.join(serverRoot, 'store.js')).href)
    const { linkageMaterialFingerprint } = await import(pathToFileURL(path.join(serverRoot, 'intelligence/case-agent.js')).href)
    const account = 'redesign-qa@test.invalid'
    await runWithWorkspaceAccount(account, async () => {
      const workspace = await readWorkspace()
      workspace.cases = [{ id: 'qa-case', name: '王某诉李某民间借贷纠纷', description: '北京市朝阳区人民法院', status: 'draft', createdAt: '2026-11-15' }]
      workspace.evidences = [{ id: 'qa-evidence', caseId: 'qa-case', name: '招商银行流水', fileName: '流水.txt', number: '证据1', type: 'text', ocrText: '2023年3月15日转账500,000元。2023年4月11日收到35,000元利息。', uploadedAt: '2026-11-15' }]
      if (evidenceTreeOnly) {
        const directoryId = '2d7d9f21-7eb3-4587-b6e6-7c368239fc77'
        const folder = `民间借贷证据--${directoryId}`
        const files = [
          ['', '证据清单.txt'],
          ['01 借款合同/', '借款协议与补充约定.txt'],
          ['02 付款凭证/', '转账回单.txt'],
          ['02 付款凭证/银行流水/2023年/', '中国工商银行账户交易明细与付款记录汇总.txt'],
          ['03 沟通记录/', '关于借款金额及还款安排的聊天记录.txt'],
        ]
        workspace.evidences.push(...files.map(([parent, fileName], index) => ({
          ...workspace.evidences[0], id: `qa-tree-${index}`, name: fileName, fileName, directoryId,
          number: `证据${index + 2}`, relativePath: `${folder}/${parent}${fileName}`.replaceAll('/', index === 3 ? '\\' : '/'),
          parsing: { status: ['queued', 'processing', 'ready', 'review_required', 'failed'][index], revision: 'qa', sourceKey: 'qa', mode: 'auto', engineVersion: 'qa', updatedAt: '2026-11-15' },
        })))
      }
      workspace.certificates = [{ id: 'qa-document', caseId: 'qa-case', title: '民事起诉状', role: 'plaintiff', focus: '', createdAt: '2026-11-15', linkageInputKey: linkageMaterialFingerprint(workspace.evidences, workspace.evidenceInsights), paragraphIds: ['p1', 'p2', 'p3'], paragraphs: [
        { id: 'p1', text: c1.paragraphs[1], richText: `<p>${c1.paragraphs[1].replace('500,000元', '<strong><u>500,000元</u></strong>')}</p>`, verified: false, links: [{ evidenceId: 'qa-evidence', locator: '第1段', quote: '2023年3月15日转账500,000元。', relation: 'support' }] },
        { id: 'p2', text: c1.paragraphs[4], richText: `<p>${c1.paragraphs[4]}</p>`, verified: false, links: [{ evidenceId: 'qa-evidence', locator: '第2段', quote: '2023年4月11日收到35,000元利息。', relation: 'contradict' }],
          references: [{ type: 'case', targetId: 'qa-cited-case', sourceTitle: '借款类案回归样本', label: '借款类案', locator: '裁判要旨', quote: '借款交付应结合转账记录核对。' }] },
        { id: 'p3', text: '被告名下另有房产两套。', richText: '<p>被告名下另有房产两套。</p>', verified: false, links: [] },
      ] }]
      workspace.claimUnits = []; workspace.claimEvidenceMatches = []
      workspace.knowledgeCases = []; workspace.knowledgeStatutes = []
      {
        const certificate = workspace.certificates[0]
        const body = certificate.paragraphs[0].text
        certificate.verification = { version: 1, profileVersion: 'qa', inputKey: certificate.linkageInputKey, docKey: 'qs', classificationRequired: false, declarations: [{
          id: 'qa-fact', type: 'E-FACT', quote: body, location: { paragraphId: 'p1', paragraphIndex: 0, start: 0, end: body.length },
          verdict: 'pending', checks: { A1: { outcome: 'pass', reason: '夹具出处已定位' } }, reason: '待律师核对', conf: 74,
          confidenceCalibration: { version: 'cal-1234567890123456', basis: '原文可定位，检查无待定项', calibrationCases: 100,
            validationCases: 100, validationAgreementPercent: 75 },
          sources: [{ tier: 'l1', id: 'qa-evidence', name: '招商银行流水', locator: '第1段', quote: '2023年3月15日转账500,000元。' }],
        }] }
      }
      if (reviewTodosOnly) require('./redesign-todos-checks.cjs').seed(workspace)
      workspace.user.name = '沈律师'
      await writeWorkspace(workspace)
    })
    const { createApp } = await import(pathToFileURL(path.join(serverRoot, 'app.js')).href)
    const { sanitizeWorkspaceForClient } = await import(pathToFileURL(path.join(serverRoot, 'service.js')).href)
    const backend = createApp().app
    const assistantMock = require('./redesign-assistant-mock.cjs').createAssistantMock({ readWorkspace, writeWorkspace, runWithWorkspaceAccount, account })
    const documentMock = require('./redesign-document-ai-mock.cjs').createDocumentMock({ readWorkspace, writeWorkspace, runWithWorkspaceAccount, account })
    let mockDocumentGeneration = !exportOnly
    server = http.createServer(async (request, response) => {
      if (await assistantMock(request, response) || (mockDocumentGeneration && await documentMock.handle(request, response))) return
      const pathname = new URL(request.url, 'http://localhost').pathname
      if (request.method === 'POST' && pathname === '/qa-model/chat/completions') {
        const chunks = []
        for await (const chunk of request) chunks.push(chunk)
        const { messages } = JSON.parse(Buffer.concat(chunks))
        const input = messages.find(item => item.role === 'user' && item.content.trimStart().startsWith('{'))
        const payload = JSON.parse(input?.content ?? '{}')
        const paragraphs = (payload.paragraphs ?? []).map(({ paragraphId }) => ({
          paragraphId, sentenceFocus: [], evidenceLinks: [], statuteIntents: [], caseIntents: [],
        }))
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ paragraphs }) } }] }))
        return
      }
      if (documentTest.exportSnapshot && request.method === 'GET' && pathname === '/api/workspace' && request.headers['x-qa-export-snapshot'] === '1') {
        const state = await runWithWorkspaceAccount(account, readWorkspace)
        state.certificates = state.certificates.map(item => item.id === documentTest.exportSnapshot.id ? documentTest.exportSnapshot : item)
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ workspace: sanitizeWorkspaceForClient(state) }))
        return
      }
      if (documentTest.failSave && request.method === 'PUT' && /^\/api\/certificates\/[^/]+\/content$/.test(pathname)) {
        documentTest.saveCalls++
        response.writeHead(503, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ message: '测试文书保存失败' }))
        return
      }
      if (request.method === 'POST' && pathname === '/api/documents/import' && verification.importProbe) {
        verification.parseCalls = (verification.parseCalls ?? 0) + 1
        const call = verification.parseCalls
        await new Promise(resolve => setTimeout(resolve, verification.importDelay ?? 300))
        if (response.destroyed) return
        if (call === verification.parseFailAt) {
          for await (const _chunk of request) { /* 模拟服务端接收完文件后才报告解析失败。 */ }
          response.writeHead(422, { 'Content-Type': 'application/json' })
          response.end(JSON.stringify({ error: { message: '测试文书导入失败' } }))
        } else backend(request, response)
        return
      }
      if (request.method === 'POST' && /\/auto-link\/stream$/.test(pathname) && verification.enabled) {
        const id = pathname.split('/')[3]
        verification.calls.push(id)
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        if (verification.calls.length === verification.holdAt) {
          response.write('event: progress\ndata: {"text":"匹配证据"}\n\n')
          return
        }
        if (verification.calls.length === verification.failNext) {
          response.end('event: error\ndata: {"message":"测试核验失败"}\n\n')
        } else {
          for (const text of verification.progressTexts ?? []) {
            if (response.destroyed) return
            response.write('event: progress\ndata: ' + JSON.stringify({ text }) + '\n\n')
            await new Promise(resolve => setTimeout(resolve, 150))
          }
          const state = await runWithWorkspaceAccount(account, readWorkspace)
          response.end('event: done\ndata: ' + JSON.stringify({ linkage: { certificate: state.certificates.find(item => item.id === id), evidenceInsights: [], caseContextMemories: [] } }) + '\n\n')
        }
        return
      }
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
    const url = `http://127.0.0.1:${server.address().port}/?ui=legacy`
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
    const clickText = (selector, label) => evaluate(`(() => {const button=Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(item=>item.textContent.trim()===${JSON.stringify(label)}||item.getAttribute('aria-label')===${JSON.stringify(label)});if(!button)throw new Error('Missing button: '+${JSON.stringify(label)});button.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));button.click();button.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,button:0}))})()`)
    const selectDocumentText = (text = '') => evaluate(`(() => {
      const editor = document.querySelector('.whole-document-content');
      const paragraph = Array.from(editor.children).find(item => item.textContent.includes(${JSON.stringify(text)}));
      editor.focus();
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    })()`)
    const fill = (selector, value) => evaluate(`(() => {const input=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(input.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}))})()`)
    const screenshot = async name => {
      window.webContents.invalidate()
      await new Promise(resolve => setTimeout(resolve, 500))
      assert.ok(latestImage && !latestImage.isEmpty(), '离屏页面没有生成图像')
      fs.writeFileSync(path.join(directory, name + '.png'), latestImage.toPNG())
    }
    const downloadWord = async (label, name, selector = '#pg-report .report-actions button') => {
      const destination = path.join(directory, name)
      const completed = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Download timeout: ${label}`)), 15000)
        window.webContents.session.once('will-download', (_event, item) => {
        item.setSavePath(destination)
        item.once('done', (_event, state) => { clearTimeout(timer); state === 'completed' ? resolve(destination) : reject(new Error(`Download ${state}`)) })
        })
      })
      await clickText(selector, label)
      return completed
    }
    await window.loadURL(url)
    await wait("document.querySelector('.lv-card input')")
    await window.webContents.insertCSS('* { animation:none!important; transition:none!important; }')
    await screenshot('login')
    await evaluate("document.querySelector('.lv-card form').requestSubmit()")
    assert.equal(await evaluate("document.querySelector('.lv-card input[type=email]').validity.valueMissing"), true)
    assert.equal(cloudLogins, 0)
    await fill('#lv-password', 'qa-visibility-only')
    await clickText('.lv-secret button', '显示密码')
    assert.equal(await evaluate("document.querySelector('#lv-password').type"), 'text')
    await clickText('.lv-secret button', '隐藏密码')
    assert.equal(await evaluate("document.querySelector('#lv-password').type"), 'password')
    await clickText('.lv-register button', '注册账号')
    assert.equal(await evaluate("document.querySelectorAll('.lv-card input').length"), 5)
    assert.equal(await evaluate("document.querySelector('[name=ownerName]').labels[0].textContent.trim()"), '姓名或昵称')
    assert.equal(await evaluate("document.querySelector('[name=ownerName]').required"), true)
    await screenshot('register')
    const authWindowSize = window.getSize()
    window.setSize(390, 900)
    await new Promise(resolve => setTimeout(resolve, 200))
    assert.equal(await evaluate("document.querySelector('.lv-entry').scrollWidth <= document.querySelector('.lv-entry').clientWidth"), true, '注册页窄屏不能横向溢出')
    await screenshot('register-390')
    await fill('[name=organizationName]', '测试律所')
    await fill('[name=ownerName]', ' 小核桃 ')
    await fill('[name=email]', account)
    await fill('#lv-password', 'qa-register-only')
    await evaluate("document.querySelector('.lv-card form').requestSubmit()")
    await wait("document.querySelector('.lv-error')?.textContent.includes('测试注册反馈')")
    assert.equal(registeredName, '小核桃')
    await clickText('.lv-register button', '返回登录')
    assert.equal(await evaluate("document.querySelectorAll('.lv-card input').length"), 2)
    await screenshot('login-390')
    window.setSize(...authWindowSize)
    authSampling = true
    const navigationStart = navigations
    await fill('[name=email]', account)
    await fill('#lv-password', 'qa-login-only')
    await evaluate("document.querySelector('.lv-card form').requestSubmit()")
    await wait("document.querySelector('#pg-home .case-name')")
    assert.equal(await evaluate("Boolean(document.querySelector('.ide-shell, .legacy-entry'))"), false)
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
    await evaluate("location.search=''")
    await wait("document.querySelector('.startup-screen')")
    await wait("document.querySelector('#pg-home .case-name')")
    assert.deepEqual([...loadingMessages], ['正在启动 LawVerify…'], '冷启动只显示统一的启动界面')
    console.log('Cold startup loading: '+JSON.stringify([...loadingMessages]))
    authSampling = false
    await evaluate('document.fonts.ready.then(() => true)')
    const staticElements = evidenceTreeOnly ? '*:not(.material-parsing-status)' : '*'
    await window.webContents.insertCSS(`${staticElements} { animation:none!important; transition:none!important; }`)
    assert.equal(await evaluate("document.querySelector('.case-name').textContent"), '王某诉李某民间借贷纠纷')
    const saved = fn => runWithWorkspaceAccount(account, async () => fn(await readWorkspace()))
    const reload = async () => { await evaluate('location.reload()'); await wait("document.querySelector('#pg-home .case-name')") }
    const enter = async name => {
      if (!await evaluate("Boolean(document.querySelector('#pg-home'))")) await clickText('.topbar button', '首页')
      await wait("document.querySelector('#pg-home')")
      await evaluate(`Array.from(document.querySelectorAll('.case-card')).find(item => item.textContent.includes(${JSON.stringify(name)})).click()`)
      await wait("document.querySelector('#pg-ws')")
    }
    if (inlineOnly) {
      await enter('王某诉李某民间借贷纠纷')
      await clickText('.workspace-document-heading button', '在线编辑')
      await wait("document.querySelector('mark[data-inline-declaration]')")
      assert.equal(await evaluate("document.querySelector('.whole-document-content').contentEditable"), 'false')
      await evaluate("document.querySelector('mark[data-inline-declaration]').click()")
      await wait("document.activeElement.matches('mark.declaration-editor-mark[contenteditable]')")
      await evaluate(`(() => {
        const mark = document.activeElement;
        getSelection().collapse(mark.lastChild, mark.lastChild.length);
        document.execCommand('insertText', false, '已补充。');
      })()`)
      await wait("document.querySelector('.document-editor-status').textContent.includes('声明已保存 · 待重核')")
      const editedParagraph = await saved(state => state.certificates.find(doc => doc.id === 'qa-document').paragraphs[0])
      assert.equal(editedParagraph.text, c1.paragraphs[1] + '已补充。')
      assert.match(editedParagraph.richText, /<strong><u>500,000元<\/u><\/strong>/u)
      await evaluate(`(() => {
        const mark = document.querySelector('.declaration-editor-mark');
        mark.focus();
        getSelection().collapse(mark.lastChild, mark.lastChild.length);
        document.execCommand('insertText', false, '已复核。');
        document.querySelector('.workspace-edit-toggle').click();
      })()`)
      await wait("!document.querySelector('.declaration-editor-mark')")
      await wait("document.querySelector('.whole-document-content').textContent.includes('已补充。已复核。')")
      assert.equal(await saved(state => state.certificates.find(doc => doc.id === 'qa-document').paragraphs[0].text),
        c1.paragraphs[1] + '已补充。已复核。')
      process.stdout.write('PASS 声明级编辑自动保存、离开前提交和原排版保留\n')
      window.destroy(); await new Promise(resolve => server.close(resolve)); app.exit(0)
      return
    }
    if (reviewTodosOnly) {
      await enter('王某诉李某民间借贷纠纷')
      await require('./redesign-todos-checks.cjs').check({ evaluate, wait, clickText, screenshot, window })
      assert.deepEqual(errors.filter(message => !/favicon|404/.test(message)), [])
      process.stdout.write(`PASS review todos and screenshots: ${directory}\n`)
      window.destroy(); await new Promise(resolve => server.close(resolve)); app.exit(0)
      return
    }
    if (evidenceTreeOnly) {
      await enter('王某诉李某民间借贷纠纷')
      const folders = '.material-tree .material-group-toggle'
      const fileRows = '.material-tree .mat-it'
      assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('${folders} .material-folder-name'), item => item.textContent)`),
        ['案件原材料', '民间借贷证据', '01 借款合同', '02 付款凭证', '银行流水', '2023年', '03 沟通记录'])
      assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('${folders} .mat-bd.l1'), badge => [badge.previousElementSibling.textContent, badge.textContent])`),
        [['民间借贷证据', 'L1']])
      assert.equal(await evaluate("document.querySelector('.pane-l').getBoundingClientRect().width"), 232)
      assert.equal(await evaluate(`document.querySelectorAll('${fileRows}').length`), 6)
      assert.equal(await evaluate("document.querySelectorAll('.material-branch .material-branch .material-branch .material-branch .mat-it').length"), 1)
      assert.equal(await evaluate("document.querySelectorAll('.material-tree [data-status=review_required]').length"), 1)
      assert.equal(await evaluate("document.querySelectorAll('.material-tree [data-status=ready]').length"), 1)
      const animatedStatuses = `Array.from(document.querySelectorAll('.material-tree .material-parsing-status'))
        .filter(icon => getComputedStyle(icon).animationName !== 'none' && getComputedStyle(icon).animationIterationCount === 'infinite')
        .map(icon => icon.dataset.status)`
      const debuggerClient = window.webContents.debugger
      debuggerClient.attach()
      await debuggerClient.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })
      assert.deepEqual(await evaluate(animatedStatuses), ['processing'])
      await debuggerClient.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
      assert.deepEqual(await evaluate(animatedStatuses), [])
      debuggerClient.detach()
      await screenshot('evidence-tree')
      await evaluate("document.querySelector('.material-folder[title=\"02 付款凭证\"]').click()")
      assert.equal(await evaluate(`document.querySelectorAll('${fileRows}').length`), 4)
      await fill('.new-search-input', '付款记录汇总')
      assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('${folders} .material-folder-name'), item => item.textContent)`),
        ['民间借贷证据', '02 付款凭证', '银行流水', '2023年'])
      assert.equal(await evaluate(`document.querySelectorAll('${fileRows}').length`), 1)
      await screenshot('evidence-tree-search')
      await fill('.new-search-input', '02 付款凭证')
      assert.equal(await evaluate(`document.querySelectorAll('${fileRows}').length`), 2)
      await fill('.new-search-input', '')
      assert.equal(await evaluate(`document.querySelectorAll('${fileRows}').length`), 4)
      await clickText('.material-fold-controls button', '展开全部')
      await clickText('.material-fold-controls button', '收起全部')
      assert.equal(await evaluate(`document.querySelectorAll('${fileRows}').length`), 0)
      await clickText('.material-fold-controls button', '展开全部')
      assert.equal(await evaluate(`document.querySelectorAll('${fileRows}').length`), 6)
      await evaluate(`document.querySelector('${fileRows}').click()`)
      await wait("document.querySelector('.new-drawer')?.textContent.includes('招商银行流水')")
      await clickText('.new-drawer button', 'Close')
      await wait("!document.querySelector('.new-drawer')")
      window.setSize(1000, 900)
      await wait("document.querySelector('.pane-l').getBoundingClientRect().width === 194")
      window.setSize(390, 900)
      await wait("document.querySelector('.ws.no-l.no-r')")
      await clickText('.workspace-doc-strip button', '案件材料')
      await wait("getComputedStyle(document.querySelector('.pane-l')).visibility === 'visible'")
      assert.equal(await evaluate("document.querySelector('.pane-l').getBoundingClientRect().width"), 232)
      assert.equal(await evaluate("document.querySelector('.mat-scroll').scrollWidth <= document.querySelector('.mat-scroll').clientWidth"), true)
      await screenshot('evidence-tree-390')
      assert.deepEqual(errors.filter(message => !/favicon|404/.test(message)), [])
      process.stdout.write(`PASS evidence tree and screenshots: ${directory}\n`)
      window.destroy(); await new Promise(resolve => server.close(resolve)); app.exit(0)
      return
    }
    const runDocumentChecks = () => require('./redesign-document-ai-checks.cjs')({ evaluate, wait, clickText, selectDocumentText, fill,
      screenshot, saved, writeWorkspace, reload, enter, documentMock, billingLog, window, setBillingDelay: value => { billingDelay = value } })
    const runExportChecks = assistantReportOnly => require('./redesign-review-flow-checks.cjs').checkWordExport({
      evaluate, wait, clickText, downloadWord, screenshot, directory, documentTest, editorOnly, assistantReportOnly,
      session: window.webContents.session, account, linkageMaterialFingerprint, saved, writeWorkspace,
    })
    if (assistantOnly) {
      await runDocumentChecks()
      mockDocumentGeneration = false
      await reload()
      await runExportChecks(true)
      await require('./redesign-case-assistant-checks.cjs')({ evaluate, wait, clickText, fill, screenshot, saved, writeWorkspace, reload, enter })
      assert.deepEqual(errors.filter(message => !/favicon|404/.test(message)), [])
      process.stdout.write(`PASS T7 assistant workflow, screenshots and Word files: ${directory}\n`)
      window.destroy(); await new Promise(resolve => server.close(resolve)); app.exit(0)
      return
    }
    if (exportOnly) {
      await runExportChecks(false)
      assert.deepEqual(errors.filter(message => !/favicon|404/.test(message)), [])
      process.stdout.write(`PASS ${editorOnly ? 'Tiptap editing and local document export' : 'T1 R5/R9 desktop Word export'}, files: ${directory}\n`)
      window.destroy(); await new Promise(resolve => server.close(resolve)); app.exit(0)
      return
    }
    const loadedChunks = () => evaluate("performance.getEntriesByType('resource').filter(entry=>entry.name.includes('/assets/')&&entry.name.endsWith('.js')).map(entry=>new URL(entry.name).pathname.split('/').pop())")
    const homeChunks = await loadedChunks()
    assert.equal(homeChunks.some(chunk => chunk.startsWith('LegacyEntry-')), false, '应用不能加载旧版页面')
    for (const name of ['Workspace', 'Library', 'Report', 'DirectoryLinksModal', 'UploadModal', 'FormModal', 'PreviewDrawer', 'export-word']) {
      assert.equal(homeChunks.some(chunk => chunk.startsWith(name + '-')), false, name + ' 应在使用时加载')
    }
    fs.writeFileSync(path.join(directory, 'home-chunks.json'), JSON.stringify(homeChunks, null, 2))
    await screenshot('home')
    const originalSize = window.getSize()
    for (const width of [820, 390]) {
      window.setSize(width, 900)
      await new Promise(resolve => setTimeout(resolve, 150))
      assert.equal(await evaluate("document.querySelector('#pg-home .home').scrollWidth <= document.querySelector('#pg-home .home').clientWidth"), true, `首页在 ${width}px 下不应横向溢出`)
      assert.ok(await evaluate("document.querySelector('.home-header').getBoundingClientRect().top >= document.querySelector('.chrome').getBoundingClientRect().bottom"), '品牌区应位于标题栏下方')
      await screenshot(`home-${width}`)
    }
    assert.equal(await evaluate("document.querySelectorAll('.home-steps li').length"), 3, '首页展示三步上手流程')
    await evaluate("document.querySelector('.home-sample summary').click()")
    assert.equal(await evaluate("document.querySelector('.home-sample').open"), true)
    window.setSize(...originalSize)
    window.webContents.sendInputEvent({ type: 'mouseMove', x: 3, y: 3 })
    await new Promise(resolve => setTimeout(resolve, 200))
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.case-edit')).opacity"), '0')
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.case-delete')).opacity"), '0')
    await evaluate("document.querySelector('.case-card').focus()")
    await wait("getComputedStyle(document.querySelector('.case-edit')).opacity === '1'")
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.case-delete')).opacity"), '1')
    await evaluate("document.querySelector('.case-card').blur()")
    const casePoint = await evaluate(`(() => { const box = document.querySelector('.case-name').getBoundingClientRect();
      return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) } })()`)
    window.webContents.sendInputEvent({ type: 'mouseMove', ...casePoint })
    await wait("getComputedStyle(document.querySelector('.case-edit')).opacity === '1'")
    assert.equal(await evaluate("document.querySelector('.case-edit').nextElementSibling.matches('.case-delete') && getComputedStyle(document.querySelector('.case-delete')).opacity === '1'"), true)
    await clickText('.case-delete', '删除案件：王某诉李某民间借贷纠纷')
    await wait("document.querySelector('.new-form [data-slot=dialog-title]')?.textContent === '删除案件？'")
    await clickText('.fm-ft button', '取消')
    await wait("!document.querySelector('.new-form') && document.querySelector('.case-name')")
    if (caseDeleteOnly) {
      const identity = JSON.stringify({ account, caseId: 'qa-case' })
      const userId = await runWithWorkspaceAccount(account, async () => (await readWorkspace()).user.id)
      const noteKey = `lawverify-case-note:${userId}:qa-case`
      const localDraft = JSON.stringify(['lawverify-document', account, 'qa-document'])
      const otherDraft = JSON.stringify(['lawverify-document', account, 'other-document'])
      const draftKeys = async (seed = false) => evaluate(`new Promise((resolve, reject) => {
        const request = indexedDB.open('lawverify-drafts', 1)
        request.onupgradeneeded = () => request.result.createObjectStore('paragraphs', { keyPath: 'key' })
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const db = request.result
          const transaction = db.transaction('paragraphs', 'readwrite')
          const drafts = transaction.objectStore('paragraphs')
          if (${seed}) {
            drafts.put({ key: ${JSON.stringify(localDraft)}, revision: '1' })
            drafts.put({ key: ${JSON.stringify(otherDraft)}, revision: '1' })
          }
          const keys = drafts.getAllKeys()
          transaction.oncomplete = () => { db.close(); resolve(keys.result) }
          transaction.onerror = () => { db.close(); reject(transaction.error) }
        }
      })`)
      await evaluate(`localStorage.setItem(${JSON.stringify(noteKey)}, '案件本机笔记')`)
      assert.deepEqual((await draftKeys(true)).sort(), [localDraft, otherDraft].sort())
      await evaluate(`window.lawVerifyDesktop.linkCaseDirectory(${identity})`)
      const directories = () => evaluate(`window.lawVerifyDesktop.scanCaseDirectories(${identity})`)
      assert.equal((await directories()).length, 1)
      failedDeleteCase = 'qa-case'
      await clickText('.case-delete', '删除案件：王某诉李某民间借贷纠纷')
      await clickText('.fm-ft button', '确认删除')
      await wait("document.querySelector('.new-error')?.textContent.includes('测试删除失败')")
      assert.equal((await directories()).length, 1, '首次删除失败应保留目录链接')
      failedDeleteCase = null
      const storageKey = 'evidence/2026-11-15/deletion-retry.txt'
      const blockedFile = path.join(directory, 'storage', storageKey)
      fs.mkdirSync(blockedFile, { recursive: true })
      await runWithWorkspaceAccount(account, async () => {
        const state = await readWorkspace()
        state.evidences[0].storageKey = storageKey
        await writeWorkspace(state)
      })
      await clickText('.fm-ft button', '确认删除')
      await wait("document.querySelector('.new-error')?.textContent.includes('部分应用内文件清理失败')")
      await clickText('.fm-ft button', '关闭')
      await wait("!document.querySelector('.new-form') && document.querySelector('.home-case-empty')")
      fs.rmdirSync(blockedFile)
      fs.writeFileSync(blockedFile, '待清理材料')
      await window.loadURL(url)
      await wait("document.querySelector('.new-form [data-slot=dialog-title]')?.textContent === '案件文件待清理'")
      await clickText('.fm-ft button', '重试清理')
      await wait("!document.querySelector('.new-form') && document.querySelector('.home-case-empty')")
      assert.equal(fs.existsSync(blockedFile), false, '刷新后可继续回收原件')
      assert.equal((await directories()).length, 0, '删除成功后应解除目录链接')
      assert.deepEqual(await draftKeys(), [otherDraft], '应只清理该案件的本机草稿')
      assert.equal(await evaluate(`localStorage.getItem(${JSON.stringify(noteKey)})`), null)
      assert.equal(fs.readFileSync(path.join(linkedDirectory, '测试材料.txt'), 'utf8'), '双方于2026年11月15日约定货款100元。')
      await runWithWorkspaceAccount(account, async () => {
        const state = await readWorkspace()
        assert.equal(state.cases.some(item => item.id === 'qa-case'), false)
        assert.equal(state.certificates.some(item => item.caseId === 'qa-case'), false)
      })
      assert.deepEqual(errors.filter(message => !/favicon|404|status of 500/.test(message)), [])
      console.log('PASS home case delete, cancel, retry, and linked file preservation')
      window.destroy(); await new Promise(resolve => server.close(resolve)); app.exit(0)
      return
    }
    await screenshot('home-case-hover')
    await clickText('.case-edit', '编辑案件：王某诉李某民间借贷纠纷')
    await wait("document.querySelector('#field-plaintiff')")
    assert.equal(await evaluate("document.querySelector('.new-form [data-slot=dialog-title]').textContent.trim()"), '编辑案件信息')
    assert.equal(await evaluate("document.querySelector('#field-name').value"), '王某诉李某民间借贷纠纷')
    assert.equal(await evaluate("Boolean(document.querySelector('#pg-home'))"), true)
    await fill('#field-plaintiff', '王某')
    await fill('#field-defendant', '李某')
    await screenshot('edit-case')
    assert.equal(await evaluate("document.querySelector('#field-court').closest('details').open"), false)
    await evaluate("document.querySelector('#field-court').closest('details').querySelector('summary').click()")
    await fill('#field-court', '北京市朝阳区人民法院')
    await evaluate("document.querySelectorAll('[name=case-our-side]')[2].click()")
    await screenshot('edit-case-expanded')
    await clickText('.fm-ft button', '保存案件信息')
    await wait("!document.querySelector('.new-form')")
    await evaluate("document.querySelector('.case-card').click()")
    await wait("document.querySelector('.review-todos')")
    assert.equal(await evaluate("document.querySelector('.review-todos h2')?.textContent"), '核验待办')
    assert.equal(await evaluate("Array.from(document.querySelectorAll('.case-review-bar button')).some(button=>['材料','核验'].includes(button.textContent.trim()))"), false)
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.pane-l')).visibility === 'visible' && getComputedStyle(document.querySelector('.pane-r')).visibility === 'visible'"), true)
    assert.match(await evaluate("document.querySelector('.review-todo-card').textContent"), /30,000元/)
    assert.equal(await evaluate("document.querySelector('.review-todos-count strong').textContent"), '3')
    assert.equal(await evaluate("document.querySelector('.review-todo-card').dataset.verdict"), 'fail')
    await screenshot('workspace-todos')
    await wait("document.querySelector('.whole-document-content[contenteditable=false]')")
    await clickText('.workspace-document-heading button', '在线编辑')
    await wait("document.querySelector('mark[data-inline-declaration]')")
    await clickText('.workspace-document-heading button', '完成编辑')
    await clickText('.workspace-document-heading button', '整篇排版')
    await wait("document.querySelector('.whole-document-content[contenteditable=true]')")
    assert.equal(await evaluate("document.querySelector('.workspace-edit-toggle').getAttribute('aria-pressed')"), 'true')
    assert.equal(await evaluate("document.activeElement.classList.contains('whole-document-content')"), true)
    await screenshot('inline-editor')
    await clickText('.workspace-document-heading button', '完成编辑')
    await wait("document.querySelector('.workspace-edit-toggle').getAttribute('aria-pressed') === 'false'")
    await wait("document.querySelector('.whole-document-content[contenteditable=false]')")
    await clickText('.material-fold-controls button', '收起全部')
    assert.equal(await evaluate("document.querySelectorAll('.mat-it').length"), 0)
    await clickText('.material-fold-controls button', '展开全部')
    assert.match(await evaluate("document.querySelector('.mat-scroll').textContent"), /借款类案回归样本/)
    assert.match(await evaluate("document.querySelector('.mat-it .mat-nm').textContent"), /^证据1.*招商银行流水/)
    await fill('.new-search-input', '证据1')
    assert.match(await evaluate("document.querySelector('.mat-scroll').textContent"), /招商银行流水/)
    await fill('.new-search-input', '')
    window.setSize(390, 900)
    await wait("document.querySelector('.ws.no-l.no-r')")
    assert.equal(await evaluate("document.querySelector('.workspace-topbar').scrollWidth <= document.querySelector('.workspace-topbar').clientWidth"), true)
    await screenshot('workspace-390')
    await clickText('.workspace-doc-strip button', '案件材料')
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.pane-l')).visibility"), 'visible')
    await clickText('.workspace-doc-strip button', '核验结果')
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.pane-l')).visibility"), 'hidden')
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.pane-r')).visibility"), 'visible')
    await clickText('.workspace-doc-strip button', '核验结果')
    window.setSize(...originalSize)
    await wait("!document.querySelector('.ws.no-l.no-r')")
    await clickText('.topbar button', '案件记忆')
    await wait("document.querySelector('.case-memory-card')")
    assert.match(await evaluate("document.querySelector('.case-basic-fields').textContent"), /原告王某被告李某我方被告/)
    await clickText('.case-memory-actions button', '编辑案件信息')
    await wait("document.querySelector('#field-plaintiff')")
    assert.equal(await evaluate("document.querySelector('#field-plaintiff').value"), '王某')
    await clickText('.fm-ft button', '取消')
    await wait("!document.querySelector('.new-form')")
    assert.equal(await evaluate("document.querySelectorAll('.case-memory-tabs [role=tab]').length"), 6)
    await fill('.case-memory-card textarea', '测试律师笔记')
    await clickText('.case-memory-card button', '保存笔记')
    await screenshot('case-memory')
    assert.equal(await evaluate("document.querySelector('.case-memory-heading h1').textContent"), '王某诉李某民间借贷纠纷')
    await clickText('.topbar button', '返回工作台')
    await clickText('.topbar button', '案件记忆')
    await wait("document.querySelector('.case-memory-card textarea')?.value === '测试律师笔记'")
    if (layoutOnly) {
      await evaluate("document.querySelector('.case-memory-metrics button').click()")
      assert.equal(await evaluate("document.querySelector('.case-memory-evidence-table thead').textContent"), '文书声明卷内出处核验状态')
      await screenshot('case-memory-evidence')
      await clickText('.case-memory-card button', '招商银行流水 · 第1段')
      await wait("document.querySelector('[data-slot=sheet-content]')?.textContent.includes('招商银行流水')")
      await clickText('[data-slot=sheet-content] button', 'Close')
      await clickText('.case-memory-tabs [role=tab]', '金额台账')
      await wait("document.querySelector('.case-memory-tabs').textContent.includes('暂无可回查的复算结果')")
      await clickText('.case-memory-card button', '问 AI')
      await wait("document.querySelector('.workspace-ai-panel textarea')?.value.includes('复核本案关键金额')")
      await evaluate("document.querySelector('[aria-label=\"关闭 AI 助手\"]').click()")
      await clickText('.topbar button', '案件记忆')
    }
    await clickText('.topbar button', '返回工作台')
    if (layoutOnly) {
      await clickText('.workspace-doc-strip button', 'AI 助手')
      await wait("document.querySelector('.workspace-ai-panel .assistant-composer')")
      assert.equal(await evaluate("document.querySelectorAll('.workspace-ai-modes > button').length"), 4)
      assert.equal(await evaluate("document.querySelector('.workspace-ai-modes > button:nth-child(4)').textContent.trim()"), '更多技能')
      assert.equal(await evaluate("document.querySelector('.workspace-ai-composer-footer strong')"), null)
      assert.equal(await evaluate("document.querySelectorAll('.workspace-ai-panel textarea').length"), 1)
      assert.doesNotMatch(await evaluate("document.querySelector('.workspace-ai-panel').textContent"), /语音|Skills|默认模型|代理设置与案件记忆/)
      await evaluate("window.__assistantComposer = document.querySelector('.assistant-composer textarea')")
      await clickText('.workspace-ai-modes button', '查法条')
      assert.equal(await evaluate("window.__assistantComposer === document.querySelector('.assistant-composer textarea')"), true)
      assert.equal(await evaluate("document.querySelector('.workspace-ai-card[data-mode=law]').getAttribute('aria-pressed')"), 'true')
      await clickText('.workspace-ai-modes button', '查法条')
      assert.equal(await evaluate("document.querySelector('.workspace-ai-card[data-mode=law]').getAttribute('aria-pressed')"), 'false')
      await wait("!document.querySelector('.new-toast')")
      await screenshot('assistant-auto')
      await evaluate(`document.querySelector('.workspace-ai-more').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }))`)
      await wait("document.querySelector('.workspace-ai-menu[role=menu]')")
      assert.equal(await evaluate("document.querySelector('.workspace-ai-menu').dataset.side"), 'bottom')
      assert.equal(await evaluate("!!document.querySelector('.workspace-ai-menu [role=menuitemradio][aria-label=案例报告]')"), true)
      await screenshot('assistant-more')
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
      await wait("!document.querySelector('.workspace-ai-menu[role=menu]')")
      await clickText('.workspace-ai-header button', '加宽 AI 助手')
      assert.equal(await evaluate("getComputedStyle(document.querySelector('.pane-l')).visibility"), 'hidden')
      assert.equal(await evaluate("getComputedStyle(document.querySelector('.pane-r')).visibility"), 'visible')
      await screenshot('assistant-expanded')
      await clickText('.workspace-ai-header button', '还原 AI 助手')
      window.setSize(390, 900)
      await wait("document.querySelector('.ws.no-l.no-r')")
      assert.equal(await evaluate(`(() => { const panel = document.querySelector('.workspace-ai-panel');
        const send = panel.querySelector('[aria-label=发送]').getBoundingClientRect();
        return panel.scrollWidth <= panel.clientWidth && send.bottom <= innerHeight; })()`), true)
      await screenshot('assistant-390')
      window.setSize(...originalSize)
      await clickText('.workspace-ai-header button', '关闭 AI 助手')
      await wait("getComputedStyle(document.querySelector('.pane-l')).visibility === 'visible'")
    }
    assert.equal(await evaluate("Array.from(document.querySelectorAll('.add-mat')).some(button=>button.textContent.trim()==='本地文件夹联动')"), true, '材料入口应改为本地文件夹联动')
    assert.equal(await evaluate("Array.from(document.querySelectorAll('.topbar button')).some(button=>button.textContent.trim()==='编辑文书')"),false)
    const selectReviewedFixture = async () => {
      await wait("Array.from(document.querySelectorAll('.review-todo-card')).some(item=>item.textContent.includes('500,000元'))")
      await evaluate("Array.from(document.querySelectorAll('.review-todo-card')).find(item=>item.textContent.includes('500,000元')).click()")
      await wait("document.querySelector('.whole-document-content[contenteditable=false]')")
    }
    await selectReviewedFixture()
    await wait("document.querySelector('.rc-q')")
    assert.equal(await evaluate("document.querySelector('.rc .conf-num')?.textContent"), '74%')
    assert.equal(await evaluate(`(() => {
      const fill = document.querySelector('.rc .conf-track i');
      return fill?.style.width === '74%' && getComputedStyle(fill).backgroundColor !== 'rgba(0, 0, 0, 0)';
    })()`), true, '待律师核对的声明应同时显示置信度及可见填充条')
    await evaluate("document.querySelector('.rc .confidence-details summary').click()")
    assert.match(await evaluate("document.querySelector('.rc .confidence-details').textContent"), /验证集 100 案，验证一致率 75%/u)
    assert.ok((await loadedChunks()).some(chunk => chunk.startsWith('Workspace-')), '工作台应能按需加载')
    await screenshot('workspace')
    await wait("document.querySelector('.declaration-checks input')")
    await evaluate("document.querySelector('.declaration-checks input').click()")
    await clickText('.ops button', '确认声明')
    await wait("document.querySelector('.rc .user-tag')?.textContent === '声明已人工确认'")
    await clickText('.ops button', '批注')
    await wait("document.querySelector('.note-box textarea')")
    await fill('.note-box textarea', '已核对原件，数字 123 不触发快捷键。')
    await evaluate("document.querySelector('.note-box textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'2',bubbles:true}))")
    await clickText('.note-box button', '保存批注')
    await wait("!document.querySelector('.note-box')")
    await evaluate('location.reload()')
    await wait("document.querySelector('.case-card')")
    await evaluate("document.querySelector('.case-card').click()")
    await wait("document.querySelector('.review-todo-tabs')")
    await clickText('.review-todo-tabs button', '标注 1')
    await selectReviewedFixture()
    await wait("document.querySelector('.rc .user-tag')?.textContent === '声明已人工确认' && document.querySelector('.rc')?.textContent.includes('已核对原件，数字 123 不触发快捷键。')")
    await runWithWorkspaceAccount(account, async () => {
      const saved = await readWorkspace()
      const certificate = saved.certificates.find(item => item.id === 'qa-document')
      const declaration = certificate.verification.declarations.find(item => item.id === 'qa-fact')
      assert.equal(declaration.review.decision, 'confirmed')
      assert.equal(declaration.review.note, '已核对原件，数字 123 不触发快捷键。')
      assert.deepEqual(certificate.verification.audit.map(item => item.action), ['confirm', 'note'])
      assert.match(certificate.paragraphs[0].richText, /<u>/)
    })
    await evaluate("document.querySelector('.rc-loc').click()")
    await wait("document.querySelector('[data-slot=sheet-content]')")
    await screenshot('preview')
    await clickText('[data-slot=sheet-content] button', 'Close')
    await wait("!document.querySelector('[data-slot=sheet-content]')")
    await evaluate("document.querySelector('.workspace-report-button').click()")
    await wait("document.querySelector('#pg-report .stats')")
    await screenshot('report')
    assert.equal((await loadedChunks()).some(chunk => chunk.startsWith('export-word-')), false, '打开报告时无需加载 Word 导出库')
    assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('.report-actions button')).map(button=>button.disabled)"), [true, true, false])
    const caseFile = await downloadWord('导出案例检索报告', 'case-research.docx')
    await runWithWorkspaceAccount(account, async () => {
      const state = await readWorkspace()
      const original = state.certificates.find(item => item.id === 'qa-document')
      const [paragraph] = original.paragraphs
      const [declaration] = original.verification.declarations
      state.certificates.push({ ...original, id: 'qa-export-ready', title: '审阅完成回归文书', verification: undefined,
        paragraphIds: ['qa-reviewed'], paragraphs: [{ ...paragraph, id: 'qa-reviewed', verified: true, note: declaration.review.note }] })
      await writeWorkspace(state)
    })
    await evaluate('location.reload()')
    await wait("document.querySelector('.case-card')")
    await evaluate("document.querySelector('.case-card').click()")
    await wait("document.querySelector('.workspace-doc-strip [role=tab]')")
    await clickText('.workspace-doc-strip [role=tab]', '审阅完成回归文书核验项已处理')
    await wait("document.querySelector('.ctool h1')?.textContent === '审阅完成回归文书'")
    await evaluate("document.querySelector('.workspace-report-button').click()")
    await wait("document.querySelector('#pg-report .report-actions button:not(:disabled)')")
    const reviewFile = await downloadWord('导出审阅版 Word', 'review.docx')
    const cleanFile = await downloadWord('清洁版 + 报告', 'clean.docx')
    assert.ok((await loadedChunks()).some(chunk => chunk.startsWith('export-word-')), '实际导出时加载 Word 导出库')
    const mammoth = require('mammoth')
    const caseText = (await mammoth.extractRawText({ path: caseFile })).value
    const reviewText = (await mammoth.extractRawText({ path: reviewFile })).value
    const cleanText = (await mammoth.extractRawText({ path: cleanFile })).value
    assert.match(caseText, /借款类案回归样本/)
    assert.match(reviewText, /500,000元/)
    assert.match(cleanText, /已核对原件，数字 123 不触发快捷键/)
    assert.match(cleanText, /段落核验记录/)
    assert.doesNotMatch(cleanText, /批注：/)
    if (layoutOnly) {
      await clickText('.topbar button', '← 返回工作台')
      await wait("document.querySelector('.workspace-doc-strip')")
      await wait("document.querySelector('.whole-document-content[contenteditable=false]')")
      const selectedPrefix = '2023年3月15日'
      const selected = await evaluate(`(() => {
        const editor = document.querySelector('.whole-document-content');
        editor.focus();
        const firstText = document.createTreeWalker(editor.querySelector('p'), NodeFilter.SHOW_TEXT).nextNode();
        const range = document.createRange();
        range.setStart(firstText, 0);
        range.setEnd(firstText, ${selectedPrefix.length});
        getSelection().removeAllRanges();
        getSelection().addRange(range);
        return getSelection().toString();
      })()`)
      assert.equal(selected, selectedPrefix)
      await wait("document.querySelector('.document-selection-actions')")
      assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('.document-selection-actions button')).map(button => button.textContent.trim())"), ['问 AI', '改写', '查法条', '查类案'])
      await evaluate("document.querySelector('.whole-document-content p').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2,clientX:300,clientY:200}))")
      await wait("document.querySelector('.workspace-document-menu [role=menuitem]')")
      assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('.workspace-document-menu [role=menuitem]')).map(item => item.textContent.trim())"), ['引用选中内容问 AI', '改写', '查法条', '查类案', '局部重核', '进入编辑'])
      await evaluate("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))")
      await wait("!document.querySelector('.workspace-document-menu')")
      await selectDocumentText(selectedPrefix)
      await evaluate(`(() => { const selection = getSelection(); const firstText = document.createTreeWalker(document.querySelector('.whole-document-content p'), NodeFilter.SHOW_TEXT).nextNode(); selection.setBaseAndExtent(firstText, 0, firstText, ${selectedPrefix.length}) })()`)
      await wait("Array.from(document.querySelectorAll('.workspace-doc-strip button')).some(button => button.textContent.trim() === '问 AI')")
      await evaluate("window.dispatchEvent(new KeyboardEvent('keydown',{key:'j',ctrlKey:true,bubbles:true,cancelable:true}))")
      await wait(`document.querySelector('.workspace-ai-quote-text')?.textContent === ${JSON.stringify(selectedPrefix)}`)
      await evaluate("document.querySelector('.workspace-ai-more').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,pointerType:'mouse'}))")
      await wait("document.querySelector('.workspace-ai-menu [role=menuitemradio]')")
      await clickText('.workspace-ai-menu [role=menuitemradio]', '改写润色')
      await wait("document.querySelector('.workspace-ai-more b')?.textContent === '改写润色'")
      await fill('#workspace-ai-prompt', '调整叙述，不改变事实')
      const originalRequests = documentMock.requests.length
      await evaluate(`(() => {
        const input = document.querySelector('#workspace-ai-prompt');
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true }));
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, shiftKey: true }));
      })()`)
      assert.equal(documentMock.requests.length, originalRequests)
      const requestCandidate = async () => {
        await fill('#workspace-ai-prompt', '调整叙述，不改变事实')
        await wait("document.querySelector('.assistant-composer button[aria-label=发送]:not(:disabled)')")
        await clickText('.assistant-composer button', '发送')
        await wait("document.querySelector('.document-generated-preview')?.textContent.includes('经核对，')")
      }
      const savedExportDoc = () => runWithWorkspaceAccount(account, async () => (await readWorkspace()).certificates.find(item => item.id === 'qa-export-ready'))
      documentMock.setScenario('success')
      await requestCandidate()
      assert.deepEqual(documentMock.requests.at(-1).payload.selection, { paragraphId: 'qa-reviewed', start: 0, quote: selectedPrefix })
      assert.equal((await savedExportDoc()).paragraphs[0].text, c1.paragraphs[1])
      await clickText('.document-assistant-actions button', '放弃候选')
      assert.equal((await savedExportDoc()).paragraphs[0].text, c1.paragraphs[1])
      await requestCandidate()
      await clickText('.document-assistant-actions button', '采纳并替换选区')
      await wait("document.querySelector('.document-assistant [role=status]')?.textContent.includes('局部重核已执行')")
      const accepted = await savedExportDoc()
      assert.equal(accepted.paragraphs[0].text, '经核对，' + c1.paragraphs[1])
      assert.equal(accepted.paragraphs[0].aiOrigin, 'rewrite')
      assert.equal(accepted.paragraphs[0].verified, false)
      assert.equal(accepted.linkageStale, true)
      assert.match(accepted.paragraphs[0].richText, /<u>500,000元<\/u>/)
      assert.equal(accepted.verification.dirty, undefined)
      assert.deepEqual(accepted.verification.audit.map(item => item.action), ['adopt', 'verify'])
      assert.equal(accepted.verification.audit[0].quote, selectedPrefix)
      assert.equal(accepted.verification.audit[1].note, '局部重核')
      await screenshot('rewrite-rechecked')
      await evaluate("document.querySelector('[aria-label=\"移除引用\"]').click()")
      await wait("!document.querySelector('.workspace-ai-quote')")
      await wait("document.querySelectorAll('.workspace-ai-modes > button').length === 4")
      await clickText('.workspace-ai-modes button', '查法条')
      await wait("document.querySelector('.workspace-ai-card[data-mode=law][aria-pressed=true]')")
      await clickText('.workspace-ai-modes button', '查类案')
      await wait("document.querySelector('.workspace-ai-card[data-mode=similar][aria-pressed=true]')")
      await screenshot('assistant-modes')
      await clickText('.workspace-ai-modes button', '起草文书')
      await clickText('.assistant-composer button', '发送')
      await wait("/确认代理立场|填写并保存代理立场/.test(document.querySelector('.document-assistant [role=alert]')?.textContent ?? '')")
      await evaluate("Array.from(document.querySelectorAll('.workspace-doc-strip [role=tab]')).find(item=>item.textContent.includes('民事起诉状')).dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}))")
      await wait("document.querySelector('.ctool h1')?.textContent === '民事起诉状' && !document.querySelector('.workspace-ai-panel')")
      await runWithWorkspaceAccount(account, async () => {
        const state = await readWorkspace()
        state.cases.push({ id: 'qa-empty-case', name: '记忆隔离测试案件', description: '', status: 'draft', createdAt: '2026-11-15' })
        await writeWorkspace(state)
      })
      await evaluate('location.reload()')
      await wait("Array.from(document.querySelectorAll('.case-card')).some(item => item.textContent.includes('记忆隔离测试案件'))")
      await evaluate("Array.from(document.querySelectorAll('.case-card')).find(item=>item.textContent.includes('记忆隔离测试案件')).click()")
      await wait("document.querySelector('#pg-ws .case-btn')?.textContent.includes('记忆隔离测试案件')")
      await clickText('.topbar button', '案件记忆')
      await wait("document.querySelector('.case-memory-card textarea')?.value === ''")
      await clickText('.case-memory-tabs [role=tab]', '证据地图')
      await wait("document.querySelector('.case-memory-tabs').textContent.includes('暂无带可回查原文的当前核验结果')")
      await screenshot('case-memory-empty')
      await require('./redesign-memory-checks.cjs')({ evaluate, wait, clickText, screenshot, saved, writeWorkspace, reload, enter, linkageMaterialFingerprint })
    } else {
      await clickText('.topbar button', '← 返回工作台')
      await require('./redesign-review-flow-checks.cjs')({ evaluate, wait, clickText, screenshot, verification, selectReviewedFixture,
        saved: fn => runWithWorkspaceAccount(account, async () => fn(await readWorkspace())),
        reload: async () => { await evaluate('location.reload()'); await wait("document.querySelector('#pg-home .case-name')") },
        enter: async name => {
          await evaluate(`Array.from(document.querySelectorAll('.case-card')).find(item => item.textContent.includes(${JSON.stringify(name)})).click()`)
          await wait("document.querySelector('#pg-ws')")
        },
      })
    }
    await clickText('.topbar button', '首页')
    await wait("document.querySelector('#pg-home')")
    await clickText('.home-intro-actions button', '新建案件')
    await wait("document.querySelector('#field-name')")
    await screenshot('new-case')
    await fill('#field-name', '新版回归测试案件')
    await clickText('.fm-ft button', '下一步：添加文件')
    await wait("document.querySelector('.case-files-material') && document.querySelector('.case-files-document input[type=file]')")
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.case-files-grid')).gridTemplateColumns.split(' ').length"), 2)
    await screenshot('document-import')
    const modalSize = window.getSize()
    window.setSize(390, 900)
    await new Promise(resolve => setTimeout(resolve, 150))
    assert.equal(await evaluate("document.querySelector('.new-upload').scrollWidth <= document.querySelector('.new-upload').clientWidth"), true, '导入弹窗窄屏不能横向溢出')
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.case-files-grid')).gridTemplateColumns.split(' ').length"), 1)
    await screenshot('document-import-390')
    window.setSize(...modalSize)
    await clickText('.case-files-material button', '链接目录')
    await wait("document.querySelector('[data-directory-files]')?.textContent.includes('1 个文件') && !document.querySelector('.new-upload')?.getAttribute('aria-busy')?.includes('true')")
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.directory-row')).display"), 'flex', '目录列表样式应在 Dialog Portal 中生效')
    await screenshot('directory-linked')
    await evaluate(`(() => {
      const input=document.querySelector('input[aria-label="上传已撰写文书"]');const transfer=new DataTransfer();
      transfer.items.add(new File(['民事起诉状\\n\\n双方约定货款100元，被告未付款。'],'测试起诉状.txt',{type:'text/plain'}));input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));
    })()`)
    await evaluate("document.querySelector('[aria-label=\"测试起诉状.txt的文书类型\"]').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,pointerType:'mouse'}))")
    await wait("document.querySelector('[role=option]')")
    await clickText('[role=option]', '起诉状')
    await screenshot('document-import-ready')
    await clickText('.upload-actions button', '导入并核验')
    await wait("document.querySelector('#pg-proc .proc-t')?.textContent.includes('《测试起诉状》')")
    await wait("document.querySelector('#pg-proc .ppct')?.textContent.includes('核验未完成') && document.querySelector('.new-error')?.textContent.includes('LLM API Key')")
    const importedId = await saved(state => state.certificates.find(item => item.title === '测试起诉状').id)
    assert.equal(await saved(state => state.certificates.find(item => item.id === importedId).verification), undefined)
    await clickText('.new-error button', '关闭')
    const materialReady = () => saved(state => {
      const { caseId } = state.certificates.find(item => item.id === importedId)
      const evidence = state.evidences.find(item => item.caseId === caseId && item.fileName === '测试材料.txt')
      const task = state.cases.find(item => item.id === caseId).agent?.task?.status
      return evidence?.parsing?.status === 'ready' && !['queued', 'processing'].includes(task)
    })
    const materialDeadline = Date.now() + 25000
    let ready = await materialReady()
    while (!ready && Date.now() < materialDeadline) {
      await new Promise(resolve => setTimeout(resolve, 150))
      ready = await materialReady()
    }
    assert.ok(ready, '重试全文核验前，链接目录中的测试材料应完成解析')
    const previousModel = env.LLM_MODEL
    Object.assign(env, { LLM_BASE_URL: new URL('/qa-model', url).href, LLM_API_KEY: randomUUID(), LLM_MODEL: 'qa-model' })
    try {
      await clickText('.proc-actions button', '重试')
      await wait("document.querySelectorAll('#pg-proc .pst.done').length === 6 && !document.querySelector('.proc-actions button')?.disabled")
    } finally {
      Object.assign(env, { LLM_BASE_URL: undefined, LLM_API_KEY: undefined, LLM_MODEL: previousModel })
    }
    await screenshot('homepage-import-verification-complete')
    await clickText('.proc-actions button', '查看核验结果')
    await wait("document.querySelector('#pg-ws .ctool h1')?.textContent === '测试起诉状'")
    assert.equal(await evaluate("document.querySelector('[aria-label=\"当前文书类型\"]').textContent"), '起诉状')
    await runWithWorkspaceAccount(account, async () => {
      const saved = await readWorkspace()
      const created = saved.cases.find(item => item.name === '新版回归测试案件')
      assert.ok(saved.evidences.some(item => item.caseId === created.id && item.fileName === '测试材料.txt'))
      const imported = saved.certificates.find(item => item.caseId === created.id && item.title === '测试起诉状')
      assert.equal(imported.id, importedId)
      assert.equal(imported.docKey, 'qs')
      assert.equal(imported.verification.docKey, 'qs')
      assert.ok(imported.verification.revision && imported.verification.declarations.length > 0)
    })
    console.log('PASS homepage import, explicit document classification and local verification snapshot')
    if (layoutOnly) {
      await clickText('.topbar button', '首页')
      await clickText('.home-intro-actions button', '新建案件')
      await wait("document.querySelector('#field-name')")
      await fill('#field-name', '新建起草案件')
      await evaluate("document.querySelector('input[name=case-task][value=draft]').click()")
      await clickText('.fm-ft button', '下一步：添加文件')
      await wait("document.querySelector('.case-files-material')")
      assert.equal(await evaluate("document.querySelector('.case-files-document')"), null)
      await screenshot('draft-upload')
      await clickText('.upload-actions button', '进入起草')
      await wait("document.querySelector('.workspace-ai-panel .workspace-ai-card[data-mode=document][aria-pressed=true]')")
      assert.deepEqual(errors.filter(message => !/favicon|404/.test(message)), [])
      process.stdout.write(`PASS v1.2 layout, case setup, file import and Word exports, screenshots: ${directory}\n`)
      window.destroy(); await new Promise(resolve => server.close(resolve)); app.exit(0)
      return
    }
    await require('./redesign-directory-checks.cjs')({ evaluate, wait, clickText, saved: fn => runWithWorkspaceAccount(account, async () => fn(await readWorkspace())), linkedDirectory, fs, path, setDeleteFailure: id => { failedDeleteCase = id } })
    await clickText('.topbar button', '首页')
    await wait("document.querySelector('#pg-home') && document.querySelector('.dock .dock-ava')")
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
    await runDocumentChecks()
    await require('./redesign-case-assistant-checks.cjs')({ evaluate, wait, clickText, fill, screenshot, saved, writeWorkspace, reload, enter })
    await require('./redesign-essential-checks.cjs')({ evaluate, wait, clickText, fill, screenshot, window,
      readWorkspace, writeWorkspace, runWithWorkspaceAccount, account, linkageMaterialFingerprint, setAccountStatus: status => { accountStatus = status } })
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

