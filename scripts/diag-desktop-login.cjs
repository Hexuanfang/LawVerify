// 临时诊断脚本：通过 CDP 进入正在运行的 LawVerify 渲染进程，复现登录请求并抓取真实错误
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
  let page = null
  for (let i = 0; i < 30; i++) {
    try {
      const targets = await getTargets()
      page = targets.find((t) => t.type === 'page' && /127\.0\.0\.1:\d+/.test(t.url))
      if (page) break
    } catch {}
    await new Promise((r) => setTimeout(r, 1000))
  }

  if (!page) {
    console.log('NO_PAGE_TARGET')
    process.exit(1)
  }

  console.log('PAGE_URL:', page.url)
  const ws = await connect(page.webSocketDebuggerUrl)
  await send(ws, 'Runtime.enable', {})

  const expr = `(async () => {
    const out = {
      href: location.href,
      origin: location.origin,
      online: navigator.onLine,
      desktopChannel: (window.lawVerifyDesktop && window.lawVerifyDesktop.channel) || null,
    }
    const payload = JSON.stringify({ email: '972167580@qq.com', password: '123456' })
    try {
      const r = await fetch('/api/cloud/api/account/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-cloud-base-url': 'https://lawagent.zhijing.fun' },
        body: payload,
      })
      out.localStatus = r.status
      out.localBodyHead = (await r.text()).slice(0, 200)
    } catch (e) {
      out.localError = { name: e.name, message: e.message, cause: e.cause ? String(e.cause) : null }
    }
    try {
      const r2 = await fetch('https://lawagent.zhijing.fun/api/web/site/config', { method: 'GET', mode: 'no-cors' })
      out.directType = r2.type
    } catch (e2) {
      out.directError = { name: e2.name, message: e2.message, cause: e2.cause ? String(e2.cause) : null }
    }
    return JSON.stringify(out)
  })()`

  const result = await send(ws, 'Runtime.evaluate', {
    expression: expr,
    awaitPromise: true,
    returnByValue: true,
  })
  console.log('RESULT:', result.result.value)
  process.exit(0)
})().catch((e) => {
  console.error('FAIL', e)
  process.exit(1)
})
