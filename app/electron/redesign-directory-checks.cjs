const assert = require('node:assert/strict')

module.exports = async function checkDirectory({ evaluate, wait, clickText, saved, linkedDirectory, fs, path, setDeleteFailure }) {
  const name = '新版回归测试案件'
  const target = await saved(state => state.cases.find(item => item.name === name).id)
  const originals = path.join(linkedDirectory, '..', '原材料')
  const originalFile = path.join(originals, '子目录', '子目录材料.txt')
  const configPath = path.join(linkedDirectory, '..', 'electron-profile', 'case-directories.json')
  const links = () => Object.entries(JSON.parse(fs.readFileSync(configPath, 'utf8')))
    .find(([key]) => JSON.parse(key)[1] === target)?.[1] ?? []
  assert.ok(links().some(item => item.path === originals))

  await clickText('.add-mat', '导入材料或文书')
  await wait("document.querySelector('.new-upload')")
  const buttons = await evaluate("[...document.querySelectorAll('.new-upload button')].map(button => button.textContent.trim())")
  for (const label of ['管理本地材料链接', '立即同步', '解除链接']) assert.ok(!buttons.includes(label), `应移除「${label}」入口`)
  await clickText('.new-upload [data-slot=dialog-close]', 'Close')
  await wait("!document.querySelector('.new-upload')")
  fs.writeFileSync(path.join(originals, '导入后新增.txt'), '只留在本机的材料')
  await evaluate("window.dispatchEvent(new Event('focus'))")
  await evaluate("document.dispatchEvent(new Event('visibilitychange'))")

  await clickText('.topbar button.brand-home', 'LawVerify 首页')
  await wait("document.querySelector('#pg-home .case-delete')")
  await saved(state => {
    assert.ok(state.evidences.some(item => item.caseId === target && item.fileName === '子目录材料.txt' && item.directoryId))
    assert.ok(!state.evidences.some(item => item.caseId === target && item.fileName === '导入后新增.txt'))
  })
  setDeleteFailure(target)
  await clickText('.case-delete', `删除案件：${name}`)
  await clickText('.fm-ft button', '确认删除')
  await wait("document.querySelector('.new-error')?.textContent.includes('测试删除失败')")
  setDeleteFailure(null)
  await saved(state => assert.ok(state.cases.some(item => item.id === target)))
  assert.ok(links().length, '删除案件失败后应保留本机材料链接')

  await clickText('.new-error button', '关闭')
  await clickText('.fm-ft button', '确认删除')
  await wait(`!document.querySelector('.new-form') && !Array.from(document.querySelectorAll('.case-name')).some(item => item.textContent.includes(${JSON.stringify(name)}))`)
  await saved(state => {
    assert.ok(!state.cases.some(item => item.id === target))
    assert.ok(!state.certificates.some(item => item.caseId === target))
    assert.ok(!state.evidences.some(item => item.caseId === target))
    assert.ok(state.cases.some(item => item.id === 'qa-case'))
  })
  assert.deepEqual(links(), [], '删除案件后应解除本机材料链接')
  assert.ok(fs.existsSync(originalFile), '删除案件应保留本机材料原件')
  console.log('PASS local material management removed and links cleared only after successful case deletion')
}
