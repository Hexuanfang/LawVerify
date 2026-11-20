const assert = require('node:assert/strict')

module.exports = async function checkImportFlow({ evaluate, wait, clickText, screenshot, verification, saved }) {
  const upload = async (names, verify = true) => {
    await clickText('.add-doc', '导入待核验文书')
    await wait("document.querySelector('.new-upload')")
    await evaluate(`(() => {
      const input = document.querySelector('input[aria-label="上传已撰写文书"]')
      const files = new DataTransfer()
      for (const name of ${JSON.stringify(names)}) files.items.add(new File(['借款已经交付。'], name + '.txt', { type: 'text/plain' }))
      input.files = files.files
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })()`)
    await clickText('.upload-actions button', verify ? '导入并核验' : '仅导入文书')
  }
  const finish = async () => {
    await wait("document.querySelector('#pg-proc .ppct')?.textContent.includes('核验完成')")
    assert.equal(await evaluate("document.querySelectorAll('#pg-proc .pst.done').length"), 6)
    await clickText('.proc-actions button', '查看核验结果')
    await wait("document.querySelector('#pg-ws')")
  }
  verification.parseCalls = 0
  verification.parseFailAt = 2
  verification.importDelay = 300
  verification.failNext = 0
  verification.holdAt = 0
  const before = verification.calls.length
  await upload(['解析失败甲', '解析失败乙'])
  await wait("document.querySelector('#pg-proc .ppct')?.textContent.includes('文书导入未完成')")
  assert.equal(verification.calls.length, before, '导入失败时不能提前开始核验')
  await saved(state => {
    assert.equal(state.certificates.filter(item => item.title === '解析失败甲').length, 1)
    assert.equal(state.certificates.filter(item => item.title === '解析失败乙').length, 0)
  })
  await screenshot('upload-verification-failed')
  await clickText('.proc-actions button', '重试')
  await finish()
  assert.equal(verification.parseCalls, 3, '导入重试应跳过已导入的第一份文书')
  await saved(state => {
    assert.equal(state.certificates.filter(item => item.title === '解析失败甲').length, 1)
    assert.equal(state.certificates.filter(item => item.title === '解析失败乙').length, 1)
  })
  verification.parseCalls = 0
  verification.parseFailAt = 0
  verification.importDelay = 1000
  await upload(['解析中取消'])
  await wait("document.querySelector('#pg-proc .ppct')?.textContent.includes('正在解析文书')")
  const deadline = Date.now() + 5000
  while (!verification.parseCalls && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal(verification.parseCalls, 1)
  await clickText('.proc-actions button', '取消核验')
  await wait("document.querySelector('#pg-proc .ppct')?.textContent.includes('文书导入已取消')")
  await saved(state => assert.equal(state.certificates.filter(item => item.title === '解析中取消').length, 0))
  verification.importDelay = 100
  await clickText('.proc-actions button', '重试')
  await finish()
  await saved(state => assert.equal(state.certificates.filter(item => item.title === '解析中取消').length, 1))
  verification.parseCalls = 0
  verification.parseFailAt = 0
  verification.importDelay = 700
  const verificationCount = verification.calls.length
  await upload(['仅导入反馈'], false)
  await wait("document.querySelector('.new-upload[aria-busy=true] .upload-import-feedback .import-spinner')")
  await wait("document.querySelector('.upload-import-feedback')?.textContent.includes('仅导入反馈.txt')")
  assert.equal(await evaluate("Array.from(document.querySelectorAll('.upload-actions button')).every(button => button.disabled)"), true)
  assert.equal(await evaluate("Boolean(document.querySelector('.new-upload [data-slot=dialog-close]'))"), false)
  assert.match(await evaluate("document.querySelector('.upload-actions button').textContent"), /正在导入/)
  await screenshot('import-only-loading')
  await wait("document.querySelector('#pg-ws') && !document.querySelector('.new-upload')")
  assert.equal(verification.calls.length, verificationCount, '仅导入不能触发证据核验')
  await saved(state => assert.equal(state.certificates.filter(item => item.title === '仅导入反馈').length, 1))
  verification.parseCalls = 0
  verification.parseFailAt = 1
  await upload(['仅导入失败重试'], false)
  await wait("document.querySelector('.new-error') && !document.querySelector('.upload-import-feedback')")
  assert.equal(await evaluate("document.querySelector('.upload-actions button').disabled"), false, '失败后恢复按钮以便重试')
  await clickText('.upload-actions button', '仅导入文书')
  await wait("document.querySelector('#pg-ws') && !document.querySelector('.new-upload')")
  await saved(state => assert.equal(state.certificates.filter(item => item.title === '仅导入失败重试').length, 1))
  verification.importDelay = 100
  console.log('PASS import-only immediate feedback, loading state and failure retry')
  console.log('PASS shared import progress, partial import retry without duplicates and parsing cancellation')
}
