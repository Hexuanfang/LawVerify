const { app, BrowserWindow } = require('electron')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')

// 验证案件助手的 chat 对话框结构与模式开关渲染，不登录、不触碰案件数据。
const source = path.resolve(__dirname, '../src')
const css = ['index.css', 'App.css'].map(file => readFileSync(path.join(source, file), 'utf8')).join('\n')

const html = `<!doctype html><html><head><style>${css}</style></head><body>
<div class="app-shell pro-shell streamlined-shell ide-shell"
  style="--streamlined-sidebar-width:300px;--streamlined-insight-width:400px;height:720px">
  <div class="main-content streamlined-main">
    <section class="streamlined-workbench ide-workbench">
      <div class="streamlined-insight-panel">
        <div class="streamlined-insight-content ide-assistant-content">
          <div class="ide-assistant-view">
            <div class="agent-dock ide-agent-panel is-open">
              <div class="agent-dock-card">
                <div class="agent-dock-body">
                  <section class="case-agent-panel case-agent-chat">
                    <header class="case-agent-chat-head">
                      <div class="case-agent-position">
                        <strong>代理原告：张三</strong>
                        <p>追讨借款本金并确认逾期利息</p>
                      </div>
                      <div class="assistant-mode-switch" role="radiogroup" aria-label="助手模式" data-active="position">
                        <span class="assistant-mode-switch-thumb"></span>
                        <button type="button" role="radio" aria-checked="true" class="active">代理设置</button>
                        <button type="button" role="radio" aria-checked="false">讨论案情</button>
                      </div>
                    </header>
                    <div class="case-agent-chat-body">
                      <article class="agent-message user"><strong>你</strong><p>胜算多少</p></article>
                      <article class="agent-message assistant"><strong>助手</strong><p>关于"胜算多少"，按执业规范不能给出胜诉概率或结果承诺，只能给出风险评估与可控空间。以下按被答辩人立场分析。</p></article>
                    </div>
                    <form class="case-agent-composer">
                      <textarea placeholder="说明你代理的当事人和办案目标…"></textarea>
                      <div class="assistant-composer-row">
                        <div class="assistant-picker"><button class="assistant-control" type="button"><span>案件助手</span></button></div>
                        <div class="assistant-picker"><button class="assistant-control" type="button"><span>默认模型</span></button></div>
                        <button class="assistant-voice" type="button">语音</button>
                        <button class="assistant-send" type="button">↑</button>
                      </div>
                    </form>
                  </section>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  </div>
</div></body></html>`

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1280, height: 800, show: false, webPreferences: { offscreen: true } })
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  const result = await win.webContents.executeJavaScript(`(() => {
    const q = (s) => document.querySelector(s)
    const panel = q('.case-agent-chat')
    const head = q('.case-agent-chat-head')
    const body = q('.case-agent-chat-body')
    const composer = q('.case-agent-composer')
    const sw = q('.assistant-mode-switch')
    const thumb = q('.assistant-mode-switch-thumb')
    const buttons = [...document.querySelectorAll('.assistant-mode-switch button')]
    const panelRect = panel.getBoundingClientRect()
    const bodyRect = body.getBoundingClientRect()
    const composerRect = composer.getBoundingClientRect()
    return {
      hasPanel: !!panel,
      hasHead: !!head,
      hasBody: !!body,
      hasComposer: !!composer,
      switchButtons: buttons.map(b => b.textContent.trim()),
      switchState: sw.getAttribute('data-active'),
      thumbWidth: thumb.getBoundingClientRect().width,
      trackWidth: sw.getBoundingClientRect().width,
      bodyScrollable: body.scrollHeight > body.clientHeight || getComputedStyle(body).overflowY === 'auto',
      bodyOverflow: getComputedStyle(body).overflowY,
      composerBottom: composerRect.bottom,
      panelBottom: panelRect.bottom,
      bodyBottom: bodyRect.bottom,
      bodyBelowHead: bodyRect.top >= head.getBoundingClientRect().bottom - 1,
      composerBelowBody: composerRect.top >= bodyRect.top,
      messages: document.querySelectorAll('.case-agent-chat-body .agent-message').length,
    }
  })()`)

  assert.ok(result.hasPanel, '应存在 chat 面板')
  assert.ok(result.hasHead, '应存在顶部状态区')
  assert.ok(result.hasBody, '应存在消息区')
  assert.ok(result.hasComposer, '应存在输入区')
  assert.deepEqual(result.switchButtons, ['代理设置', '讨论案情'], '开关应包含两个模式')
  assert.equal(result.switchState, 'position', '开关初始状态应为代理设置')
  assert.ok(result.thumbWidth > 0 && result.thumbWidth < result.trackWidth, '滑块应占据轨道一半')
  assert.equal(result.bodyOverflow, 'auto', '消息区应可滚动')
  assert.equal(result.messages, 2, '应渲染两条对话消息')
  assert.ok(result.bodyBelowHead, '消息区应在顶部状态区下方')
  assert.ok(result.composerBelowBody, '输入区应在消息区之后')
  assert.ok(Math.abs(result.composerBottom - result.panelBottom) < 24, '输入区应贴近面板底部')

  // 切到讨论案情：滑块应右移。
  const shifted = await win.webContents.executeJavaScript(`(() => {
    const sw = document.querySelector('.assistant-mode-switch')
    sw.setAttribute('data-active', 'question')
    const thumb = document.querySelector('.assistant-mode-switch-thumb')
    return getComputedStyle(thumb).transform
  })()`)
  assert.notEqual(shifted, 'none', '切到讨论案情时滑块应位移')

  console.log('agent chat switch ok', JSON.stringify(result))
  app.exit(0)
}).catch(error => {
  console.error('agent chat switch FAILED:', error && error.message ? error.message : String(error))
  app.exit(1)
})
