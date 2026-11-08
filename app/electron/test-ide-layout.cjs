const { app, BrowserWindow } = require('electron')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')

// Exercise the production styles without logging in or touching case data.
const source = path.resolve(__dirname, '../src')
const css = ['index.css', 'App.css'].map(file => readFileSync(path.join(source, file), 'utf8')).join('\n')
const html = `<!doctype html><html><head><style>${css}</style>
<style>
  .probe { position: absolute; top: 0; left: -4000px; width: 520px; display: flex; flex-direction: column; gap: 24px; }
  .probe .agent-dock { position: static; width: 100%; height: 460px; }
</style></head><body>
<div class="app-shell pro-shell streamlined-shell ide-shell"
  style="--streamlined-sidebar-width:300px;--streamlined-insight-width:400px">
  <nav class="ide-activity-bar"><button aria-label="资源管理器" aria-pressed="true">Files</button></nav>
  <aside class="sidebar streamlined-sidebar">Directory</aside>
  <div class="streamlined-shell-resizer"></div>
  <main class="main-content streamlined-main">
    <section class="streamlined-workbench ide-workbench">
      <article class="streamlined-document-panel">Document</article>
      <div class="streamlined-workbench-resizer"></div>
      <aside class="streamlined-insight-panel">
        <button class="streamlined-insight-collapse" type="button" title="收起案件助手" aria-label="收起案件助手">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="m10 4-4 4 4 4" /></svg>
        </button>
        <div class="ide-insight-tabs"><button class="active">助手</button></div>
        <div class="streamlined-insight-content ide-assistant-content">
          <div class="ide-assistant-view">
            <div class="agent-dock ide-agent-panel is-open">
              <div class="agent-dock-card">
                <div class="agent-dock-body">
                  <div class="agent-message-list case-agent-chat-body">
                    <article class="agent-message user">
                      <span class="agent-message-author">你</span>
                      <div class="agent-message-bubble"><p>请帮我梳理本案的争议焦点与举证思路。</p></div>
                    </article>
                    <article class="agent-message assistant">
                      <span class="agent-message-author">文书助手</span>
                      <div class="agent-message-bubble"><p>关于「胜算多少」，按执业规范不能给出胜诉概率或结果承诺，只能给出风险评估与可控空间。</p></div>
                    </article>
                  </div>
                  <div class="agent-input-shell agent-dock-input-shell">
                    <div class="agent-mode-bar">
                      <div class="agent-mode-switch" role="tablist">
                        <button type="button" class="active">案件沟通</button>
                        <button type="button">文书起草</button>
                      </div>
                      <div class="agent-mode-status"><span class="agent-mode-status-item">已选 42 份证据</span></div>
                    </div>
                    <textarea class="agent-dock-prompt-input" placeholder="描述文书类型与起草要求…"></textarea>
                    <div class="agent-dock-submit-area">
                      <div class="assistant-composer-tools">
                        <button class="assistant-voice" type="button">语音</button>
                        <button class="assistant-control" type="button">清空</button>
                      </div>
                      <div class="assistant-composer-actions">
                        <div class="assistant-picker"><button class="assistant-control" type="button"><span>默认模型</span></button></div>
                        <button class="assistant-send" type="button">发送</button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </aside>
    </section>
  </main>
</div>
<div class="probe">
  <div class="agent-dock ide-agent-panel is-open" id="probe-case">
    <div class="agent-dock-card">
      <div class="agent-dock-body">
        <section class="case-agent-panel case-agent-chat">
          <header class="case-agent-chat-head">
            <div class="case-agent-position">
              <strong>代理被告：张长松</strong>
              <p>应诉抗辩（具体办案目标待用户确认）</p>
            </div>
          </header>
          <div class="case-agent-chat-body">
            <article class="agent-message assistant">
              <span class="agent-message-author">助手</span>
              <div class="agent-message-bubble"><p>关于「胜算多少」，只能给出风险评估与可控空间。</p></div>
            </article>
          </div>
          <form class="case-agent-composer">
            <div class="agent-mode-bar">
              <div class="agent-mode-switch" role="tablist">
                <button type="button" class="active">案件沟通</button>
                <button type="button">文书起草</button>
              </div>
              <div class="agent-mode-status"><span class="agent-mode-status-item">已选 42 份证据</span></div>
            </div>
            <textarea placeholder="输入问题，或输入 \\ 选择 Skill…"></textarea>
            <div class="assistant-composer-row">
              <div class="assistant-composer-tools"><button class="assistant-voice" type="button">语音</button></div>
              <div class="assistant-composer-actions"><button class="assistant-send" type="button">发送</button></div>
            </div>
          </form>
        </section>
      </div>
    </div>
  </div>
  <div class="agent-dock ide-agent-panel is-open" id="probe-document">
    <div class="agent-dock-card">
      <div class="agent-dock-body">
        <div class="agent-message-list case-agent-chat-body">
          <article class="agent-message assistant">
            <span class="agent-message-author">文书助手</span>
            <div class="agent-message-bubble"><p>关于「胜算多少」，只能给出风险评估与可控空间。</p></div>
          </article>
        </div>
        <div class="agent-input-shell agent-dock-input-shell">
          <div class="agent-mode-bar">
            <div class="agent-mode-switch" role="tablist">
              <button type="button" class="active">案件沟通</button>
              <button type="button">文书起草</button>
            </div>
            <div class="agent-mode-status"><span class="agent-mode-status-item">已选 42 份证据</span></div>
          </div>
          <textarea class="agent-dock-prompt-input" placeholder="描述文书类型与起草要求…"></textarea>
          <div class="agent-dock-submit-area">
            <div class="assistant-composer-tools"><button class="assistant-voice" type="button">语音</button></div>
            <div class="assistant-composer-actions"><button class="assistant-send" type="button">发送</button></div>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>
<script>
document.querySelector('button').onclick = function () {
  const collapsed = document.querySelector('.ide-shell').classList.toggle('streamlined-shell-sidebar-collapsed');
  document.querySelector('.streamlined-sidebar').classList.toggle('is-collapsed', collapsed);
  document.querySelector('.ide-shell').style.setProperty('--streamlined-sidebar-width', collapsed ? '56px' : '300px');
  this.setAttribute('aria-pressed', String(!collapsed));
};
</script></body></html>`

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, backgroundThrottling: false, partition: 'ide-layout-regression' },
  })
  const failures = []
  try {
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    for (const width of [1920, 1366, 1280, 1024, 760, 600, 390]) {
      window.setContentSize(width, 900)
      for (let step = 0; step < 9; step++) {
        const state = await window.webContents.executeJavaScript(`new Promise(resolve => {
          setTimeout(() => {
            const rect = selector => {
              const element = document.querySelector(selector);
              if (!element) return null;
              const box = element.getBoundingClientRect();
              return { x: box.x, y: box.y, width: box.width, height: box.height,
                top: box.top, bottom: box.bottom, left: box.left,
                right: box.right, display: getComputedStyle(element).display };
            };
            const overflow = selector => {
              const element = document.querySelector(selector);
              return { scrollWidth: element.scrollWidth, clientWidth: element.clientWidth,
                scrollHeight: element.scrollHeight, clientHeight: element.clientHeight };
            };
            resolve({ viewport: innerWidth, collapsed: document.querySelector('.ide-shell')
              .classList.contains('streamlined-shell-sidebar-collapsed'),
              main: rect('main'), directory: rect('.streamlined-sidebar'),
              document: rect('.streamlined-document-panel'),
              assistant: rect('.streamlined-insight-panel'),
              panelOverflow: overflow('.streamlined-insight-panel'),
              composerOverflow: overflow('.agent-dock-submit-area'),
              modeStatus: rect('.agent-mode-status'),
              sendButton: rect('.assistant-send'),
              conversation: rect('.agent-message-list'),
              inputCard: rect('.agent-dock-input-shell'),
              conversationOverflow: overflow('.agent-message-list'),
              caseHead: rect('#probe-case .case-agent-chat-head'),
              caseBody: rect('#probe-case .case-agent-chat-body'),
              caseComposer: rect('#probe-case .case-agent-composer'),
              collapseButton: rect('.streamlined-insight-collapse'),
              probeCaseBody: rect('#probe-case .agent-dock-body'),
              probeDocBody: rect('#probe-document .agent-dock-body'),
              probeDocConversation: rect('#probe-document .agent-message-list'),
              probeDocInput: rect('#probe-document .agent-dock-input-shell') });
          }, 30);
        })`)
        try {
          const mobile = state.viewport <= 760
          const expectedLeft = mobile ? 44 : state.collapsed ? 52 : state.viewport <= 1100
            ? 52 + Math.max(180, Math.min(state.viewport * 0.22, 300)) + 6 : 358
          assert.ok(Math.abs(state.main.x - expectedLeft) < 2, `main x=${state.main.x}, expected ${expectedLeft}`)
          assert.ok(Math.abs(state.main.right - state.viewport) < 2, 'main must fill the remaining viewport')
          assert.equal(state.main.y, 0, 'main must stay in the first grid row')
          assert.ok(state.main.height > 850, 'main must retain full height')
          assert.ok(state.document.width > 100, 'document must remain readable')
          assert.ok(state.assistant.width >= (mobile ? 100 : 250), 'assistant must remain readable')
          assert.equal(state.directory.display === 'none', state.collapsed, 'directory visibility must follow toggle')
          assert.equal(state.panelOverflow.scrollWidth, state.panelOverflow.clientWidth,
            'assistant panel must not overflow horizontally')
          assert.equal(state.composerOverflow.scrollWidth, state.composerOverflow.clientWidth,
            'composer must not overflow horizontally')
          assert.ok(state.modeStatus.width >= 40, 'mode status must stay on one line')
          assert.ok(state.sendButton.right <= state.assistant.right + 1,
            'send button must stay inside the assistant panel')
          // 文书起草：对话块既不能溢出助手面板，也不能压住输入卡片。
          assert.ok(state.conversation.height >= 120,
            `conversation must keep a usable height, got ${state.conversation.height}`)
          assert.ok(state.conversation.bottom <= state.inputCard.top + 1,
            `conversation must not overlap the input card, got ${state.conversation.bottom} vs ${state.inputCard.top}`)
          assert.ok(state.conversation.bottom <= state.assistant.bottom + 1,
            'conversation must stay inside the assistant panel')
          assert.ok(state.inputCard.bottom <= state.assistant.bottom + 1,
            'input card must stay inside the assistant panel')
          assert.equal(state.conversationOverflow.scrollWidth, state.conversationOverflow.clientWidth,
            'conversation must not overflow horizontally')
          // 文书起草与案件沟通共用同一纵向节奏：顶部对齐、对话块与输入块间距一致。
          const caseTopGap = state.caseHead.top - state.probeCaseBody.top
          const docTopGap = state.probeDocConversation.top - state.probeDocBody.top
          assert.ok(Math.abs(docTopGap - caseTopGap) <= 1,
            `document conversation top must align with the case header block, got ${docTopGap} vs ${caseTopGap}`)
          const caseBottomGap = state.caseComposer.top - state.caseBody.bottom
          const docBottomGap = state.probeDocInput.top - state.probeDocConversation.bottom
          assert.ok(Math.abs(docBottomGap - caseBottomGap) <= 1,
            `document conversation gap must match the case mode gap, got ${docBottomGap} vs ${caseBottomGap}`)
          // 两种模式的输入块等高，切换模式时对话区不会被顶起或压扁。
          assert.ok(Math.abs(state.caseComposer.height - state.probeDocInput.height) <= 1,
            `document input block must keep the same height as the case input block, got ${state.probeDocInput.height} vs ${state.caseComposer.height}`)
          // 案件助手面板：最小宽度保证文字与按钮不换行；左框折叠按钮可见且不越界。
          const expectedInsightWidth = state.viewport >= 1200 ? 400 : 330
          assert.ok(state.assistant.width >= expectedInsightWidth,
            `assistant panel must keep a readable width, got ${state.assistant.width} at ${state.viewport}`)
          assert.ok(state.collapseButton.width > 0 && state.collapseButton.height > 0,
            'collapse button must be visible on the assistant left frame')
          assert.ok(state.collapseButton.left >= state.assistant.left - 1,
            'collapse button must stay attached to the assistant left frame')
          assert.ok(state.collapseButton.right <= state.assistant.right + 1,
            'collapse button must stay inside the assistant panel')
        } catch (error) {
          failures.push({ width, step, state, error: error.message })
        }
        if (step < 8) await window.webContents.executeJavaScript("document.querySelector('button').click()")
      }
    }
    process.stdout.write(`${JSON.stringify({ checks: 98, failures }, null, 2)}\n`)
    app.exit(failures.length ? 1 : 0)
  } catch (error) {
    process.stderr.write(`${error.stack}\n`)
    app.exit(1)
  }
})
