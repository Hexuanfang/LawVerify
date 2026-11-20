const { createHash, randomUUID } = require('node:crypto')

function createDocumentMock({ readWorkspace, writeWorkspace, runWithWorkspaceAccount, account }) {
  const requests = []
  const drafts = new Map()
  let scenario = 'success'
  return {
    requests,
    setScenario: value => { scenario = value },
    async handle(request, response) {
      const pathname = new URL(request.url, 'http://localhost').pathname
      const rewrite = pathname.match(/^\/api\/certificates\/([^/]+)\/rewrite\/stream$/)
      const draft = pathname === '/api/v1/assistant/draft/stream'
      const adoption = pathname.match(/^\/api\/v1\/assistant\/candidates\/([^/]+)(\/adopt)?$/)
      if (adoption && request.method === 'DELETE' && !adoption[2]) {
        drafts.delete(adoption[1])
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: true, data: { ok: true } }))
        return true
      }
      if (request.method !== 'POST' || (!rewrite && !draft && !adoption?.[2])) return false
      let raw = ''
      for await (const chunk of request) raw += chunk.toString('utf8')
      const payload = JSON.parse(raw)
      const state = await runWithWorkspaceAccount(account, readWorkspace)
      if (adoption?.[2]) {
        const candidate = drafts.get(adoption[1])
        if (!payload.confirmed || !candidate || candidate.caseId !== payload.caseId) {
          response.writeHead(409, { 'Content-Type': 'application/json' }).end(JSON.stringify({ message: '回归候选已失效' }))
          return true
        }
        await runWithWorkspaceAccount(account, async () => {
          if (state.certificates.some(item => item.id === candidate.id)) return
          state.certificates.push(candidate)
          await writeWorkspace(state)
        })
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: true, data: { certificateId: candidate.id } }))
        return true
      }
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
      if (payload.selection && scenario === 'success') {
        const rewriteVersion = createHash('sha256').update(JSON.stringify(original)).digest('base64url')
        send('done', { workspace: state, certificate: original, rewritePreview: `经核对，${payload.selection.quote}`, rewriteVersion })
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
      const id = randomUUID(), paragraphId = randomUUID(), candidateId = randomUUID()
      const certificate = { id, caseId: payload.caseId, title, role: payload.role, focus: payload.prompt || '', createdAt: new Date().toISOString(),
        paragraphIds: [paragraphId], paragraphs: [{ id: paragraphId, text, verified: false, aiOrigin: 'draft' }] }
      drafts.set(candidateId, certificate)
      send('done', { certificate, candidateId, draft: { type: 'draft-doc', docType: 'qs', items: [] } })
      response.end()
      return true
    },
  }
}
module.exports = { createDocumentMock }
