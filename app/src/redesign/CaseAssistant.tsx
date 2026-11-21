import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { AssistantDocumentContext } from '../../../server/src/assistant/context'
import { useApp } from './AppContext'
import './case-assistant.css'

export function useCaseAssistant() {
  const app = useApp()
  const caseId = app.project?.id ?? ''
  const agent = app.workspace?.cases.find(item => item.id === caseId)?.agent
  const messages = agent?.messages ?? []
  const [pending, setPending] = useState(false)
  const active = useRef(true)
  const operationLock = useRef(false)

  useEffect(() => {
    active.current = true
    return () => { active.current = false }
  }, [])

  async function send(prompt: string, lawyerNote: string | undefined, context: AssistantDocumentContext) {
    if (app.busy || operationLock.current || !caseId) return false
    operationLock.current = true
    setPending(true)
    const session = sessionStorage.getItem('lawverify-auth-session')
    const isCurrent = () => active.current && session === sessionStorage.getItem('lawverify-auth-session')
    try {
      const ok = await app.run(() => api.caseAgentMessage(caseId, prompt, 'question', undefined, lawyerNote, context))
      if (!ok || !isCurrent()) return false
      void app.auditAssistantAction(app.certificate?.id, 'AI 回答案件问题')
      return true
    } finally {
      operationLock.current = false
      if (isCurrent()) setPending(false)
    }
  }

  const result = messages.length > 0 && <section className="case-assistant" aria-label="案件对话">
    <div className="case-assistant-history" aria-label="历史对话">
      {messages.map(item => <article key={item.id} className={`case-assistant-message case-assistant-message-${item.role}`}>
        <p>{item.content}</p>
      </article>)}
    </div>
  </section>

  return { send, pending, result, hasResult: Boolean(result), messageCount: messages.length, stance: agent?.position?.goals.join('；') }
}

