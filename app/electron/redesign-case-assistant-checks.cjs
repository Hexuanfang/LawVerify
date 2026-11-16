const assert = require('node:assert/strict')

module.exports = async function checkCaseAssistant({ evaluate, wait, clickText, fill, screenshot, saved, writeWorkspace, reload, enter }) {
  const caseName = await saved(async state => {
    const folder = state.cases.find(item => item.id === 'qa-case')
    assert.ok(folder, '案件助手回归需要 qa-case')
    folder.agent = { autoAnalyze: true, messages: [] }
    state.caseContextMemories = state.caseContextMemories.filter(item => item.caseId !== folder.id)
    state.caseContextMemories.push({ id: 'qa-assistant-memory', caseId: folder.id, version: 1,
      summary: '案件助手记忆回归摘要', parties: [], disputeFocuses: [], claimsAndDefenses: [], disputedFacts: [],
      timeline: [], paymentFlow: [], keyPersons: [], keyAmounts: [], lawyerFocuses: [], evidenceWeaknesses: [],
      proceduralRisks: [], contradictions: [], openQuestions: [], supportMatrix: [], evidenceInsightIds: [], updatedAt: new Date().toISOString() })
    await writeWorkspace(state)
    return folder.name
  })
  const open = async () => {
    await enter(caseName)
    await clickText('.workbench-assistant-tabs [role=tab]', '案件助手')
    await wait("document.querySelector('.case-assistant') && !document.querySelector('.case-assistant textarea').disabled")
  }
  const ready = () => wait("document.querySelector('.case-assistant')?.getAttribute('aria-busy')==='false'")
  const choose = async (label, text) => {
    await evaluate(`document.querySelector('.case-assistant [aria-label=${JSON.stringify(label)}]').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,pointerType:'mouse'}))`)
    await wait("document.querySelector('[role=option]')")
    await clickText('[role=option]', text)
  }
  const send = async text => {
    await fill('.case-assistant-composer textarea', text)
    await evaluate("document.querySelector('.case-assistant [aria-label=发送消息]').click()")
    await ready()
  }
  await reload(); await open()
  assert.match(await evaluate("document.querySelector('.case-assistant-memory').textContent"), /案件助手记忆回归摘要/)
  await send('我代理原告测试原告，要求追偿本金。')
  await wait("document.querySelector('.case-assistant-proposal')")
  await fill('.case-assistant-proposal input', '编辑后的代理当事人')
  await fill('.case-assistant-proposal textarea', '追偿本金及利息\n申请财产保全')
  await clickText('.case-assistant-proposal button', '确认并更新办案思路')
  await ready()
  await wait("!document.querySelector('.case-assistant-proposal')")
  await saved(state => {
    const position = state.cases.find(item => item.id === 'qa-case').agent.position
    assert.equal(position.party, '编辑后的代理当事人')
    assert.deepEqual(position.goals, ['追偿本金及利息', '申请财产保全'])
  })
  assert.match(await evaluate("document.querySelector('.case-assistant-header').textContent"), /编辑后的代理当事人/)
  await choose('选择 Agent', '证据分析')
  await choose('选择模型', '回归模型')
  await choose('选择 Skill', '补证清单')
  // Skill 单独执行也必须发送，服务端收到 evidence / qa-model / evidence_gaps。
  await evaluate("document.querySelector('.case-assistant [aria-label=发送消息]').click()")
  await ready()
  await wait("document.querySelector('.case-assistant-history')?.textContent.includes('请结合本案材料执行补证清单。')")
  await send('请分析借款交付的证据。')
  await wait("document.querySelector('.case-assistant-history')?.textContent.includes('请分析借款交付的证据。')")
  await clickText('.case-assistant-memory button', '暂停自动分析')
  await ready()
  await saved(state => assert.equal(state.cases.find(item => item.id === 'qa-case').agent.autoAnalyze, false))
  await clickText('.case-assistant-memory button', '开启自动分析')
  await ready()
  await saved(state => assert.equal(state.cases.find(item => item.id === 'qa-case').agent.autoAnalyze, true))
  await clickText('.case-assistant-memory button', '重新分析')
  await ready()
  const beforeVersion = await saved(state => state.caseContextMemories.find(item => item.caseId === 'qa-case').version)
  await clickText('.case-assistant-memory button', '重建记忆')
  await ready()
  await saved(state => assert.ok(state.caseContextMemories.find(item => item.caseId === 'qa-case').version > beforeVersion))
  // 注入已生成的策略，验证现有材料真实跳转与历史消息完整显示。
  await saved(async state => {
    const folder = state.cases.find(item => item.id === 'qa-case')
    const memory = state.caseContextMemories.find(item => item.caseId === folder.id)
    folder.agent.task = { revision: 1, status: 'ready', stage: '回归分析完成' }
    folder.agent.strategy = { inputKey: 'qa', positionVersion: folder.agent.position.version, memoryVersion: memory.version,
      summary: '回归策略摘要', claims: [{ id: 'qa-claim', claim: '请求偿还借款', status: 'needs_evidence', requirements: ['借贷合意', '款项交付'], burden: '原告',
        supportEvidenceIds: ['qa-evidence'], adverseEvidenceIds: [], gaps: ['补充借据'], counterargument: '款项性质存在争议', response: '结合双方沟通核实款项性质' }],
      nextSteps: ['核验转账原件'], warnings: ['关注诉讼时效'] }
    folder.agent.messages = Array.from({ length: 10 }, (_, index) => ({ id: 'qa-history-' + index, role: index % 2 ? 'assistant' : 'user', content: '历史对话第' + index + '条', createdAt: new Date().toISOString() }))
    await writeWorkspace(state)
  })
  await reload(); await open()
  assert.equal(await evaluate("document.querySelectorAll('.case-assistant-message').length"), 10, '完整显示全部历史对话')
  await evaluate("document.querySelector('.case-assistant-strategy details').open=true")
  assert.match(await evaluate("document.querySelector('.case-assistant-strategy').textContent"), /补充借据/)
  await evaluate("document.querySelector('.case-assistant-strategy .case-assistant-actions button').click()")
  await wait("document.querySelector('.new-drawer')")
  assert.match(await evaluate("document.querySelector('.new-drawer').textContent"), /流水/)
  await clickText('[data-slot=sheet-content] button', 'Close')
  await wait("!document.querySelector('.new-drawer')")
  if (screenshot) await screenshot('case-assistant')
}

