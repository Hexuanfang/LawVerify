const { randomUUID } = require('node:crypto')

function createDocumentMock({ readWorkspace, writeWorkspace, runWithWorkspaceAccount, account }) {
  const requests = []
  let scenario = 'success'
  return {
    requests,
    setScenario: value => { scenario = value },
    async handle(request, response) {
      const pathname = new URL(request.url, 'http://localhost').pathname
      const rewrite = pathname.match(/^\/api\/certificates\/([^/]+)\/rewrite\/stream$/)
      if (request.method !== 'POST' || (!rewrite && pathname !== '/api/certificates/generate/stream')) return false
      let raw = ''
      for await (const chunk of request) raw += chunk.toString('utf8')
      const payload = JSON.parse(raw)
      const state = await runWithWorkspaceAccount(account, readWorkspace)
      const original = rewrite ? state.certificates.find(item => item.id === rewrite[1]) : null
      requests.push({ payload, original: original && structuredClone(original), mode: rewrite ? 'rewrite' : 'generate' })
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      const send = (event, body) => response.write(`event: ${event}\ndata: ${JSON.stringify(body)}\n\n`)
      const title = rewrite ? '回归改写文书' : '回归AI起草文书'
      send('meta', { title })
      if (scenario === 'failure') {
        send('error', { message: '模拟模型生成失败' })
        response.end()
        return true
      }
      const text = scenario === 'interrupt' ? '中断前已经生成的正文。' : rewrite ? '已按要求修改后的正文。' : 'AI起草正文，借款已经交付。'
      send('paragraph', { index: 0, text, evidenceNumbers: ['证据1'] })
      if (scenario === 'interrupt') {
        const timer = setTimeout(() => response.end(), 30000)
        response.once('close', () => clearTimeout(timer))
        return true
      }
      const result = await runWithWorkspaceAccount(account, async () => {
        const latest = await readWorkspace()
        const id = original?.id || randomUUID()
        const paragraphId = randomUUID()
        const certificate = { ...original, id, caseId: original?.caseId || payload.caseId, title,
          role: original?.role || payload.role, focus: payload.prompt || '', createdAt: original?.createdAt || new Date().toISOString(),
          paragraphIds: [paragraphId], paragraphs: [{ id: paragraphId, text, verified: false }] }
        latest.certificates = original ? latest.certificates.map(item => item.id === id ? certificate : item) : [...latest.certificates, certificate]
        await writeWorkspace(latest)
        return { workspace: latest, certificate, agentReply: '回归文书已保存' }
      })
      send('done', result)
      response.end()
      return true
    },
  }
}
module.exports = { createDocumentMock }
