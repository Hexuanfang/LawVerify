// 查询当前 LawVerify 页面真实状态：是否已登录、是否有报错、session 是否存在
const CDP_PORT = 9222

async function getTargets() {
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)
  return res.json()
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    ws.onopen = () => resolve(ws)
    ws.onerror = reject
  })
}

let msgId = 0
function send(ws, method, params) {
  const id = ++msgId
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      const data = JSON.parse(event.data)
      if (data.id === id) {
        ws.removeEventListener('message', onMessage)
        if (data.error) reject(new Error(data.error.message))
        else resolve(data.result)
      }
    }
    ws.addEventListener('message', onMessage)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

;(async () => {
  const targets = await getTargets()
  const page = targets.find((t) => t.type === 'page' && /127\.0\.0\.1:\d+/.test(t.url))
  if (!page) {
    console.log('NO_PAGE_TARGET')
    process.exit(1)
  }
  const ws = await connect(page.webSocketDebuggerUrl)
  await send(ws, 'Runtime.enable', {})

  const expr = `(() => {
    const out = {
      href: location.href,
      hasPasswordInput: !!document.querySelector('input[type="password"]'),
      sessionKeys: Object.keys(sessionStorage),
      cloudSession: sessionStorage.getItem('lexverify.cloud.session') ? 'present' : 'absent',
      workspaceSession: sessionStorage.getItem('lexverify.workspace.session') ? 'present' : 'absent',
      errorText: Array.from(document.querySelectorAll('*'))
        .filter((el) => el.children.length === 0 && /无法连接|错误|失败/.test(el.innerText || ''))
        .map((el) => el.innerText.trim()).slice(0, 5),
      bodyHead: document.body.innerText.slice(0, 400),
    }
    return JSON.stringify(out)
  })()`

  const result = await send(ws, 'Runtime.evaluate', { expression: expr, returnByValue: true })
  console.log('STATE:', result.result.value)
  process.exit(0)
})().catch((e) => {
  console.error('FAIL', e)
  process.exit(1)
})
