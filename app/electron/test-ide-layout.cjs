const { app, BrowserWindow } = require('electron')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')

// Exercise the production styles without logging in or touching case data.
const source = path.resolve(__dirname, '../src')
const css = ['index.css', 'App.css'].map(file => readFileSync(path.join(source, file), 'utf8')).join('\n')
const html = `<!doctype html><html><head><style>${css}</style></head><body>
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
        <div class="ide-insight-tabs"><button class="active">助手</button></div>
        <div class="streamlined-insight-content ide-assistant-content">
          <div class="ide-assistant-view">
            <div class="agent-dock ide-agent-panel is-open">
              <div class="agent-dock-card">
                <div class="agent-dock-body">
                  <div class="assistant-mode-row">
                    <div class="assistant-picker"><button class="assistant-control" type="button"><span>文书起草</span></button></div>
                  </div>
                  <div class="agent-input-shell agent-dock-input-shell">
                    <textarea class="agent-dock-prompt-input" placeholder="描述文书类型与起草要求…"></textarea>
                    <div class="agent-dock-submit-area">
                      <div class="agent-dock-composer-meta"><span>请选择证据</span><span class="agent-dock-cost">预计 <b>15</b> 积分</span></div>
                      <div class="agent-composer-actions">
                        <div class="assistant-picker"><button class="assistant-control" type="button"><span>默认模型</span></button></div>
                        <button class="assistant-voice" type="button">语音</button>
                        <button class="agent-dock-clear" type="button">清空</button>
                        <button class="agent-dock-submit" type="button">开始生成</button>
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
</div><script>
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
              const box = element.getBoundingClientRect();
              return { x: box.x, y: box.y, width: box.width, height: box.height,
                right: box.right, display: getComputedStyle(element).display };
            };
            const overflow = selector => {
              const element = document.querySelector(selector);
              return { scrollWidth: element.scrollWidth, clientWidth: element.clientWidth };
            };
            resolve({ viewport: innerWidth, collapsed: document.querySelector('.ide-shell')
              .classList.contains('streamlined-shell-sidebar-collapsed'),
              main: rect('main'), directory: rect('.streamlined-sidebar'),
              document: rect('.streamlined-document-panel'),
              assistant: rect('.streamlined-insight-panel'),
              panelOverflow: overflow('.streamlined-insight-panel'),
              composerOverflow: overflow('.agent-dock-submit-area'),
              composerMeta: rect('.agent-dock-composer-meta'),
              submitButton: rect('.agent-dock-submit') });
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
          assert.ok(state.composerMeta.width >= 40, 'composer meta must stay on one line')
          assert.ok(state.submitButton.right <= state.assistant.right + 1,
            'submit button must stay inside the assistant panel')
        } catch (error) {
          failures.push({ width, step, state, error: error.message })
        }
        if (step < 8) await window.webContents.executeJavaScript("document.querySelector('button').click()")
      }
    }
    process.stdout.write(`${JSON.stringify({ checks: 63, failures }, null, 2)}\n`)
    app.exit(failures.length ? 1 : 0)
  } catch (error) {
    process.stderr.write(`${error.stack}\n`)
    app.exit(1)
  }
})
