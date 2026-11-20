const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')
const c1 = require('../../server/eval/verification/fixtures/seed/documents.json').find(item => item.id === 'c1-qs')

const workspace = path.resolve(__dirname, '..', '..')
const root = path.join(workspace, 'docs', 'lawverify-视觉交付')
const prototypePath = path.join(root, 'AI智能证据联动-交互原型-可交付版.html')
const output = path.join(workspace, 'app', 'tmp', `prototype-qa-${Date.now()}`)
app.setPath('userData', path.join(output, 'profile'))
app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  await fs.mkdir(output, { recursive: true })
  const index = await fs.readFile(path.join(root, 'dist', 'index.html'), 'utf8')
  const standalone = await fs.readFile(prototypePath, 'utf8')
  const scriptPath = index.match(/<script\b[^>]*\bsrc="\/([^"]+)"/)?.[1]
  const stylePath = index.match(/<link\b(?=[^>]*rel="stylesheet")[^>]*\bhref="\/([^"]+)"/)?.[1]
  assert.ok(scriptPath && stylePath)
  const [script, style] = await Promise.all([scriptPath, stylePath].map(name => fs.readFile(path.join(root, 'dist', name), 'utf8')))
  assert.ok(standalone.includes(`<script>${script.replace(/<\/script/gi, '<\\/script')}</script>`), '独立 HTML 脚本应与 dist 完全一致')
  assert.ok(standalone.includes(`<style>${style}</style>`), '独立 HTML 样式应与 dist 完全一致')
  const window = new BrowserWindow({ show: false, width: 1440, height: 960, webPreferences: { offscreen: true, backgroundThrottling: false } })
  const evaluate = script => window.webContents.executeJavaScript(script)
  const wait = async (script) => {
    const until = Date.now() + 12000
    while (Date.now() < until) {
      if (await evaluate(`Boolean(${script})`)) return
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error(`原型等待超时：${script}`)
  }
  const click = (selector, text) => evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(node => node.textContent.includes(${JSON.stringify(text)})).click()`)
  const screenshot = async name => fs.writeFile(path.join(output, name), (await window.webContents.capturePage()).toPNG())
  await window.loadFile(prototypePath)
  await wait("document.querySelector('.home-sample-cases .case-card')")
  await click('.home-sample-cases .case-card', '王某诉李某')
  await wait("document.querySelector('#pg-ws .review-overview')")
  await screenshot('workspace.png')
  await click('#pg-ws button', '在线编辑')
  await wait("document.querySelector('#pg-ws .editor-bar')")
  await click('#pg-ws .editor-bar button', '完成编辑')
  const quote = await evaluate(`(async () => {
    const mark = Array.from(document.querySelectorAll('#pg-ws .doc-paper [data-el]')).find(node => node.textContent.trim() === ${JSON.stringify(c1.paragraphs[1])});
    mark.scrollIntoView({ block: 'center' });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const range = document.createRange(); range.selectNodeContents(mark);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    mark.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return mark.textContent.trim();
  })()`)
  assert.equal(quote, c1.paragraphs[1])
  await wait("document.querySelector('.ask-selection button')")
  await click('.ask-selection button', '问 AI 助手')
  await wait(`document.querySelector('.assistant-selection .att-text')?.textContent === ${JSON.stringify(quote)}`)
  await evaluate("document.querySelector('[aria-label=\"移除选中文段\"]').click()")
  await wait("!document.querySelector('.assistant-selection')")
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))")
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'e',ctrlKey:true,bubbles:true,cancelable:true}))")
  await wait("document.querySelector('#pg-report .report-download-options')")
  assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('#pg-report .report-download-options button')).map(node => node.disabled)"), [true, true, false])
  const caseReport = path.join(output, 'prototype-case.docx')
  const download = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('原型未下载独立案例报告')), 12000)
    window.webContents.session.once('will-download', (_event, item) => {
      item.setSavePath(caseReport)
      item.once('done', (_finish, state) => { clearTimeout(timer); state === 'completed' ? resolve() : reject(new Error(state)) })
    })
  })
  await click('#pg-report .report-download-options button', '案例')
  await download
  assert.equal((await fs.readFile(caseReport)).subarray(0, 2).toString(), 'PK')
  await screenshot('report.png')
  await click('#pg-report .topbar button', '返回工作台')
  await click('#pg-ws .topbar button', '案件记忆')
  await wait("document.querySelectorAll('#pg-memory .memory-views button').length === 6")
  await screenshot('memory.png')
  window.destroy()
  process.stdout.write(`PASS standalone package, c1 workspace, blocked Word, case report and six memory tabs: ${output}\n`)
  app.exit(0)
}).catch(error => { console.error(error); app.exit(1) })
