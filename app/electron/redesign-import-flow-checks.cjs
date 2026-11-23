const assert = require('node:assert/strict')

module.exports = async function checkImportFlow({ evaluate, wait, clickText, screenshot, verification, saved }) {
  const upload = async names => {
    await clickText('.add-mat', '导入材料或文书')
    await wait("document.querySelector('.new-upload')")
    await evaluate(`(() => {
      const input = document.querySelector('input[aria-label="上传已撰写文书"]')
      const files = new DataTransfer()
      for (const name of ${JSON.stringify(names)}) files.items.add(new File(['民事起诉状\\n借款已经交付。'], name + '.txt', { type: 'text/plain' }))
      input.files = files.files
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })()`)
    await wait("document.querySelector('.upload-actions button:not(:disabled)')")
    await clickText('.upload-actions button', '导入并核验')
  }
  const finish = async () => {
    await wait("document.querySelector('#pg-proc .ppct')?.textContent.includes('核验完成')")
    assert.equal(await evaluate("document.querySelectorAll('#pg-proc .pst.done').length"), 7)
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
  console.log('PASS shared import progress, partial import retry without duplicates and parsing cancellation')
}
