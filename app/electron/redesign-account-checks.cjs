const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')

module.exports = async function checkAccount({ evaluate, wait, clickText, fill, screenshot, window, setAccountStatus }) {
  await wait("document.querySelector('#pg-home .case-card') && document.querySelector('.dock-ava')")
  const dockPoint = await evaluate(`(() => {
    const dock = document.querySelector('.dock-ava');
    const {left, top, width, height} = dock.getBoundingClientRect();
    return {x: Math.round(left + width / 2), y: Math.round(top + height / 2)};
  })()`)
  window.webContents.sendInputEvent({ type: 'mouseMove', ...dockPoint })
  await new Promise(resolve => setTimeout(resolve, 200))
  assert.equal(await evaluate("document.querySelector('.new-dock-menu')?.checkVisibility() ?? false"), false, '账号入口不应展开库菜单')
  await evaluate("document.querySelector('.dock-ava').click()")
  await wait("document.querySelector('#pg-account h1')?.textContent === '账号设置'")
  assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('.account-settings-section h2'), heading => heading.textContent)"), ['基本资料', '登录邮箱', '修改密码'])
  assert.equal(await evaluate("document.querySelector('#account-login-email').value"), 'redesign-qa@test.invalid')
  assert.equal(await evaluate("document.querySelector('#account-login-email').readOnly"), true)
  assert.equal(await evaluate("document.querySelector('#account-display-name').value === document.querySelector('.account-settings-identity strong').textContent"), true)
  await wait("document.querySelector('.account-settings-credits strong')?.textContent === '2,468'")
  await screenshot('account-settings')
  const desktopSize = window.getSize()
  window.setSize(390, 900)
  await wait("innerWidth <= 390 && document.querySelector('#pg-account main').scrollWidth <= document.querySelector('#pg-account main').clientWidth")
  await screenshot('account-settings-390')
  window.setSize(...desktopSize)
  await wait("innerWidth > 880")
  await wait("!document.querySelector('#account-display-name').readOnly")
  await fill('#account-display-name', '账号设置回归律师')
  await fill('#account-profile-heading + form label:nth-child(2) input', '账号设置回归律所')
  await clickText('.account-settings-actions button', '保存资料')
  await wait("document.querySelector('.account-settings-identity strong')?.textContent === '账号设置回归律师'")
  assert.equal(await evaluate("document.querySelector('#account-profile-heading + form label:nth-child(2) input').value"), '账号设置回归律所')

  await evaluate("window.__beforePasswordChange = [sessionStorage.getItem('lawverify-auth-session'), localStorage.getItem('lawverify-cloud-token')]")
  const passwordFields = '#account-password-heading + form input'
  const replacement = randomUUID()
  await fill(`${passwordFields}[autocomplete="current-password"]`, randomUUID())
  await fill(`#account-password-heading + form label:nth-child(2) input`, replacement)
  await fill(`#account-password-heading + form label:nth-child(3) input`, replacement)
  await clickText('.account-settings-actions button', '修改密码')
  await wait("localStorage.getItem('lawverify-cloud-token') !== window.__beforePasswordChange[1] && !document.querySelector('#account-password-heading + form input').value")
  await evaluate("window.dispatchEvent(new Event('focus'))")
  await wait("document.querySelector('.toast')?.textContent === '密码已修改。'")
  assert.equal(await evaluate("Boolean(document.querySelector('#pg-account')) && sessionStorage.getItem('lawverify-auth-session') === window.__beforePasswordChange[0]"), true)
  await evaluate("document.querySelector('.account-settings-services summary').click()")
  await wait("document.querySelector('.account-services-balance strong')?.textContent === '2,468'")
  assert.match(await evaluate("document.querySelector('.account-services-points').textContent"), /回归充值/)
  await clickText('.account-services-points button', '查看积分流水')
  await wait("document.querySelector('.account-services-ledger-dialog')")
  assert.match(await evaluate("document.querySelector('.account-services-ledger-dialog').textContent"), /回归充值/)
  await evaluate("document.querySelector('[data-slot=dialog-close]').click()")

  // 测试桥仅记录充值地址，不会打开浏览器或执行支付。
  await clickText('.account-services-points button', '前往充值')
  await wait("!Array.from(document.querySelectorAll('.account-services-points button')).some(button => button.textContent === '正在打开…')")
  const opened = await evaluate('window.__accountOpenedUrl || null')
  if (opened) {
    const url = new URL(opened)
    assert.equal(url.pathname, '/console/billing')
    assert.equal(url.searchParams.get('desktopToken'), await evaluate("localStorage.getItem('lawverify-cloud-token')"))
  }

  await evaluate(`(() => {
    window.__accountOriginalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.__accountCopied = text } } })
  })()`)
  try {
    await clickText('.account-services button', '复制邀请码')
    await wait("window.__accountCopied === 'QA2026'")
    await clickText('.account-services button', '复制邀请链接')
    await wait("window.__accountCopied?.includes('invite=QA2026')")
  } finally {
    await evaluate(`(() => {
      if (window.__accountOriginalClipboard) Object.defineProperty(navigator, 'clipboard', window.__accountOriginalClipboard)
      else delete navigator.clipboard
      delete window.__accountOriginalClipboard
    })()`)
  }

  await clickText('.account-services-feedback button', '提交反馈')
  await wait("document.querySelector('.account-services-form')")
  await clickText('.account-services-form button', '提交反馈')
  await wait("document.querySelector('.account-services-form [role=alert]')?.textContent.includes('标题')")
  await fill('.account-services-form input', '新版账号回归反馈')
  await fill('.account-services-form textarea', '过短')
  await clickText('.account-services-form button', '提交反馈')
  await wait("document.querySelector('.account-services-form [role=alert]')?.textContent.includes('10')")
  await fill('.account-services-form textarea', '这是一条仅发送至本地测试桥的反馈内容。')
  await screenshot('account-feedback')
  await clickText('.account-services-form button', '提交反馈')
  await wait("!document.querySelector('.account-services-form')")
  await clickText('.account-services-feedback button', '提交反馈')
  await wait("document.querySelector('.account-services-form')")
  assert.equal(await evaluate("document.querySelector('.account-services-form input').value"), '')
  assert.equal(await evaluate("document.querySelector('.account-services-form textarea').value"), '')
  await clickText('.account-services-form button', '关闭')

  // 临时模拟非认证错误，最近一次成功余额和流水应保留。
  setAccountStatus(503)
  try {
    await clickText('.account-services-points button', '刷新')
    await wait("document.querySelector('.account-services-points [role=alert]')")
    assert.equal(await evaluate("document.querySelector('.account-services-balance strong').textContent"), '2,468')
    assert.match(await evaluate("document.querySelector('.account-services-points').textContent"), /回归充值/)
  } finally { setAccountStatus(0) }
  await evaluate("window.dispatchEvent(new Event('lawverify-points-changed'))")
  await wait("!document.querySelector('.account-services-points [role=alert]') && !Array.from(document.querySelectorAll('.account-services-points button')).some(button => button.textContent === '同步中…')")
  await evaluate("window.dispatchEvent(new Event('focus'))")
  await wait("!Array.from(document.querySelectorAll('.account-services-points button')).some(button => button.textContent === '同步中…')")
  await screenshot('account-services')
  await clickText('#pg-account .topbar button', '返回首页')
  await wait("document.querySelector('#pg-home .case-card')")
  assert.equal(await evaluate("document.querySelector('.dock-ava b').textContent"), '账号设置回归律师')
}
