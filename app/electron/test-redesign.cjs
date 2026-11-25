const { app, BrowserWindow, ipcMain } = require('electron')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const http = require('node:http')
const { bodyParagraphs, editorReady, selectDocxRange } = require('./redesign-docx-input-checks.cjs')
const { sendHighlightClick } = require('./redesign-highlight-checks.cjs')

const root = path.resolve(__dirname, '..')
const c1 = require('../../server/eval/verification/fixtures/seed/documents.json').find(item => item.id === 'c1-qs')
const layoutOnly = process.env.LAWVERIFY_REDESIGN_LAYOUT_ONLY === '1'
const editorOnly = process.env.LAWVERIFY_REDESIGN_EDITOR_ONLY === '1'
const inlineOnly = process.env.LAWVERIFY_REDESIGN_INLINE_ONLY === '1'
const exportOnly = editorOnly || process.env.LAWVERIFY_REDESIGN_EXPORT_ONLY === '1'
const assistantOnly = process.env.LAWVERIFY_REDESIGN_ASSISTANT_ONLY === '1'
const accountOnly = process.env.LAWVERIFY_REDESIGN_ACCOUNT_ONLY === '1'
const evidenceTreeOnly = process.env.LAWVERIFY_REDESIGN_EVIDENCE_TREE_ONLY === '1'
const evidencePreviewOnly = process.env.LAWVERIFY_REDESIGN_EVIDENCE_PREVIEW_ONLY === '1'
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
const qaProfile = { user: { email: 'redesign-qa@test.invalid', name: '测试律师' }, organization: { id: 'qa', name: '测试', membershipId: 'qa', role: 'owner' } }
const qaPhoneEmail = '4836b46b-7797-48ec-a5fa-3f9e82a289fd@phone.lawverify.invalid'
const qaPhoneProfile = { ...qaProfile, user: { email: qaPhoneEmail, name: '手机用户', maskedPhone: '138****8000' } }
const revokedAccountTokens = new Set()
let cloudLogins = 0, authSampling = false, navigations = 0, workspaceReads = 0, finishedReads = 0, sessionFinishedAt = 0
let registeredName = ''
const phoneAuthRequests = []
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
  if (request.path === '/api/account/login') {
    cloudLogins++
    await new Promise(resolve => setTimeout(resolve, 150))
    return { status: 200, body: JSON.stringify({ success: true, data: { ...qaProfile, token: 'qa-mocked-login-token' } }) }
  }
  if (request.path === '/api/account/register') {
    registeredName = JSON.parse(request.body).ownerName
    return { status: 400, body: JSON.stringify({ error: { message: '测试注册反馈' } }) }
  }
  if (request.path === '/api/account/sms/send' || request.path.startsWith('/api/account/phone/')) {
    const body = JSON.parse(request.body)
    phoneAuthRequests.push({ path: request.path, body })
    if (request.path === '/api/account/sms/send') return { status: 200, body: JSON.stringify({ success: true,
      data: { challengeId: randomUUID(), retryAfterSeconds: 60, expiresInSeconds: 300 } }) }
    if (request.path === '/api/account/phone/login' && body.code === '654321') return { status: 200, body: JSON.stringify({
      success: true, data: { ...qaPhoneProfile, token: 'qa-mocked-phone-token' },
    }) }
    return { status: 400, body: JSON.stringify({ error: { message: '测试手机号认证反馈' } }) }
  }
  if (accountStatus === 0) {
    const success = data => ({ status: 200, body: JSON.stringify({ success: true, data }) })
    const authorization = request.headers?.authorization
    if (revokedAccountTokens.has(authorization)) return { status: 401,
      body: JSON.stringify({ success: false, error: { code: 'INVALID_SESSION', message: '登录状态已失效。' } }) }
    if (request.path === '/api/account/profile') {
      if (authorization === 'Bearer qa-mocked-phone-token') return success(qaPhoneProfile)
      if (request.method === 'PUT') {
        const { displayName, organizationName } = JSON.parse(request.body)
        if (displayName !== undefined) qaProfile.user.name = displayName
        if (organizationName !== undefined) qaProfile.organization.name = organizationName
      }
      return success(qaProfile)
    }
    if (request.path === '/api/account/password' && request.method === 'PUT') {
      if (authorization) revokedAccountTokens.add(authorization)
      return success({ token: randomUUID() })
    }
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
    : { success: true, data: request.path.includes('logout') ? { ok: true } : qaProfile }) }
})
const preload = path.join(directory, 'qa-account-preload.cjs')
fs.writeFileSync(preload, `const {contextBridge,ipcRenderer,webUtils}=require('electron');
const directories = Object.fromEntries(Object.entries({ linkCaseDirectory:'link', pickCaseDirectory:'pick', attachCaseDirectory:'attach',
  scanCaseDirectories:'scan', clearCaseDirectories:'clear', readCaseDirectoryFile:'read',
}).map(([method, action]) => [method, payload => ipcRenderer.invoke('lawverify:case-directories-' + action, payload)]));
contextBridge.exposeInMainWorld('lawVerifyDesktop',{requestAccount:request=>ipcRenderer.invoke('redesign-qa-account',request),
  stageDroppedCaseMaterials:(account,files,retainIds)=>ipcRenderer.invoke('lawverify:case-directories-stage-drop',{account,paths:files.map(file=>webUtils.getPathForFile(file)),retainIds}),
  openExternal:url=>ipcRenderer.invoke('redesign-qa-external',url), ...directories});
window.addEventListener('DOMContentLoaded',()=>{const check=()=>{for(const message of ['正在加载 LawVerify…','正在读取案件工作区…','正在启动 LawVerify…'])if(document.body.textContent.includes(message))ipcRenderer.send('redesign-qa-loading',message)};new MutationObserver(check).observe(document.body,{subtree:true,childList:true,characterData:true});check()})`)

app.whenReady().then(async () => {
  try {
    const linkedDirectory = path.join(directory, 'linked-files')
    fs.mkdirSync(linkedDirectory)
    fs.writeFileSync(path.join(linkedDirectory, '测试材料.txt'), '双方于2026年11月15日约定货款100元。')
    let onDirectoryPickerOpened
    require('./case-directories.cjs').registerCaseDirectories({ app, ipcMain, BrowserWindow,
      dialog: { showOpenDialog: async () => {
        if (!onDirectoryPickerOpened) return { canceled: false, filePaths: [linkedDirectory] }
        const notify = onDirectoryPickerOpened
        onDirectoryPickerOpened = undefined
        return new Promise(resolve => notify(resolve))
      } },
    })
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
      if (evidenceTreeOnly || evidencePreviewOnly) {
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
      if (evidencePreviewOnly) {
        workspace.certificates.push({
          id: 'qa-second-document', caseId: 'qa-case', title: '代理意见', role: 'plaintiff', focus: '',
          createdAt: '2026-11-15', paragraphIds: ['p4'], paragraphs: [
            { id: 'p4', text: '付款记录可用于核对借款交付。', verified: false,
              link: { evidenceId: 'qa-evidence', locator: '第1段', quote: '2023年3月15日转账500,000元。' } },
          ],
        })
      }
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
      if (documentTest.failSave && request.method === 'PUT' && /^\/api\/(?:certificates\/[^/]+\/content|documents\/[^/]+\/edit-source)$/.test(pathname)) {
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
          const certificate = state.certificates.find(item => item.id === id)
          if (certificate && verification.skippedMaterials) {
            certificate.verification = { ...certificate.verification, skippedMaterials: verification.skippedMaterials }
          }
          response.end('event: done\ndata: ' + JSON.stringify({ linkage: { certificate, evidenceInsights: [], caseContextMemories: [] } }) + '\n\n')
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
    window.webContents.on('console-message', event => {
      if (failedDeleteCase && /status of 503/.test(event.message)) return
      // Chromium 会将可在下一帧继续交付的尺寸观察通知记为控制台错误。
      if (event.message === 'ResizeObserver loop completed with undelivered notifications.') return
      if (event.level === 'error' || event.level === 3 || /Uncaught|Invalid hook|validateDOMNesting/.test(event.message)) errors.push(event.message)
    })
    const evaluate = async code => { try { return await window.webContents.executeJavaScript(code) } catch (error) { throw new Error(`Renderer failed: ${code}`, { cause: error }) } }
    const dropFiles = async (selector, files) => {
      const point = await evaluate(`(() => {const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
        return {x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2)};})()`)
      const debuggerClient = window.webContents.debugger
      debuggerClient.attach()
      try {
        const data = { items: [], files, dragOperationsMask: 1 }
        for (const type of ['dragEnter', 'dragOver', 'drop']) await debuggerClient.sendCommand('Input.dispatchDragEvent', { type, ...point, data })
      } finally { debuggerClient.detach() }
    }
    const wait = async expression => {
      const deadline = Date.now() + 20000
      while (Date.now() < deadline) {
        if (await evaluate(`Boolean(${expression})`)) return
        await new Promise(resolve => setTimeout(resolve, 75))
      }
      throw new Error(`Timeout: ${expression}`)
    }
    const clickText = (selector, label) => evaluate(`(() => {const button=Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(item=>item.textContent.trim()===${JSON.stringify(label)}||item.getAttribute('aria-label')===${JSON.stringify(label)});if(!button)throw new Error('Missing button: '+${JSON.stringify(label)});if(button.getAttribute('aria-haspopup')==='menu'){button.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,pointerType:'mouse'}));return}button.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));button.click();button.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,button:0}))})()`)
    const selectDocumentText = async (text = '') => {
      const paragraph = `${bodyParagraphs}.find(item => item.textContent.includes(${JSON.stringify(text)}))`
      await wait(paragraph)
      const start = await evaluate(`(${paragraph}).textContent.indexOf(${JSON.stringify(text)})`)
      await selectDocxRange({ evaluate, wait, window }, paragraph, paragraph, start, text ? start + text.length : null)
    }
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
    const checkPhoneForm = async purpose => {
      assert.equal(await evaluate("document.getElementById('lv-verification-code')?.labels[0].textContent"), '验证码')
      assert.equal(await evaluate("document.querySelector('#lv-password')"), null)
      assert.equal(await evaluate("document.querySelector('.lv-code button').disabled && document.querySelector('.lv-submit').disabled"), true)
      const phone = purpose === 'login' ? '13800138000' : '13900139000'
      await fill('[name=phone]', phone)
      await clickText('.lv-code button', '发送验证码')
      await wait("document.querySelector('.lv-code button').disabled && !document.querySelector('.lv-submit').disabled")
      assert.deepEqual(phoneAuthRequests.at(-1), { path: '/api/account/sms/send', body: { phone, purpose } })
      if (purpose === 'register') {
        await fill('[name=organizationName]', '测试律所')
        await fill('[name=ownerName]', '测试用户')
      }
      await fill('[name=verificationCode]', '123456')
      await evaluate("document.querySelector('.lv-card form').requestSubmit()")
      await wait("document.querySelector('.lv-error')?.textContent.includes('测试手机号认证反馈')")
      const submitted = phoneAuthRequests.at(-1)
      assert.equal(submitted.path, `/api/account/phone/${purpose}`)
      assert.equal(submitted.body.phone, phone)
      assert.equal(submitted.body.code, '123456')
      assert.match(submitted.body.challengeId, /^[\da-f-]{36}$/)
      assert.equal('email' in submitted.body || 'password' in submitted.body, false)
      assert.equal(cloudLogins, 0)
      assert.equal(registeredName, '')
    }
    await clickText('.lv-methods button', '手机号登录')
    await checkPhoneForm('login')
    await fill('[name=verificationCode]', '654321')
    await evaluate("document.querySelector('.lv-card form').requestSubmit()")
    await wait("document.querySelector('#pg-home')")
    assert.equal(await evaluate("sessionStorage.getItem('lawverify-login-account')"), qaPhoneEmail)
    assert.equal(await evaluate("localStorage.getItem('lawverify-cloud-token')"), 'qa-mocked-phone-token')
    await evaluate("sessionStorage.clear(); localStorage.removeItem('lawverify-cloud-token'); location.reload()")
    await wait("document.querySelector('.lv-card input[type=email]')")
    await clickText('.lv-methods button', '邮箱登录')
    await clickText('.lv-register button', '注册账号')
    assert.equal(await evaluate("document.querySelectorAll('.lv-card input').length"), 5)
    assert.equal(await evaluate("document.querySelector('[name=ownerName]').labels[0].textContent.trim()"), '姓名或昵称')
    assert.equal(await evaluate("document.querySelector('[name=ownerName]').required"), true)
    await clickText('.lv-methods button', '手机号注册')
    await checkPhoneForm('register')
    await clickText('.lv-methods button', '邮箱注册')
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
      if (!await evaluate("Boolean(document.querySelector('#pg-home'))")) await clickText('.topbar button.brand-home', 'LawVerify 首页')
      await wait("document.querySelector('#pg-home')")
      await evaluate(`Array.from(document.querySelectorAll('.case-card')).find(item => item.textContent.includes(${JSON.stringify(name)})).click()`)
      await wait("document.querySelector('#pg-ws')")
    }
    if (inlineOnly) {
      await enter('王某诉李某民间借贷纠纷')
      const highlighted = "document.querySelector('.whole-document-content .lawverify-review[data-superdoc-ext-el]')"
      await wait(highlighted)
      await wait("document.querySelector('.document-editor-status').textContent.includes('正文已同步')")
      await wait(editorReady)
      const readSpacing = `(() => {
        const canvas = document.querySelector('.document-editor-canvas').getBoundingClientRect();
        const line = (${highlighted})?.getClientRects()[0];
        return line && { top: Math.round(line.top - canvas.top), left: Math.round(line.left - canvas.left) };
      })()`
      await wait(`((spacing) => spacing && spacing.top >= 0 && spacing.top <= 64 && spacing.left >= 0 && spacing.left <= 72)(${readSpacing})`)
      console.log('PASS 正文首行屏幕留白', await evaluate(readSpacing))
      await screenshot('inline-compact')
      assert.equal(await evaluate("Array.from(document.querySelectorAll('.workspace-document-heading button')).some(button => ['在线编辑', '整篇排版', '完成编辑'].includes(button.textContent.trim()))"), false)
      const clickHighlight = () => sendHighlightClick({ evaluate, wait, window }, highlighted)
      const size = window.getSize()
      window.setSize(390, 900)
      await wait("document.querySelector('.workspace-pane-controls')")
      await clickHighlight()
      await wait("document.activeElement.closest('.whole-document-content') && document.querySelector('.review-detail-bar')")
      assert.equal(await evaluate("getComputedStyle(document.querySelector('#workspace-review')).visibility"), 'visible', '窄窗口点击高亮后应显示对应核验详情')
      window.setSize(...size)
      await wait("!document.querySelector('.workspace-pane-controls')")
      await clickHighlight()
      await wait("document.activeElement.closest('.whole-document-content') && document.querySelector('.review-detail-bar')")
      const original = c1.paragraphs[1]
      await window.webContents.insertText('已补充')
      await wait("document.querySelector('.document-editor-status').textContent.includes('修改已保存在本机草稿')")
      await clickText('.document-editor-tools button', '保存文书')
      await wait("document.querySelector('.document-editor-status').textContent.includes('整篇文书已保存')")
      const editedParagraph = await saved(state => state.certificates.find(doc => doc.id === 'qa-document').paragraphs[0])
      const offset = editedParagraph.text.indexOf('已补充')
      assert.ok(offset > 0 && offset < original.indexOf('500,000元'), '鼠标应在被高亮的文字中放置光标')
      assert.equal(editedParagraph.text, original.slice(0, offset) + '已补充' + original.slice(offset))
      assert.match(editedParagraph.richText, /<strong><u>500,000元<\/u><\/strong>/u)
      assert.ok(await saved(state => state.certificates.find(doc => doc.id === 'qa-document').verification.dirty?.paragraphIds.includes('p1')))
      process.stdout.write('PASS 点击正文直接编辑、草稿和正文保存、核验更新和原排版保留\n')
      window.destroy(); await new Promise(resolve => server.close(resolve)); app.exit(0)
      return
    }
    if (reviewTodosOnly) {
      await enter('王某诉李某民间借贷纠纷')
      await require('./redesign-todos-checks.cjs').check({ evaluate, wait, clickText, fill, screenshot, window, saved })
      assert.deepEqual(errors.filter(message => !/favicon|404/.test(message)), [])
      process.stdout.write(`PASS review todos and screenshots: ${directory}\n`)
      window.destroy(); await new Promise(resolve => server.close(resolve)); app.exit(0)
      return
    }
    if (evidencePreviewOnly) {
      await enter('王某诉李某民间借贷纠纷')
      await evaluate("document.querySelector('[data-evidence-id=qa-evidence]').click()")
      await wait("document.querySelector('.new-drawer')?.textContent.includes('招商银行流水')")
      const drawerSections = "Array.from(document.querySelectorAll('.new-drawer h2'), heading => heading.textContent)"
      assert.deepEqual(await evaluate(drawerSections), ['原件预览', '引用文书与段落'])
      assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('.evidence-references h3'), heading => heading.textContent)"), ['民事起诉状', '代理意见'])
      assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('.evidence-references li strong'), label => label.textContent)"), ['第 1 段', '第 2 段', '第 1 段'])
      assert.match(await evaluate("document.querySelector('.evidence-references').textContent"), /付款记录可用于核对借款交付。/u)
      assert.equal(await evaluate("document.querySelector('.new-drawer .evidence-manage, .new-drawer .ocr')"), null)
      const debuggerClient = window.webContents.debugger
      debuggerClient.attach()
      await debuggerClient.sendCommand('Emulation.setDeviceMetricsOverride', { width: 390, height: 560, deviceScaleFactor: 1, mobile: false })
      await wait("innerWidth === 390 && innerHeight === 560")
      assert.equal(await evaluate("document.querySelector('.new-drawer .dwb').scrollWidth <= document.querySelector('.new-drawer .dwb').clientWidth"), true)
      await evaluate("document.querySelector('.evidence-references').scrollIntoView()")
      await wait("document.querySelector('.evidence-references h2').getBoundingClientRect().top < innerHeight")
      await screenshot('evidence-preview-390')
      await clickText('.new-drawer button', 'Close')
      await wait("!document.querySelector('.new-drawer')")
      await evaluate("document.querySelector('[data-evidence-id=qa-tree-0]').click()")
      await wait("document.querySelector('.new-drawer')?.textContent.includes('暂无文书引用此材料')")
      assert.deepEqual(await evaluate(drawerSections), ['原件预览', '引用文书与段落'])
      debuggerClient.detach()
      process.stdout.write(`PASS evidence preview order, document references and narrow layout: ${directory}\n`)
      window.destroy(); await new Promise(resolve => server.close(resolve)); app.exit(0)
      return
    }
    if (evidenceTreeOnly) {
      await enter('王某诉李某民间借贷纠纷')
      const categories = '.material-categories .material-group-toggle'
      const fileRows = '.material-categories .mat-it'
      assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('${categories}'), item => item.textContent)`),
        ['合同协议1', '资金往来3', '沟通记录1', '身份主体0', '前审文书0', '其他1'])
      const debuggerClient = window.webContents.debugger
      debuggerClient.attach()
      const evidencePoint = id => evaluate(`(() => {
        const rect = document.querySelector('[data-evidence-id="${id}"]').getBoundingClientRect()
        return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) }
      })()`)
      await debuggerClient.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...await evidencePoint('qa-tree-2') })
      await wait("document.querySelector('[data-evidence-id=qa-tree-2]').matches(':hover')")
      const evidenceTip = "document.querySelector('[data-slot=tooltip-content]')"
      assert.match(await evaluate(`${evidenceTip}?.textContent ?? ''`), /转账回单\.txt/u)
      assert.doesNotMatch(await evaluate(`${evidenceTip}.textContent`), /Alt/u)
      assert.equal(await evaluate(`${evidenceTip}.querySelector('hr')?.nextElementSibling?.textContent`), '拖到标题分类可调整归类')
      await wait(`${evidenceTip}.getBoundingClientRect().left >= document.querySelector('.material-categories').getBoundingClientRect().right`)
      const shortTipWidth = await evaluate(`${evidenceTip}.offsetWidth`)
      await evaluate("document.querySelector('[data-evidence-id=qa-tree-3]').focus()")
      await wait(`${evidenceTip}?.firstElementChild?.textContent.includes('付款记录汇总')`)
      const longTip = await evaluate(`(() => {
        const tooltip = ${evidenceTip}
        const title = document.createRange()
        title.selectNodeContents(tooltip.firstElementChild)
        return { width: tooltip.offsetWidth, lines: title.getClientRects().length }
      })()`)
      assert.equal(longTip.lines, 1, '文件名在空间充足时应完整显示在一行')
      assert.ok(longTip.width > shortTipWidth, '提示框应随文件名变长而加宽')
      assert.equal(await evaluate(`getComputedStyle(${evidenceTip}.querySelector('hr').nextElementSibling).textAlign`), 'center')
      const adjacentEvidence = await evidencePoint('qa-evidence')
      await debuggerClient.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...adjacentEvidence, button: 'left', clickCount: 1 })
      await debuggerClient.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', ...adjacentEvidence, button: 'left', clickCount: 1 })
      await wait("document.querySelector('.new-drawer')?.textContent.includes('招商银行流水')")
      await clickText('.new-drawer button', 'Close')
      await wait("!document.querySelector('.new-drawer')")
      assert.ok(await evaluate("document.querySelector('.pane-l').getBoundingClientRect().width < document.querySelector('.pane-r').getBoundingClientRect().width"))
      assert.equal(await evaluate(`document.querySelectorAll('${fileRows}').length`), 6)
      assert.equal(await evaluate("document.querySelectorAll('.material-categories ul ul').length"), 0)
      assert.equal(await evaluate("document.querySelectorAll('.material-categories [data-status=review_required]').length"), 1)
      assert.equal(await evaluate("document.querySelectorAll('.material-categories [data-status=ready]').length"), 1)
      const animatedStatuses = `Array.from(document.querySelectorAll('.material-categories .material-parsing-status'))
        .filter(icon => getComputedStyle(icon).animationName !== 'none' && getComputedStyle(icon).animationIterationCount === 'infinite')
        .map(icon => icon.dataset.status)`
      await debuggerClient.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })
      assert.deepEqual(await evaluate(animatedStatuses), ['processing'])
      await debuggerClient.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
      assert.deepEqual(await evaluate(animatedStatuses), [])
      debuggerClient.detach()
      await screenshot('evidence-categories')
      await clickText(categories, '资金往来3')
      assert.equal(await evaluate(`document.querySelectorAll('${fileRows}').length`), 3)
      await fill('.new-search-input', '付款记录汇总')
      assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('${categories}'), item => item.textContent)`), ['资金往来1'])
      assert.equal(await evaluate(`document.querySelectorAll('${fileRows}').length`), 1)
      await screenshot('evidence-categories-search')
      await fill('.new-search-input', '02 付款凭证')
      assert.equal(await evaluate(`document.querySelectorAll('${fileRows}').length`), 2)
      await fill('.new-search-input', '')
      assert.equal(await evaluate(`document.querySelectorAll('${fileRows}').length`), 3)
      await clickText('.material-fold-controls button', '展开全部')
      await clickText('.material-fold-controls button', '收起全部')
      assert.equal(await evaluate(`document.querySelectorAll('${fileRows}').length`), 0)
      await clickText('.material-fold-controls button', '展开全部')
      assert.equal(await evaluate(`document.querySelectorAll('${fileRows}').length`), 6)
      assert.equal(await evaluate("document.querySelectorAll('.material-actions button').length"), 1)
      await clickText('.material-actions button', '导入材料或文书')
      await wait("document.querySelector('.new-upload')")
      const transfer = path.join(directory, '转账明细.txt')
      const supplement = path.join(directory, '补充说明.txt')
      fs.writeFileSync(transfer, '已收款100元。')
      fs.writeFileSync(supplement, '其他证据正文。')
      await dropFiles('.new-upload .case-files-material .case-file-drop', [transfer, supplement])
      await evaluate(`(() => {
        const input = document.querySelector('input[aria-label="上传已撰写文书"]')
        const files = new DataTransfer()
        files.items.add(new File(['原告张某。'], '民事答辩状.txt'))
        input.files = files.files
        input.dispatchEvent(new Event('change', { bubbles: true }))
      })()`)
      await wait("document.querySelectorAll('.new-upload .case-files-material .chip').length === 2 && document.querySelector('.upload-actions button:not(:disabled)')")
      assert.equal(await evaluate("document.querySelector('.new-upload select, .new-upload [role=combobox]')"), null)
      await screenshot('import-materials-or-documents')
      verification.enabled = true
      await clickText('.upload-actions button', '导入并核验')
      await wait("document.querySelector('#pg-proc .ppct')?.textContent.includes('核验完成')")
      await clickText('.proc-actions button', '查看核验结果')
      await wait("!document.querySelector('.new-upload') && document.querySelector('.material-categories')?.textContent.includes('转账明细.txt')")
      await saved(state => {
        assert.ok(state.evidences.some(item => item.caseId === 'qa-case' && item.fileName === '转账明细.txt' && item.storageKey))
        assert.ok(state.evidences.some(item => item.caseId === 'qa-case' && item.fileName === '补充说明.txt'))
        assert.ok(!state.evidences.some(item => item.fileName === '民事答辩状.txt'))
        assert.deepEqual(state.certificates.filter(item => item.caseId === 'qa-case').map(item => item.title).sort(), ['民事答辩状', '民事起诉状'].sort())
      })
      const identityGroup = '.material-categories [data-category="身份主体"]'
      const transferEvidence = `Array.from(document.querySelectorAll('${fileRows}')).find(row => row.textContent.includes('转账明细.txt'))`
      assert.equal(await evaluate(`document.querySelector('${identityGroup} .material-group-toggle')?.textContent`), '身份主体0')
      await evaluate("document.querySelector('.material-empty-toggle[aria-expanded=true]')?.click()")
      assert.equal(await evaluate(`document.querySelector('${identityGroup}').hidden`), true, '空分类可折叠')
      assert.equal(await evaluate(`${transferEvidence}.draggable`), true)
      await evaluate(`(() => {
        const row = ${transferEvidence}
        window.__materialDrag = new DataTransfer()
        row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: window.__materialDrag }))
      })()`)
      await evaluate(`(() => {
        const group = document.querySelector('${identityGroup}')
        group.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: window.__materialDrag }))
      })()`)
      await wait(`document.querySelector('${identityGroup}[data-drop-target]')`)
      assert.equal(await evaluate(`document.querySelector('${identityGroup}').hidden`), false, '拖拽材料时仍可使用空分类')
      await screenshot('evidence-drag-category')
      await evaluate(`document.querySelector('${identityGroup}').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: window.__materialDrag }))`)
      await wait(`document.querySelector('${identityGroup} .material-file')?.textContent.includes('转账明细.txt')`)
      await reload()
      await enter('王某诉李某民间借贷纠纷')
      await wait(`document.querySelector('${identityGroup} .material-file')?.textContent.includes('转账明细.txt')`)
      await evaluate(`${transferEvidence}.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true, cancelable: true }))`)
      await wait("document.activeElement.closest('[data-category]')?.dataset.category === '前审文书'")
      await evaluate("document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true, cancelable: true }))")
      await wait("document.activeElement.closest('[data-category]')?.dataset.category === '身份主体'")
      window.setSize(1000, 900)
      await wait("innerWidth <= 1000 && document.querySelector('.pane-l').getBoundingClientRect().width < document.querySelector('.pane-r').getBoundingClientRect().width")
      window.setSize(390, 900)
      await wait("document.querySelector('.ws.no-l.no-r')")
      await clickText('.workspace-doc-strip button', '案件材料')
      await wait("getComputedStyle(document.querySelector('.pane-l')).visibility === 'visible'")
      assert.equal(await evaluate("document.querySelector('.pane-l').getBoundingClientRect().width"), 232)
      assert.equal(await evaluate("document.querySelector('.mat-scroll').scrollWidth <= document.querySelector('.mat-scroll').clientWidth"), true)
      await screenshot('evidence-categories-390')
      await clickText('.material-actions button', '导入材料或文书')
      await wait("document.querySelector('.new-upload .case-files-material .case-file-drop')")
      assert.equal(await evaluate("document.querySelector('.new-upload').textContent.includes('管理本地材料链接')"), false)
      await clickText('.new-upload [data-slot=dialog-close]', 'Close')
      assert.deepEqual(errors.filter(message => !/favicon|404/.test(message)), [])
      process.stdout.write(`PASS evidence categories, mixed import, directory linking and screenshots: ${directory}\n`)
      window.destroy(); await new Promise(resolve => server.close(resolve)); app.exit(0)
      return
    }
    const runDocumentChecks = () => require('./redesign-document-ai-checks.cjs')({ evaluate, wait, clickText, selectDocumentText, fill,
      screenshot, saved, writeWorkspace, reload, enter, documentMock, billingLog, window, setBillingDelay: value => { billingDelay = value } })
    const runExportChecks = assistantReportOnly => require('./redesign-review-flow-checks.cjs').checkWordExport({
      evaluate, wait, clickText, downloadWord, screenshot, directory, documentTest, editorOnly, assistantReportOnly,
      session: window.webContents.session, account, linkageMaterialFingerprint, saved, writeWorkspace, window,
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
      if (editorOnly) await require('./redesign-essential-checks.cjs')({
        evaluate, wait, clickText, fill, screenshot, window, readWorkspace, writeWorkspace,
        runWithWorkspaceAccount, account, linkageMaterialFingerprint, editorOnly,
      })
      assert.deepEqual(errors.filter(message => !/favicon|404/.test(message)), [])
      process.stdout.write(`PASS ${editorOnly ? 'SuperDoc editing and local document export' : 'T1 R5/R9 desktop Word export'}, files: ${directory}\n`)
      window.destroy(); await new Promise(resolve => server.close(resolve)); app.exit(0)
      return
    }
    const runAccountChecks = () => require('./redesign-account-checks.cjs')({
      evaluate, wait, clickText, fill, screenshot, window, setAccountStatus: status => { accountStatus = status },
    })
    if (accountOnly) {
      await runAccountChecks()
      await evaluate("document.querySelector('.dock-ava').click()")
      await wait("document.querySelector('#pg-account')")
      await clickText('#pg-account .topbar button', '退出登录')
      await clickText('.fm-ft button', '确认退出')
      await wait("document.querySelector('.lv-card') && !sessionStorage.getItem('lawverify-auth-session') && !localStorage.getItem('lawverify-cloud-token')")
      assert.deepEqual(errors.filter(message => !/favicon|404/.test(message)), [])
      process.stdout.write(`PASS account settings and services, screenshots: ${directory}\n`)
      window.destroy(); await new Promise(resolve => server.close(resolve)); app.exit(0)
      return
    }
    const loadedChunks = () => evaluate("performance.getEntriesByType('resource').filter(entry=>entry.name.includes('/assets/')&&entry.name.endsWith('.js')).map(entry=>new URL(entry.name).pathname.split('/').pop())")
    const homeChunks = await loadedChunks()
    assert.equal(homeChunks.some(chunk => chunk.startsWith('LegacyEntry-')), false, '应用不能加载旧版页面')
    for (const name of ['Library', 'Report', 'UploadModal', 'FormModal', 'PreviewDrawer', 'export-word']) {
      assert.equal(homeChunks.some(chunk => chunk.startsWith(name + '-')), false, name + ' 应在使用时加载')
    }
    await wait("performance.getEntriesByType('resource').some(entry => new URL(entry.name).pathname.split('/').pop().startsWith('Workspace-'))")
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
      const categoryKey = `lawverify-evidence-categories:${JSON.stringify([account, 'qa-case'])}`
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
      await evaluate(`localStorage.setItem(${JSON.stringify(categoryKey)}, '{"qa-evidence":"身份主体"}')`)
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
      assert.equal(await evaluate(`localStorage.getItem(${JSON.stringify(categoryKey)})`), null)
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
    assert.equal(await evaluate("document.querySelector('#workspace-review .case-review-bar')"), null)
    assert.equal(await evaluate("Array.from(document.querySelectorAll('#workspace-review button')).some(button=>['审阅清单','标记案件完成'].includes(button.textContent.trim()))"), false)
    assert.equal(await evaluate("Array.from(document.querySelectorAll('.review-todos button')).some(button=>button.textContent.trim()==='人工审阅')"), false)
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.pane-l')).visibility === 'visible' && getComputedStyle(document.querySelector('.pane-r')).visibility === 'visible'"), true)
    assert.equal(await evaluate(`(() => {
      const widths = Array.from(document.querySelector('.ws').children, pane => pane.getBoundingClientRect().width);
      return widths[0] < widths[2] && widths[2] < widths[1];
    })()`), true, '桌面正文为主栏，准备核验时右栏宽于材料栏')
    const tabBarHeightDifference = () => evaluate(`document.querySelector('.workspace-doc-strip').getBoundingClientRect().height
      - document.querySelector('[data-workspace-review-tab]').getBoundingClientRect().height`)
    assert.equal(await tabBarHeightDifference(), 0, '桌面文书切换区与右栏页签区应等高')
    assert.match(await evaluate("document.querySelector('.review-todo-card').textContent"), /30,000元/)
    assert.equal(await evaluate("document.querySelector('.review-todos-count strong').textContent"), '3')
    assert.equal(await evaluate("document.querySelector('.review-todo-card').dataset.verdict"), 'fail')
    await screenshot('workspace-todos')
    await wait("document.querySelector('.whole-document-content[data-editable=true] .superdoc-page')")
    await screenshot('inline-editor')
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
    assert.equal(await evaluate("document.querySelector('#workspace-review .case-review-bar')"), null)
    assert.equal(await tabBarHeightDifference(), 0, '窄窗文书切换区与右栏页签区应等高')
    if (layoutOnly) console.log('PASS matching workspace tab bar heights at desktop and narrow widths')
    await clickText('.workspace-doc-strip button', '核验结果')
    window.setSize(...originalSize)
    await wait("!document.querySelector('.ws.no-l.no-r')")
    await wait("['CaseMemory-', 'WorkspaceAssistant-'].every(prefix => performance.getEntriesByType('resource').some(entry => new URL(entry.name).pathname.split('/').pop().startsWith(prefix)))")
    const workspaceIdentity = await evaluate("document.querySelector('.workspace-case-identity')?.textContent")
    assert.equal(workspaceIdentity, '原告：王某 ｜ 被告（我方）：李某 ｜ 北京市朝阳区人民法院')
    await clickText('.topbar button', '案件记忆')
    await wait("document.querySelector('.case-memory-card')")
    assert.equal(await evaluate("document.querySelector('.workspace-case-identity')?.textContent"), workspaceIdentity)
    assert.equal(await evaluate("document.querySelector('.workspace-topbar button[aria-label^=切换案件]')"), null)
    assert.equal(await evaluate("document.querySelector('.workspace-report-button').checkVisibility()"), false)
    assert.doesNotMatch(await evaluate("document.querySelector('.case-memory-heading').textContent"), /编辑案件信息|梳理/)
    assert.match(await evaluate("document.querySelector('.case-basic-fields').textContent"), /原告王某被告李某我方被告/)
    assert.equal(await evaluate("document.querySelectorAll('.case-memory-tabs [role=tab]').length"), 6)
    await fill('.case-memory-card textarea', '测试律师笔记')
    await clickText('.case-memory-card button', '保存笔记')
    await screenshot('case-memory')
    assert.equal(await evaluate("document.querySelector('.case-memory-heading h1').textContent"), '王某诉李某民间借贷纠纷')
    window.setSize(390, 900)
    await wait("innerWidth <= 640")
    assert.equal(await evaluate("document.querySelector('.workspace-case-identity').checkVisibility()"), true)
    assert.equal(await evaluate("document.querySelector('.workspace-topbar').scrollWidth <= document.querySelector('.workspace-topbar').clientWidth"), true)
    window.setSize(...originalSize)
    await clickText('.topbar button', '返回工作台')
    assert.equal(await evaluate("document.querySelector('.workspace-topbar .case-btn')?.getAttribute('aria-label')"), '切换案件 · 王某诉李某民间借贷纠纷')
    assert.equal(await evaluate("document.querySelector('.workspace-report-button')?.textContent"), '导出文书')
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
      const rightTabs = '.workspace-right-tablist [role=tab]'
      const paneWidths = () => evaluate("Array.from(document.querySelector('.ws').children, pane => pane.getBoundingClientRect().width)")
      const desktopWidths = await paneWidths()
      assert.equal(await evaluate("document.querySelector('.workspace-doc-strip [aria-label=\"AI 助手\"]')"), null, '文书工具栏不应重复显示助手入口')
      assert.equal(await evaluate("document.querySelector('.workspace-right-tablist [aria-selected=true]').textContent.trim()"), '核验结果')
      assert.equal(await evaluate("document.querySelector('.workspace-right-tablist [aria-label=\"AI 助手\"] img')?.naturalWidth > 0"), true)
      assert.equal(await evaluate("getComputedStyle(document.querySelector('[data-workspace-review-tab]')).borderInlineWidth === '0px'"), true, '核验结果页签不应显示外框')
      await wait(`(() => {
        const active = document.querySelector('.workspace-right-tablist [aria-selected=true]');
        const inactive = document.querySelector('.workspace-right-tablist [aria-selected=false]');
        const line = getComputedStyle(active, '::after');
        return line.opacity === '1' && line.height === '2px' && line.bottom === '0px'
          && getComputedStyle(inactive, '::after').opacity === '0';
      })()`)
      await clickText(rightTabs, 'AI 助手')
      await wait("document.querySelector('.workspace-ai-panel .assistant-composer')")
      assert.equal(await evaluate("document.querySelector('.workspace-ai-panel').closest('.pane-r')?.id"), 'workspace-review')
      assert.deepEqual(await paneWidths(), desktopWidths, '切换到 AI 助手时三栏宽度应保持固定')
      await fill('.assistant-composer textarea', '待发送的草稿')
      await clickText(rightTabs, '核验结果')
      assert.equal(await evaluate("document.querySelector('.review-todos').checkVisibility() && !document.querySelector('.workspace-ai-panel').checkVisibility()"), true)
      await evaluate("document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))")
      await wait("document.activeElement.matches('.workspace-right-tablist [aria-label=\"AI 助手\"]')")
      await evaluate("document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))")
      await wait("document.querySelector('.workspace-ai-panel').checkVisibility()")
      assert.equal(await evaluate("document.querySelector('.assistant-composer textarea').value"), '待发送的草稿')
      await fill('.assistant-composer textarea', '')
      await clickText(rightTabs, '核验结果')
      await evaluate("document.querySelector('.review-todo-card').click()")
      await wait("document.querySelector('.review-detail-bar')")
      assert.deepEqual(await paneWidths(), desktopWidths, '查看单句核验时三栏宽度应保持固定')
      await clickText(rightTabs, 'AI 助手')
      await wait("document.querySelector('.workspace-ai-panel').checkVisibility()")
      assert.deepEqual(await paneWidths(), desktopWidths, '从单句核验切换到 AI 助手时三栏宽度应保持固定')
      await clickText(rightTabs, '核验结果')
      await clickText('.review-detail-bar button', '返回待办')
      await clickText(rightTabs, 'AI 助手')
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
      window.setSize(390, 900)
      await wait("innerWidth <= 390 && document.querySelector('.ws.no-l:not(.no-r)')")
      assert.equal(await evaluate(`(() => { const panel = document.querySelector('.workspace-ai-panel');
        const send = panel.querySelector('[aria-label=发送]').getBoundingClientRect();
        return panel.checkVisibility() && panel.scrollWidth <= panel.clientWidth && send.bottom <= innerHeight; })()`), true)
      await screenshot('assistant-390')
      const narrowWidths = await paneWidths()
      await clickText(rightTabs, '核验结果')
      assert.deepEqual(await paneWidths(), narrowWidths, '窄屏切换到核验结果时栏宽应保持固定')
      await clickText(rightTabs, 'AI 助手')
      await clickText('.workspace-doc-strip button', '核验结果')
      await wait("document.querySelector('.ws.no-l.no-r')")
      await clickText('.workspace-doc-strip button', '核验结果')
      await clickText(rightTabs, 'AI 助手')
      await wait("document.querySelector('.workspace-ai-panel').checkVisibility({ visibilityProperty: true })")
      window.setSize(...originalSize)
      await clickText('.workspace-ai-header button', '关闭 AI 助手')
      await wait("getComputedStyle(document.querySelector('.pane-l')).visibility === 'visible'")
      console.log('PASS workspace column proportions, borderless tabs, keyboard switching, and narrow assistant layout')
    }
    assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('.material-actions button'), button=>button.textContent.trim())"), ['导入材料或文书'])
    assert.equal(await evaluate("Array.from(document.querySelectorAll('.topbar button')).some(button=>button.textContent.trim()==='编辑文书')"),false)
    const selectReviewedFixture = async () => {
      await wait("Array.from(document.querySelectorAll('.review-todo-card')).some(item=>item.textContent.includes('500,000元'))")
      await evaluate(`Array.from(document.querySelectorAll('.review-todo-card')).find(item=>item.textContent.includes('500,000元'))
        .click()`)
      await wait("document.querySelector('.whole-document-content[data-editable=true] .superdoc-page')")
    }
    await selectReviewedFixture()
    await wait("document.querySelector('.review-result-details blockquote')")
    assert.equal(await evaluate("document.querySelector('.review-result-details').open"), false)
    await clickText('.review-result-details summary', '核验详情')
    assert.match(await evaluate("document.querySelector('.review-result-details p').textContent"), /置信度 74%/u)
    assert.ok((await loadedChunks()).some(chunk => chunk.startsWith('Workspace-')), '工作台应能按需加载')
    await screenshot('workspace')
    await clickText('.review-result-actions button', '人工核验')
    await evaluate("document.querySelectorAll('.review-inline-operation input:enabled').forEach(input=>input.click())")
    await fill('.review-inline-operation textarea', '已对照流水核对借款本金。')
    await clickText('.review-inline-operation button', '通过并保留人工标注')
    await wait("document.querySelector('.review-result-status')?.textContent === '通过·标注'")
    await clickText('.review-result-actions button', '更多操作')
    await clickText('[role=menuitem]', '批注')
    await wait("document.querySelector('.review-wide-editor textarea')")
    await fill('.review-wide-editor textarea', '已核对原件，数字 123 不触发快捷键。')
    await evaluate("document.querySelector('.review-wide-editor textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'2',bubbles:true}))")
    await clickText('.review-wide-editor button', '保存批注')
    await wait("!document.querySelector('.review-wide-editor')")
    await evaluate('location.reload()')
    await wait("document.querySelector('.case-card')")
    await evaluate("document.querySelector('.case-card').click()")
    await wait("document.querySelector('.review-todo-tabs')")
    await clickText('.review-todo-tabs button', '标注 1')
    await selectReviewedFixture()
    await wait("document.querySelector('.review-result-status')?.textContent === '通过·标注' && document.querySelector('.review-sentence')?.textContent.includes('已核对原件，数字 123 不触发快捷键。')")
    await runWithWorkspaceAccount(account, async () => {
      const saved = await readWorkspace()
      const certificate = saved.certificates.find(item => item.id === 'qa-document')
      const declaration = certificate.verification.declarations.find(item => item.id === 'qa-fact')
      assert.equal(declaration.review.decision, 'confirmed')
      assert.equal(declaration.review.note, '已核对原件，数字 123 不触发快捷键。')
      assert.deepEqual(certificate.verification.audit.map(item => item.action), ['confirm', 'note'])
      assert.match(certificate.paragraphs[0].richText, /<u>/)
    })
    await evaluate("document.querySelector('.review-result-source').click()")
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
    assert.equal(await evaluate("Array.from(document.querySelectorAll('.new-doc-tabs [role=tab]')).every(tab => getComputedStyle(tab).borderWidth === '0px')"), true, '文书页签不应显示外框')
    await wait(`(() => {
      const active = document.querySelector('.new-doc-tabs [aria-selected=true]');
      const inactive = document.querySelector('.new-doc-tabs [aria-selected=false]');
      if (active?.querySelector('.workspace-doc-name').textContent !== '审阅完成回归文书' || !inactive) return false;
      const line = getComputedStyle(active, '::after');
      return line.opacity === '1' && line.height === '2px' && line.bottom === '0px'
        && getComputedStyle(inactive, '::after').opacity === '0';
    })()`)
    if (layoutOnly) {
      await screenshot('workspace-document-tabs')
      console.log('PASS borderless document tabs and selected underline after switching documents')
    }
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
      await wait("document.querySelector('.whole-document-content[data-editable=true] .superdoc-page')")
      const selectedPrefix = '2023年3月15日'
      await selectDocumentText(selectedPrefix)
      await wait("document.querySelector('.document-selection-actions')")
      assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('.document-selection-actions button')).map(button => button.textContent.trim())"), ['问 AI', '改写', '查法条', '查类案'])
      await evaluate(`(${bodyParagraphs}[0]).dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2,clientX:300,clientY:200}))`)
      await wait("document.querySelector('.workspace-document-menu [role=menuitem]')")
      assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('.workspace-document-menu [role=menuitem]')).map(item => item.textContent.trim())"), ['引用选中内容问 AI', '改写', '查法条', '查类案', '局部重核'])
      await evaluate("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))")
      await wait("!document.querySelector('.workspace-document-menu')")
      await selectDocumentText(selectedPrefix)
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
    await clickText('.topbar button.brand-home', 'LawVerify 首页')
    await wait("document.querySelector('#pg-home')")
    await clickText('.home-intro-actions button', '新建案件')
    await wait("document.querySelector('#field-name')")
    await evaluate("document.querySelector('.new-case-form .edit-case-more summary').click()")
    assert.equal(await evaluate("document.querySelector('.new-case-form #field-note')"), null)
    assert.equal(await evaluate("document.querySelector('.new-case-form #field-position').checkVisibility()"), true)
    await evaluate("document.querySelector('.new-case-form .edit-case-more summary').click()")
    await screenshot('new-case')
    await fill('#field-name', '新版回归测试案件')
    await fill('#field-plaintiff', '王某')
    await fill('#field-defendant', '李某')
    await evaluate("document.querySelectorAll('[name=case-our-side]')[1].click()")
    assert.equal(await evaluate("document.querySelector('.new-case-form').querySelectorAll('.fm-ft button').length"), 1)
    assert.equal(await evaluate("document.querySelector('.new-case-form .fm-ft button').disabled"), true)
    assert.equal(await evaluate("document.querySelector('.new-case-task').nextElementSibling.matches('.case-files-grid')"), true)
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.case-files-grid')).gridTemplateColumns.split(' ').length"), 2)
    await screenshot('document-import')
    const modalSize = window.getSize()
    window.setSize(390, 900)
    await new Promise(resolve => setTimeout(resolve, 150))
    assert.equal(await evaluate("document.querySelector('.new-case-form').scrollWidth <= document.querySelector('.new-case-form').clientWidth"), true, '新建案件弹窗窄屏不能横向溢出')
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.case-files-grid')).gridTemplateColumns.split(' ').length"), 1)
    assert.equal(await evaluate("document.querySelector('.new-case-form .fm-ft button').getBoundingClientRect().bottom <= document.querySelector('.new-case-form').getBoundingClientRect().bottom"), true)
    await screenshot('document-import-390')
    window.setSize(...modalSize)
    await wait("getComputedStyle(document.querySelector('.case-files-grid')).gridTemplateColumns.split(' ').length === 2")
    assert.equal(await evaluate("document.querySelector('.new-case-form [aria-haspopup=menu]')"), null)
    assert.equal(await evaluate("document.querySelector('.case-files-material input[type=file]')"), null)
    const assertDocumentPicker = async (scope) => {
      assert.equal(await evaluate(`(() => {
        const cards = [...document.querySelectorAll('${scope} .case-files-grid > section')];
        return cards.length === 2 && cards.every(card => card.firstElementChild.matches('.case-file-drop')) &&
          cards[1].querySelector('.case-file-drop').textContent.includes('Word / TXT / Markdown');
      })()`), true, '上传框上方应无标题，文书格式应显示在上传框内')
      assert.equal(await evaluate(`(() => {
        const area = document.querySelector('${scope} .case-files-document .case-file-drop');
        let opened = false;
        area.querySelector('input[type=file]').addEventListener('click', event => { event.preventDefault(); opened = true; }, { once: true });
        area.querySelector('button').click();
        return opened && !area.querySelector('[aria-haspopup]') && !area.querySelector('input[webkitdirectory]');
      })()`), true, '应能点击上传文书并打开文件选择器')
    }
    await assertDocumentPicker('.new-case-form')
    const caseDocuments = path.join(directory, '待核验文书')
    const caseDocumentTitles = ['测试起诉状', '测试答辩状', '测试代理意见']
    fs.mkdirSync(path.join(caseDocuments, '补充文书'), { recursive: true })
    fs.writeFileSync(path.join(caseDocuments, '测试起诉状.txt'), '民事起诉状\n\n双方约定货款100元，被告未付款。')
    fs.writeFileSync(path.join(caseDocuments, '测试答辩状.txt'), '民事答辩状\n\n被告已按约定期限付清100元货款，并保留了付款凭证。')
    fs.writeFileSync(path.join(caseDocuments, '补充文书', '测试代理意见.md'), '代理意见\n\n请核对合同和付款凭证记载的货款金额及付款日期。')
    const directoryPickerOpened = new Promise(resolve => { onDirectoryPickerOpened = resolve })
    await evaluate("document.querySelector('.new-case-form .case-files-material .case-file-drop button').click()")
    const closeDirectoryPicker = await directoryPickerOpened
    await dropFiles('.new-case-form .case-files-document .case-file-drop', [
      path.join(caseDocuments, '测试起诉状.txt'), path.join(caseDocuments, '测试答辩状.txt'), path.join(caseDocuments, '补充文书'),
    ])
    await wait("document.querySelectorAll('.case-files-document .chip').length === 3")
    assert.equal(await evaluate("document.querySelector('.new-case-form button[type=submit]').disabled"), true, '仅有文书不能新建核验案件')
    const originals = path.join(directory, '原材料')
    const standalone = path.join(directory, '独立原材料.txt')
    fs.mkdirSync(path.join(originals, '子目录'), { recursive: true })
    fs.writeFileSync(path.join(originals, '子目录', '子目录材料.txt'), '双方于2026年11月15日约定货款100元。')
    fs.writeFileSync(standalone, '双方在合同中约定货款100元。')
    await dropFiles('.new-case-form .case-files-material .case-file-drop', [standalone, originals])
    await wait("document.querySelectorAll('.case-files-material .chip').length === 2")
    assert.deepEqual(await evaluate("[...document.querySelectorAll('.case-files-material .chip b')].map(name => name.textContent)"), ['独立原材料.txt', '原材料'])
    assert.equal(await evaluate("document.querySelector('.case-files-document [role=combobox]')"), null)
    assert.equal(await evaluate("document.querySelectorAll('.case-files-document .chip').length"), 3)
    assert.equal(await evaluate("document.querySelector('.new-case-form button[type=submit]').disabled"), true, '关闭目录选择框前不能提交')
    closeDirectoryPicker({ canceled: true, filePaths: [] })
    await wait("!document.querySelector('.new-case-form button[type=submit]').disabled")
    await assertDocumentPicker('.new-case-form')
    await fill('#field-name', '')
    assert.equal(await evaluate("document.querySelector('.new-case-form button[type=submit]').disabled"), true)
    assert.match(await evaluate("document.querySelector('.new-case-form .fm-ft').textContent"), /请填写案件名称/)
    await fill('#field-name', '新版回归测试案件')
    await wait("!document.querySelector('.new-case-form button[type=submit]').disabled")
    console.log('PASS material and document drops while the directory picker is open, then submit after closing')
    await saved(state => {
      assert.ok(!state.cases.some(item => item.name === '新版回归测试案件'))
      assert.ok(!state.certificates.some(item => item.title === '测试起诉状'))
      assert.ok(!state.evidences.some(item => item.fileName === '独立原材料.txt'))
    })
    await screenshot('document-import-ready')
    await evaluate(`(() => {
      const calls = window.__caseFileRequests = [];
      const observe = url => {
        if (String(url).includes('/api/evidences/assets/upload') || String(url).includes('/api/documents/import')) {
          calls.push(Boolean(document.querySelector('#pg-proc') && !document.querySelector('.new-case-form')));
        }
      };
      const fetch = window.fetch;
      let firstDocumentResponse;
      window.fetch = async (input, init) => {
        const url = String(input);
        if (url.includes('/api/cases?response=compact') && init?.method === 'POST' && !window.__releaseCaseCreate) {
          await new Promise(resolve => { window.__releaseCaseCreate = resolve; });
        }
        observe(input);
        if (url.includes('/api/documents/import')) {
          if (!window.__releaseCaseDocument) {
            await new Promise(resolve => { window.__releaseCaseDocument = resolve; });
          }
          if (firstDocumentResponse && !window.__allowRemainingCaseImports) return firstDocumentResponse.clone();
          const response = await fetch(input, init);
          if (!firstDocumentResponse && response.ok) firstDocumentResponse = response.clone();
          return response;
        }
        if (url.includes('/auto-link/stream') && !window.__releaseCaseVerification) {
          await new Promise(resolve => { window.__releaseCaseVerification = resolve; });
        }
        return fetch(input, init);
      };
      const open = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function (method, url, ...options) { observe(url); return open.call(this, method, url, ...options); };
      const send = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.send = function (body) {
        if (body instanceof FormData && body.has('manifest') && !window.__releaseCaseMaterials) {
          window.__releaseCaseMaterials = () => send.call(this, body);
          return;
        }
        return send.call(this, body);
      };
    })()`)
    await clickText('.new-case-form .fm-ft button', '创建并核验')
    await wait("window.__releaseCaseCreate")
    assert.equal(await evaluate("Boolean(document.querySelector('#pg-proc') && !document.querySelector('.new-case-form'))"), true, '建案接口等待时已显示核验动画页')
    await evaluate('window.__releaseCaseCreate()')
    await wait("window.__releaseCaseMaterials && document.querySelector('#pg-proc .ppct')?.textContent.includes('案件原材料')")
    assert.match(await evaluate("document.querySelector('#pg-proc .pst.on')?.textContent"), /解析原材料与证据/)
    assert.equal(await evaluate("document.querySelector('#pg-proc .ppct')?.textContent"), '正在链接案件原材料')
    await evaluate('window.__releaseCaseMaterials()')
    await wait("document.querySelector('#pg-proc .proc-t')?.textContent.includes('《测试起诉状》')")
    await wait("window.__releaseCaseDocument && document.querySelector('#pg-proc .ppct')?.textContent.includes('正在解析第')")
    assert.match(await evaluate("document.querySelector('#pg-proc .pst.on')?.textContent"), /解析原材料与证据/)
    assert.equal(await evaluate("document.querySelector('#pg-proc .pbar').getAttribute('aria-valuenow')"), '0', '文件准备期间应连续显示第一步进度，避免开始核验时回退')
    await evaluate('window.__releaseCaseDocument()')
    await wait("window.__releaseCaseVerification || document.querySelector('.new-error')")
    assert.equal(await evaluate('Boolean(window.__releaseCaseVerification)'), false, '三份文件返回同一个文书编号时不能只核验一份')
    assert.match(await evaluate("document.querySelector('.new-error').textContent"), /未取得独立的导入结果/)
    await clickText('.new-error button', '关闭')
    await evaluate('window.__allowRemainingCaseImports = true')
    await clickText('.proc-actions button', '重试')
    await wait("window.__releaseCaseVerification && document.querySelector('#pg-proc .pst.on .pst-i')?.textContent === '1'")
    assert.equal(await evaluate("document.querySelector('#pg-proc .ppct').textContent"), '准备读取材料解析状态')
    await evaluate('window.__releaseCaseVerification()')
    await wait("document.querySelector('#pg-proc .ppct')?.textContent.includes('核验未完成') && document.querySelector('.new-error')?.textContent.includes('LLM API Key')")
    assert.deepEqual(await evaluate('window.__caseFileRequests'), [true, true, true, true, true, true], '重试应只补导未取得独立编号的文书')
    const importedId = await saved(state => state.certificates.find(item => item.title === '测试起诉状').id)
    assert.equal(await saved(state => state.certificates.find(item => item.id === importedId).verification), undefined)
    await clickText('.new-error button', '关闭')
    const materialReady = () => saved(state => {
      const { caseId } = state.certificates.find(item => item.id === importedId)
      const evidence = state.evidences.find(item => item.caseId === caseId && item.fileName === '子目录材料.txt')
      const task = state.cases.find(item => item.id === caseId).agent?.task?.status
      return evidence?.parsing?.status === 'ready' && !['queued', 'processing'].includes(task)
    })
    const materialDeadline = Date.now() + 25000
    let ready = await materialReady()
    while (!ready && Date.now() < materialDeadline) {
      await new Promise(resolve => setTimeout(resolve, 150))
      ready = await materialReady()
    }
    assert.ok(ready, '重试全文核验前，拖入文件夹中的测试材料应完成解析')
    const previousModel = env.LLM_MODEL
    Object.assign(env, { LLM_BASE_URL: new URL('/qa-model', url).href, LLM_API_KEY: randomUUID(), LLM_MODEL: 'qa-model' })
    try {
      await clickText('.proc-actions button', '重试')
      await wait("document.querySelector('#pg-proc .ppct')?.textContent === '全部 3 份文书核验完成' && !document.querySelector('.proc-actions button')?.disabled")
    } finally {
      Object.assign(env, { LLM_BASE_URL: undefined, LLM_API_KEY: undefined, LLM_MODEL: previousModel })
    }
    await screenshot('homepage-import-verification-complete')
    await clickText('.proc-actions button', '查看核验结果')
    await wait("document.querySelectorAll('#pg-ws .doc-tab').length === 3")
    const firstDocumentTab = await evaluate("Array.from(document.querySelectorAll('#pg-ws .doc-tab')).find(tab => tab.textContent.includes('测试起诉状')).textContent.trim()")
    await clickText('#pg-ws .doc-tab', firstDocumentTab)
    await wait("document.querySelector('#pg-ws .ctool h1')?.textContent === '测试起诉状'")
    assert.equal(await evaluate("document.querySelector('[aria-label=\"当前文书类型\"]').textContent"), '通用核验 · 待分类')
    await runWithWorkspaceAccount(account, async () => {
      const saved = await readWorkspace()
      const created = saved.cases.find(item => item.name === '新版回归测试案件')
      assert.equal(created.basicInfo.ourSide, 'plaintiff')
      assert.equal(created.basicInfo.plaintiff, '王某')
      assert.ok(saved.evidences.some(item => item.caseId === created.id && item.fileName === '子目录材料.txt' && item.directoryId))
      assert.ok(saved.evidences.some(item => item.caseId === created.id && item.fileName === '独立原材料.txt' && item.directoryId && item.parsing?.status === 'ready'))
      const imported = saved.certificates.find(item => item.caseId === created.id && item.title === '测试起诉状')
      assert.equal(imported.id, importedId)
      assert.equal(imported.docKey, undefined)
      for (const title of caseDocumentTitles) {
        const document = saved.certificates.find(item => item.caseId === created.id && item.title === title)
        assert.ok(document?.verification?.revision && document.verification.declarations.length > 0, `《${title}》应保存核验结果`)
      }
    })
    console.log('PASS one-step case setup, deferred material and document processing, and verification retry')
    if (layoutOnly) {
      await clickText('.add-mat', '导入材料或文书')
      await wait("document.querySelector('.new-upload')")
      const importActions = "Array.from(document.querySelectorAll('.upload-actions button'), button => button.textContent.trim())"
      assert.deepEqual(await evaluate(importActions), ['导入并核验'])
      await assertDocumentPicker('.new-upload')
      const additionalEvidence = path.join(directory, '补充原材料.txt')
      const extraDoc = path.join(directory, '批量上传甲.txt')
      const extraDocs = path.join(directory, '补充文书')
      fs.mkdirSync(extraDocs)
      fs.writeFileSync(additionalEvidence, '委托人确认合同已签字。')
      fs.writeFileSync(extraDoc, '民事起诉状。')
      fs.writeFileSync(path.join(extraDocs, '批量上传乙.txt'), '补充代理意见。')
      await dropFiles('.new-upload .case-files-material .case-file-drop', [additionalEvidence])
      await wait("document.querySelector('.new-upload .case-files-material .chip b')?.textContent === '补充原材料.txt'")
      assert.deepEqual(await evaluate(importActions), ['导入并核验'])
      assert.equal(await evaluate("document.querySelector('.upload-actions button').disabled"), true)
      await dropFiles('.new-upload .case-files-document .case-file-drop', [extraDoc, extraDocs])
      await wait("document.querySelectorAll('.new-upload .case-files-document .chip').length === 2")
      assert.deepEqual(await evaluate(importActions), ['导入并核验'])
      await wait("document.querySelector('.upload-actions button:not(:disabled)')")
      verification.enabled = true
      await clickText('.upload-actions button', '导入并核验')
      await wait("document.querySelector('#pg-proc .ppct')?.textContent === '全部 2 份文书核验完成'")
      await clickText('.proc-actions button', '查看核验结果')
      await wait("document.querySelector('#pg-ws')")
      await saved(state => {
        const created = state.cases.find(item => item.name === '新版回归测试案件')
        assert.ok(state.evidences.some(item => item.caseId === created.id && item.fileName === '补充原材料.txt' && item.directoryId))
        assert.deepEqual(state.certificates.filter(item => item.caseId === created.id && item.title.startsWith('批量上传')).map(item => item.title).sort(), ['批量上传乙', '批量上传甲'])
      })
      console.log('PASS the sole import action links materials, uploads documents and starts verification')
      await clickText('.topbar button.brand-home', 'LawVerify 首页')
      await clickText('.home-intro-actions button', '新建案件')
      await wait("document.querySelector('#field-name')")
      await fill('#field-name', '新建起草案件')
      await evaluate("document.querySelector('input[name=case-task][value=draft]').click()")
      await wait("document.querySelector('.case-files-material')")
      assert.equal(await evaluate("document.querySelector('.case-files-document')"), null)
      assert.equal(await evaluate("document.querySelector('.new-case-form button[type=submit]').disabled"), true, '起草也必须有原材料')
      await screenshot('draft-upload')
      await evaluate("document.querySelector('.new-case-form .case-files-material .case-file-drop button').click()")
      await wait("document.querySelector('.case-files-material .chip b')?.textContent === 'linked-files'")
      await saved(state => assert.ok(!state.cases.some(item => item.name === '新建起草案件')))
      await clickText('.new-case-form .fm-ft button', '创建并起草')
      await wait("document.querySelector('.workspace-ai-panel .workspace-ai-card[data-mode=document][aria-pressed=true]')")
      await saved(async state => {
        const created = state.cases.find(item => item.name === '新建起草案件')
        const linked = state.evidences.find(item => item.caseId === created.id && item.fileName === '测试材料.txt')
        assert.ok(linked?.directoryId)
        assert.equal(linked.parsing?.status, 'ready')
        assert.ok(!state.certificates.some(item => item.caseId === created.id))
        const links = await evaluate(`window.lawVerifyDesktop.scanCaseDirectories(${JSON.stringify({ account, caseId: created.id })})`)
        assert.equal(links[0].id, linked.directoryId)
      })
      assert.deepEqual(errors.filter(message => !/favicon|404/.test(message)), [])
      process.stdout.write(`PASS v1.2 layout, case setup, file import and Word exports, screenshots: ${directory}\n`)
      window.destroy(); await new Promise(resolve => server.close(resolve)); app.exit(0)
      return
    }
    await require('./redesign-directory-checks.cjs')({ evaluate, wait, clickText, saved: fn => runWithWorkspaceAccount(account, async () => fn(await readWorkspace())), linkedDirectory, fs, path, setDeleteFailure: id => { failedDeleteCase = id } })
    await runAccountChecks()
    await runDocumentChecks()
    await require('./redesign-case-assistant-checks.cjs')({ evaluate, wait, clickText, fill, screenshot, saved, writeWorkspace, reload, enter })
    await require('./redesign-essential-checks.cjs')({ evaluate, wait, clickText, fill, screenshot, window,
      readWorkspace, writeWorkspace, runWithWorkspaceAccount, account, linkageMaterialFingerprint, setAccountStatus: status => { accountStatus = status } })
    assert.deepEqual(errors.filter(message => !/favicon|404/.test(message)), [])
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ passed: true, directory, checks: ['真实工作区首页', 'AI流式起草改写及中断草稿', '客户端扣费与失败退款', '案件助手与代理确认', '积分邀请反馈', '富文本格式', '确认持久化', '批注持久化', '输入框快捷键隔离', '出处抽屉', '报告导航', '审阅版Word', '清洁版正文无批注且报告保留批注', '新建案件', '真实文件夹联动与独立文书导入', '核验启动及失败或取消后恢复', '账号设置、资料更新、改密与会话换发'] }, null, 2))
    process.stdout.write(`PASS redesign UI, screenshots: ${directory}\n`)
    window.destroy(); await new Promise(resolve => server.close(resolve)); app.exit(0)
  } catch (error) {
    process.stderr.write(`${error.stack}\n${errors.join('\n')}\n`)
    if (window) process.stderr.write(JSON.stringify(await window.webContents.executeJavaScript("({alert:document.querySelector('.new-error')?.textContent,footer:document.querySelector('.essential-editor-footer')?.textContent,inline:document.querySelector('.inline-actions')?.textContent})")) + '\n')
    if (latestImage) fs.writeFileSync(path.join(directory, 'failure.png'), latestImage.toPNG())
    window?.destroy(); server?.close(); app.exit(1)
  }
})

