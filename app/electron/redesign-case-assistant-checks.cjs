const assert = require('node:assert/strict')

module.exports = async function checkCaseAssistant({ evaluate, wait, clickText, fill, screenshot, saved, writeWorkspace, reload, enter }) {
  const caseName = await saved(async state => {
    const folder = state.cases.find(item => item.id === 'qa-case')
    assert.ok(folder, '案件助手回归需要 qa-case')
    folder.agent = { autoAnalyze: true, messages: [] }
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
  await clickText('.case-memory-card button', '设置立场')
  await wait("document.querySelector('.workspace-ai-hello')?.textContent.includes('说明代理哪一方、希望达成什么目标')")
  await send('我代理原告测试原告，要求追偿本金。')
  await wait("document.querySelector('.case-assistant-proposal')")
  await fill('.case-assistant-proposal input', '编辑后的代理当事人')
  await fill('.case-assistant-proposal textarea', '追偿本金及利息\n申请财产保全')
  await clickText('.case-assistant-proposal button', '确认代理立场')
  await ready()
  await wait("!document.querySelector('.case-assistant-proposal')")
  await saved(state => {
    const position = state.cases.find(item => item.id === 'qa-case').agent.position
    assert.equal(position.party, '编辑后的代理当事人')
    assert.deepEqual(position.goals, ['追偿本金及利息', '申请财产保全'])
  })
  assert.equal(await evaluate("document.querySelectorAll('.workspace-ai-modes button[aria-pressed=true], .workspace-ai-more[data-active]').length"), 0)
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
  await clickText('.workspace-doc-strip button', 'AI 助手')
  await ready()
  assert.equal(await evaluate("document.querySelectorAll('.case-assistant-message').length"), 10, '完整显示全部历史对话')
  assert.doesNotMatch(await evaluate("document.querySelector('.workspace-ai-panel').textContent"), /语音|Skills|默认模型|代理设置与案件记忆/)
  if (screenshot) await screenshot('case-assistant')
}

