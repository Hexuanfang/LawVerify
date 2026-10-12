// 端到端验证：在运行中的 LawVerify 窗口里真实填写登录表单并点击登录按钮，读取最终界面状态
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
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    function setReactValue(el, value) {
      const proto = Object.getPrototypeOf(el)
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
      setter.call(el, value)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }

    const passwordInput = document.querySelector('input[type="password"]')
    const emailInput = Array.from(document.querySelectorAll('input'))
      .find((el) => el !== passwordInput && (el.type === 'email' || el.type === 'text' || el.type === ''))

    if (!emailInput || !passwordInput) {
      return JSON.stringify({ step: 'fill', error: 'login inputs not found', html: document.body.innerText.slice(0, 300) })
    }

    setReactValue(emailInput, '972167580@qq.com')
    setReactValue(passwordInput, '123456')
    await sleep(300)

    const buttons = Array.from(document.querySelectorAll('button'))
    const submit = buttons.find((b) => /进入系统|登录/.test(b.innerText) && !/注册|前往/.test(b.innerText))
    if (!submit) {
      return JSON.stringify({ step: 'click', error: 'submit button not found', buttons: buttons.map((b) => b.innerText) })
    }

    submit.click()

    for (let i = 0; i < 20; i++) {
      await sleep(500)
      const text = document.body.innerText
      if (/无法连接|错误|失败/.test(text)) {
        const errEl = Array.from(document.querySelectorAll('*'))
          .filter((el) => el.children.length === 0 && /无法连接|错误|失败/.test(el.innerText))
          .map((el) => el.innerText.trim())
        return JSON.stringify({ step: 'result', ok: false, errorText: errEl.slice(0, 5) })
      }
      if (!document.querySelector('input[type="password"]')) {
        return JSON.stringify({ step: 'result', ok: true, note: 'login form gone, entered system', head: text.slice(0, 200) })
      }
    }

    return JSON.stringify({ step: 'result', ok: null, note: 'no state change after 10s', head: document.body.innerText.slice(0, 300) })
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
