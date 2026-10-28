import { useEffect, useRef, useState } from 'react'
import { api } from './api'
import { AssistantPicker, VoiceInputButton, assistantAgents, assistantSkills, type AssistantSelection } from './AssistantControls'
import type { AppState, CaseFolder, CasePositionDraft } from './types'

const roleLabels: Record<CasePositionDraft['role'], string> = {
  plaintiff: '原告', defendant: '被告', third_party: '第三人',
  applicant: '申请人', respondent: '被申请人', other: '其他',
}

export function CaseAgentPanel({ folder, workspace, onWorkspace, onEvidence }: {
  folder: CaseFolder
  workspace: AppState
  onWorkspace: (workspace: AppState) => void
  onEvidence: (id: string) => void
}) {
  const [message, setMessage] = useState('')
  const [intent, setIntent] = useState<'position' | 'question'>(folder.agent?.position ? 'question' : 'position')
  const [proposal, setProposal] = useState<{ position: CasePositionDraft; version: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [selection, setSelection] = useState<AssistantSelection>({ agent: 'case' })
  const [models, setModels] = useState<Array<{ id: string; label: string }>>([])
  const [skillOpen, setSkillOpen] = useState(false)
  const [voiceBusy, setVoiceBusy] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    void api.assistantCapabilities().then(result => {
      if (mounted.current) setModels(result.models)
    }).catch(e => { if (mounted.current) setError(e instanceof Error ? e.message : '无法获取可用模型。') })
    return () => { mounted.current = false }
  }, [])
  const selectedSkill = assistantSkills.find(item => item.id === selection.skill)
  const selectedAgent = assistantAgents.find(item => item.id === selection.agent)!
  const blocked = busy || voiceBusy
  function chooseSkill(id: string) {
    setSelection(current => ({ ...current, skill: id === '' ? undefined : id as AssistantSelection['skill'] }))
    setIntent('question')
    setMessage(current => current.replace(/\\[^\s\\]*$/, ''))
    requestAnimationFrame(() => inputRef.current?.focus())
  }
  function submitMessage() {
    if ((!message.trim() && !selectedSkill) || blocked || /\\[^\s\\]*$/.test(message)) return
    const text = message.trim() || `请结合本案材料执行${selectedSkill!.label}。`
    void run(async () => {
      const result = await api.caseAgentMessage(folder.id, text, intent, selection)
      if (!mounted.current) return
      onWorkspace(result.workspace)
      setProposal(result.proposal ? { position: result.proposal, version: result.positionVersion } : null)
      setMessage('')
      setSelection(current => ({ ...current, skill: undefined }))
    })
  }
  const position = folder.agent?.position
  const memory = workspace.caseContextMemories.find(m => m.caseId === folder.id)
  const candidate = folder.agent?.strategy
  const strategy = candidate?.positionVersion === position?.version
    && candidate?.memoryVersion === memory?.version
    && folder.agent?.task?.status !== 'queued' && folder.agent?.task?.status !== 'processing'
    ? candidate : undefined
  async function run(action: () => Promise<void>) {
    setBusy(true)
    setError('')
    try { await action() } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : '案件助手暂不可用，请重试。')
    } finally { if (mounted.current) setBusy(false) }
  }
  const evidenceButtons = (ids: string[]) => ids.map(id => {
    const evidence = workspace.evidences.find(e => e.id === id)
    return evidence ? <button className="ghost-button" type="button" key={id} onClick={() => onEvidence(id)}>
      {evidence.number} {evidence.fileName}
    </button> : null
  })
  return <section className="case-agent-panel" aria-label="案件代理助手" aria-busy={busy}>
    <div className="case-agent-position">
      <strong>{position ? `代理${roleLabels[position.role]}：${position.party}` : '尚未设置代理立场'}</strong>
      {position ? <p>{position.goals.join('；')}</p> : null}
      <div className="case-agent-actions">
        <button className={intent === 'position' ? 'primary-button' : 'ghost-button'} type="button"
          onClick={() => { setIntent('position'); setProposal(null); setSelection(current => ({ ...current, skill: undefined })) }} disabled={blocked}>代理设置</button>
        <button className={intent === 'question' ? 'primary-button' : 'ghost-button'} type="button"
          onClick={() => { setIntent('question'); setProposal(null) }} disabled={blocked}>讨论案情</button>
        <button className="ghost-button" type="button" disabled={blocked} onClick={() => void run(async () => {
          const result = await api.retryCaseAgent(folder.id, folder.agent?.autoAnalyze === false)
          if (mounted.current) onWorkspace(result.workspace)
        })}>{folder.agent?.autoAnalyze === false ? '恢复自动梳理' : '暂停自动梳理'}</button>
      </div>
    </div>
    {folder.agent?.task ? <div className="case-agent-task" role="status">
      <span>{busy ? '正在分析你的说明...' : folder.agent.task.stage}</span>
      {folder.agent.task.status === 'failed' ? <>
        <p>{folder.agent.task.error}</p>
        <button className="ghost-button" type="button" disabled={blocked} onClick={() => void run(async () => {
          const result = await api.retryCaseAgent(folder.id)
          if (mounted.current) onWorkspace(result.workspace)
        })}>重试梳理</button>
      </> : null}
    </div> : null}
    {(folder.agent?.messages ?? []).slice(-8).map(item => <article className={`agent-message ${item.role}`} key={item.id}>
      <strong>{item.role === 'user' ? '你' : '助手'}</strong><p>{item.content}</p>
    </article>)}
    <form className="case-agent-composer" onSubmit={event => {
      event.preventDefault()
      submitMessage()
    }}>
      {selectedSkill ? <div className="assistant-skill-chip"><span>\ {selectedSkill.label}</span>
        <button type="button" aria-label="移除 Skill" disabled={blocked} onClick={() => chooseSkill('')}>×</button></div> : null}
      <textarea ref={inputRef} aria-label="案件沟通" value={message} maxLength={6000} disabled={blocked}
        placeholder={intent === 'position' ? '说明你代理的当事人和办案目标…' : '输入问题，或输入 \\ 选择 Skill…'}
        onChange={event => { setMessage(event.target.value); setSkillOpen(/\\[^\s\\]*$/.test(event.target.value)) }}
        onKeyDown={event => {
          if (event.key === 'Escape') setSkillOpen(false)
          if (skillOpen && (event.key === 'ArrowDown' || event.key === 'Enter') && !event.nativeEvent.isComposing) {
            event.preventDefault()
            inputRef.current?.closest('form')?.querySelector<HTMLButtonElement>('.assistant-send-row .assistant-picker-menu button')?.focus()
            return
          }
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !skillOpen) {
            event.preventDefault(); submitMessage()
          }
        }} />
      <div className="assistant-config-row">
        <AssistantPicker label={selectedAgent.label} title="选择 Agent" items={assistantAgents}
          value={selection.agent} disabled={blocked} onSelect={id => {
            setSelection(current => ({ ...current, agent: id as AssistantSelection['agent'] }))
            setIntent('question'); setProposal(null)
          }} />
        <AssistantPicker label={selection.model || '默认模型'} title="选择模型"
          items={[{ id: '', label: '默认模型', description: '使用当前默认配置' }, ...models]}
          value={selection.model ?? ''} disabled={blocked} onSelect={id => setSelection(current => ({ ...current, model: id || undefined }))} />
      </div>
      <div className="assistant-send-row">
        <AssistantPicker label="\ Skill" title="选择 Skill" items={assistantSkills.filter(item => {
          const query = message.match(/\\([^\s\\]*)$/)?.[1]?.toLowerCase() || ''
          return !query || item.label.includes(query) || item.id.includes(query)
        })} value={selection.skill} disabled={blocked} open={skillOpen} onOpen={setSkillOpen} onSelect={chooseSkill} />
        <div className="assistant-send-actions">
          <VoiceInputButton disabled={busy} onBusy={setVoiceBusy} onError={setError} onText={text => {
            setMessage(current => `${current}${current && !/\s$/.test(current) ? '\n' : ''}${text}`.slice(0, 6000))
            requestAnimationFrame(() => inputRef.current?.focus())
          }} />
          <button className="assistant-send" aria-label="发送消息" disabled={blocked || /\\[^\s\\]*$/.test(message) || (!message.trim() && !selectedSkill)}>
            {busy ? <span className="assistant-spinner" /> : <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 16V4m-5 5 5-5 5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>}
          </button>
        </div>
      </div>
    </form>
    {proposal ? <article className="case-agent-confirm">
      <strong>待确认代理立场</strong>
      <label>当事人<input value={proposal.position.party} onChange={e => setProposal({
        ...proposal, position: { ...proposal.position, party: e.target.value },
      })} /></label>
      <div>诉讼地位<AssistantPicker label={roleLabels[proposal.position.role]} title="选择诉讼地位"
        items={Object.entries(roleLabels).map(([id, label]) => ({ id, label }))} value={proposal.position.role}
        disabled={busy} onSelect={id => setProposal({
          ...proposal, position: { ...proposal.position, role: id as CasePositionDraft['role'] },
        })} /></div>
      {(['goals', 'admissions', 'disputes', 'boundaries'] as const).map(field => <label key={field}>
        {{ goals: '办案目标', admissions: '认可事项', disputes: '争议事项', boundaries: '办案约束' }[field]}
        <textarea value={proposal.position[field].join('\n')} onChange={e => setProposal({
          ...proposal, position: { ...proposal.position, [field]: e.target.value.split('\n') },
        })} />
      </label>)}
      <div className="case-agent-actions">
        <button className="primary-button" type="button" disabled={busy} onClick={() => void run(async () => {
          const draft = { ...proposal.position }
          for (const key of ['goals', 'admissions', 'disputes', 'boundaries'] as const) {
            draft[key] = draft[key].map(s => s.trim()).filter(Boolean)
          }
          const result = await api.confirmCasePosition(folder.id, draft, proposal.version)
          if (!mounted.current) return
          onWorkspace(result.workspace); setProposal(null); setIntent('question')
        })}>确认并更新办案思路</button>
        <button className="ghost-button" type="button" disabled={busy} onClick={() => setProposal(null)}>取消</button>
      </div>
    </article> : null}
    {error ? <p className="case-agent-error" role="alert">{error}</p> : null}
    {strategy ? <section className="case-agent-strategy">
      <h3>主张与举证思路</h3><p>{strategy.summary}</p>
      {strategy.claims.map(claim => <details key={claim.id}>
        <summary>{claim.claim} · {{ supported: '材料支持，待核验', needs_evidence: '需要补证', alternative: '备选论证' }[claim.status]}</summary>
        <p>成立要件：{claim.requirements.join('；')}</p><p>证明责任：{claim.burden}</p>
        <strong>支持材料</strong><div className="case-agent-actions">{evidenceButtons(claim.supportEvidenceIds)}</div>
        <strong>不利材料</strong><div className="case-agent-actions">{evidenceButtons(claim.adverseEvidenceIds)}</div>
        <p>补证事项：{claim.gaps.join('；') || '仍需人工核验原件与证明力。'}</p>
        <p>对方可能反驳：{claim.counterargument}</p><p>应对思路：{claim.response}</p>
      </details>)}
      <strong>下一步</strong><ul>{strategy.nextSteps.map((s, i) => <li key={i}>{s}</li>)}</ul>
      <strong>风险关注</strong><ul>{strategy.warnings.map((s, i) => <li key={i}>{s}</li>)}</ul>
    </section> : null}
  </section>
}
