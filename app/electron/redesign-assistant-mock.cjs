const { randomUUID } = require('node:crypto')

function createAssistantMock({ readWorkspace, writeWorkspace, runWithWorkspaceAccount, account }) {
  let mutation = Promise.resolve()
  const send = (response, status, body) => {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify(body))
  }
  const readBody = async request => {
    let text = ''
    for await (const chunk of request) text += chunk.toString('utf8')
    return text.trim() ? JSON.parse(text) : {}
  }
  return async function handleAssistantMock(request, response) {
    const pathname = new URL(request.url, 'http://localhost').pathname
    if (pathname === '/api/assistant/capabilities' && request.method === 'GET') {
      send(response, 200, { models: [{ id: 'qa-model', label: '回归模型' }], voice: false })
      return true
    }
    const match = pathname.match(/^\/api\/cases\/([^/]+)\/(agent\/message|agent\/position|rebuild-memory|agent\/retry)$/)
    if (!match) return false
    const route = match[2]
    if (request.method !== (route === 'agent/position' ? 'PUT' : 'POST')) return false
    let payload
    try { payload = await readBody(request) } catch {
      send(response, 400, { error: { code: 'INVALID_BODY', message: '回归请求 JSON 无效。' } })
      return true
    }
    const action = mutation.then(() => runWithWorkspaceAccount(account, async () => {
      const workspace = await readWorkspace()
      const folder = workspace.cases.find(item => item.id === decodeURIComponent(match[1]))
      if (!folder) { send(response, 404, { error: { code: 'CASE_NOT_FOUND', message: '案件不存在。' } }); return }
      folder.agent ??= { messages: [], autoAnalyze: true }
      const agent = folder.agent
      const now = new Date().toISOString()
      let extra = {}
      if (route === 'agent/message') {
        if (typeof payload.message !== 'string' || !payload.message.trim() || !['position', 'question'].includes(payload.intent)) {
          send(response, 400, { error: { code: 'INVALID_MESSAGE', message: '案件助手消息无效。' } })
          return
        }
        const reply = '案件助手回归回复'
        agent.messages ??= []
        agent.messages.push({ id: randomUUID(), role: 'user', content: payload.message.trim(), createdAt: now },
          { id: randomUUID(), role: 'assistant', content: reply, createdAt: now })
        extra = { reply, positionVersion: agent.position?.version ?? 0 }
        if (payload.intent === 'position') {
          extra.proposal = { party: '测试原告', role: 'plaintiff', goals: ['追偿本金'], admissions: [], disputes: [], boundaries: [] }
        }
      } else if (route === 'agent/position') {
        if (payload.expectedVersion !== (agent.position?.version ?? 0)) {
          send(response, 409, { error: { code: 'POSITION_CONFLICT', message: '代理立场已有更新，请刷新后重试。' } })
          return
        }
        if (!payload.position?.party?.trim() || !Array.isArray(payload.position.goals) || !payload.position.goals.length) {
          send(response, 400, { error: { code: 'INVALID_POSITION', message: '请填写当事人和办案目标。' } })
          return
        }
        agent.position = { ...payload.position, version: (agent.position?.version ?? 0) + 1, confirmedAt: now }
        agent.task = { revision: (agent.task?.revision ?? 0) + 1, status: 'ready', stage: '回归分析完成', evidenceIds: [] }
      } else if (route === 'rebuild-memory') {
        workspace.caseContextMemories ??= []
        const previous = workspace.caseContextMemories.find(item => item.caseId === folder.id)
        const memory = { ...previous, id: previous?.id ?? randomUUID(), caseId: folder.id, version: (previous?.version ?? 0) + 1,
          summary: '案件助手记忆回归摘要', updatedAt: now }
        for (const field of ['parties', 'disputeFocuses', 'claimsAndDefenses', 'disputedFacts', 'timeline', 'paymentFlow', 'keyPersons', 'keyAmounts',
          'lawyerFocuses', 'evidenceWeaknesses', 'proceduralRisks', 'contradictions', 'openQuestions', 'supportMatrix', 'evidenceInsightIds']) {
          memory[field] ??= []
        }
        workspace.caseContextMemories = workspace.caseContextMemories.filter(item => item.caseId !== folder.id)
        workspace.caseContextMemories.push(memory)
      } else {
        // 未传 autoAnalyze 的重试应保留目录同步及助手当前的自动分析开关。
        if (typeof payload.autoAnalyze === 'boolean') agent.autoAnalyze = payload.autoAnalyze
        agent.task = { revision: (agent.task?.revision ?? 0) + 1, status: 'ready', stage: '回归分析完成', evidenceIds: [] }
      }
      await writeWorkspace(workspace)
      send(response, 200, { workspace, ...extra })
    }))
    mutation = action.catch(() => {})
    try { await action } catch (cause) {
      send(response, 500, { error: { code: 'ASSISTANT_MOCK_FAILED', message: cause instanceof Error ? cause.message : '案件助手回归模拟失败。' } })
    }
    return true
  }
}

module.exports = { createAssistantMock }
