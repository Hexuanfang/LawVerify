const assert = require('node:assert/strict')

module.exports = async function checkAccount({ evaluate, wait, clickText, fill, screenshot, setAccountStatus }) {
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
}
