import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { CasePositionDraft } from '../types'
import type { AssistantDocumentContext } from '../../../server/src/assistant/context'
import { caseRoleLabels } from '../../../server/src/intelligence/case-roles'
import { useApp } from './AppContext'
import { Button } from './components/ui/button'
import { Input } from './components/ui/input'
import { Textarea } from './components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './components/ui/select'
import './case-assistant.css'

const positionFields = { goals: '办案目标', admissions: '认可事项', disputes: '争议事项', boundaries: '办案约束' } as const

export function useCaseAssistant(onPositionConfirmed: () => void) {
  const app = useApp()
  const caseId = app.project?.id ?? ''
  const agent = app.workspace?.cases.find(item => item.id === caseId)?.agent
  const messages = agent?.messages ?? []
  const [proposal, setProposal] = useState<{ position: CasePositionDraft; version: number } | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const active = useRef(true)
  const operationLock = useRef(false)

  useEffect(() => {
    active.current = true
    return () => { active.current = false }
  }, [])

  async function perform<T>(operation: () => Promise<T>, completed: (result: T) => void) {
    if (app.busy || operationLock.current || !caseId) return false
    operationLock.current = true
    setPending(true)
    setError('')
    const session = sessionStorage.getItem('lawverify-auth-session')
    const isCurrent = () => active.current && session === sessionStorage.getItem('lawverify-auth-session')
    let commit: (() => void) | undefined
    try {
      const ok = await app.run(async () => {
        const result = await operation()
        commit = () => completed(result)
      })
      if (!ok || !isCurrent()) return false
      commit?.()
      return true
    } finally {
      operationLock.current = false
      if (isCurrent()) setPending(false)
    }
  }

  const send = (prompt: string, editPosition: boolean, lawyerNote: string | undefined, context: AssistantDocumentContext) => {
    return perform(() => api.caseAgentMessage(caseId, prompt, editPosition ? 'position' : 'question', undefined, lawyerNote, context), result => {
      setProposal(result.proposal ? { position: result.proposal, version: result.positionVersion } : null)
      void app.auditAssistantAction(app.certificate?.id, editPosition ? 'AI 整理代理立场' : 'AI 回答案件问题')
    })
  }

  function confirmPosition() {
    if (!proposal) return
    const draft = { ...proposal.position, party: proposal.position.party.trim() }
    if (!draft.party) { setError('请填写代理当事人。'); return }
    for (const field of Object.keys(positionFields) as Array<keyof typeof positionFields>) {
      draft[field] = draft[field].map(line => line.trim()).filter(Boolean)
    }
    if (!draft.goals.length) { setError('请至少填写一项办案目标。'); return }
    void perform(() => api.confirmCasePosition(caseId, draft, proposal.version), () => {
      setProposal(null)
      onPositionConfirmed()
    })
  }

  const result = (messages.length > 0 || proposal || error) && <section className="case-assistant" aria-label="对话与代理立场">
    {messages.length > 0 && <div className="case-assistant-history" aria-label="历史对话">
      {messages.map(item => <article key={item.id} className={`case-assistant-message case-assistant-message-${item.role}`}>
        <p>{item.content}</p>
      </article>)}
    </div>}
    {proposal && <section className="case-assistant-proposal" aria-label="待确认代理立场">
      <h3>确认代理立场</h3>
      <label>当事人<Input disabled={pending || app.busy} value={proposal.position.party}
        onChange={event => setProposal({ ...proposal, position: { ...proposal.position, party: event.target.value } })} />
      </label>
      <div className="case-assistant-role">
        <span>诉讼地位</span>
        <Select value={proposal.position.role} disabled={pending || app.busy}
          onValueChange={role => setProposal({ ...proposal, position: { ...proposal.position, role: role as CasePositionDraft['role'] } })}>
          <SelectTrigger aria-label="诉讼地位"><SelectValue /></SelectTrigger>
          <SelectContent>{Object.entries(caseRoleLabels).map(([id, label]) => <SelectItem key={id} value={id}>{label}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      {(Object.keys(positionFields) as Array<keyof typeof positionFields>).map(field => <label key={field}>
        {positionFields[field]}<Textarea disabled={pending || app.busy} value={proposal.position[field].join('\n')}
          onChange={event => setProposal({ ...proposal, position: { ...proposal.position, [field]: event.target.value.split('\n') } })} />
      </label>)}
      {error && <p role="alert">{error}</p>}
      <div className="case-assistant-actions"><Button size="sm" disabled={pending || app.busy} onClick={confirmPosition}>确认代理立场</Button>
        <Button size="sm" variant="ghost" disabled={pending || app.busy} onClick={() => { setProposal(null); setError('') }}>取消</Button></div>
    </section>}
  </section>

  return { send, pending, result, hasResult: Boolean(result), messageCount: messages.length, stance: agent?.position?.goals.join('；') }
}

