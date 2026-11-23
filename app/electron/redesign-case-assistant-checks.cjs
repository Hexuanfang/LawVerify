const assert = require('node:assert/strict')

module.exports = async function checkCaseAssistant({ evaluate, wait, clickText, fill, screenshot, saved, writeWorkspace, reload, enter }) {
  const caseName = await saved(async state => {
    const folder = state.cases.find(item => item.id === 'qa-case')
    assert.ok(folder, '案件助手回归需要 qa-case')
    folder.basicInfo = { plaintiff: '测试原告', defendant: '测试被告', ourSide: 'defendant' }
    folder.agent = { autoAnalyze: true, messages: [
      { id: 'qa-prior-question', role: 'user', content: '请概括本案案情。', createdAt: new Date().toISOString() },
    ] }
    await writeWorkspace(state)
    return folder.name
  })
  const ready = () => wait("document.querySelector('.workspace-ai-panel')?.getAttribute('aria-busy')==='false'")
  const send = async text => {
    await fill('.assistant-composer textarea', text)
    await clickText('.assistant-composer button', '发送')
    await ready()
  }
  await reload()
  await enter(caseName)
  await clickText('.topbar button', '案件记忆')
  await wait("document.querySelector('.case-memory-card')")
  await clickText('.case-memory-card button', '填写立场')
  await wait("document.querySelector('.case-position-dialog textarea')")
  assert.equal(await evaluate("Boolean(document.querySelector('.workspace-ai-panel'))"), false, '填写立场不打开 AI 助手')
  assert.equal(await evaluate("document.querySelector('.case-position-dialog input').value"), '测试被告')
  if (screenshot) await screenshot('case-position-dialog')
  const stance = '核对本金及利息\n申请财产保全\n\n写作约束：\n只引用卷内证据'
  await fill('.case-position-dialog textarea', stance)
  await clickText('.case-position-dialog button', '保存代理立场')
  await wait("!document.querySelector('.case-position-dialog') && document.querySelector('.case-memory-content')?.textContent.includes('只引用卷内证据')")
  await saved(state => {
    const agent = state.cases.find(item => item.id === 'qa-case').agent
    assert.equal(agent.position.party, '测试被告')
    assert.equal(agent.position.role, 'defendant')
    assert.deepEqual(agent.position.goals, ['核对本金及利息', '申请财产保全'])
    assert.deepEqual(agent.position.boundaries, ['只引用卷内证据'])
    assert.equal(agent.messages.length, 1, '手动保存不应产生 AI 对话')
  })
  await reload()
  await enter(caseName)
  await clickText('.topbar button', '案件记忆')
  await wait("document.querySelector('.case-memory-card')")
  await clickText('.case-memory-card button', '编辑立场')
  assert.equal(await evaluate("document.querySelector('.case-position-dialog textarea').value"), stance)
  await fill('.case-position-dialog textarea', '取消这次编辑')
  await clickText('.case-position-dialog button', '取消')
  await wait("!document.querySelector('.case-position-dialog')")
  assert.equal(await evaluate("document.querySelector('.case-memory-content').textContent.includes('取消这次编辑')"), false)
  await clickText('.case-memory-card button', '编辑立场')
  await fill('.case-position-dialog textarea', `${stance}\n保留银行流水引用`)
  await clickText('.case-position-dialog button', '保存代理立场')
  await wait("!document.querySelector('.case-position-dialog') && document.querySelector('.case-memory-content')?.textContent.includes('保留银行流水引用')")
  await saved(state => assert.equal(state.cases.find(item => item.id === 'qa-case').agent.position.version, 2))
  await clickText('.case-memory-card button', '✍️按立场起草')
  await ready()
  assert.equal(await evaluate("document.querySelector('.workspace-ai-card[data-mode=document]').getAttribute('aria-pressed')"), 'true')
  await clickText('.workspace-ai-header button', '关闭 AI 助手')
  await clickText('.topbar button', '案件记忆')
  await wait("document.querySelector('.case-memory-card')")
  await clickText('.case-memory-card button', '追问本案')
  await ready()
  await send('请分析借款交付的证据。')
  await wait("document.querySelector('.case-assistant-history')?.textContent.includes('请分析借款交付的证据。')")
  await saved(async state => {
    const folder = state.cases.find(item => item.id === 'qa-case')
    folder.agent.messages = Array.from({ length: 10 }, (_, index) => ({
      id: 'qa-history-' + index, role: index % 2 ? 'assistant' : 'user', content: '历史对话第' + index + '条', createdAt: new Date().toISOString(),
    }))
    await writeWorkspace(state)
  })
  await reload()
  await enter(caseName)
  await clickText('.workspace-right-tablist [role=tab]', 'AI 助手')
  await ready()
  assert.equal(await evaluate("document.querySelectorAll('.case-assistant-message').length"), 10, '完整显示全部历史对话')
  assert.doesNotMatch(await evaluate("document.querySelector('.workspace-ai-panel').textContent"), /语音|Skills|默认模型|代理设置与案件记忆/)
  if (screenshot) await screenshot('case-assistant')
}

