import { useEffect, useRef, useState } from 'react'
import { api } from './api'
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
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
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
      <strong>{position ? `代理${roleLabels[position.role]}：${position.party}` : '请确认你代理哪一方'}</strong>
      {position ? <p>{position.goals.join('；')}</p> : <p>说明代理当事人和办案目标，确认后用于本案分析与文书。</p>}
      <div className="case-agent-actions">
        <button className={intent === 'position' ? 'primary-button' : 'ghost-button'} type="button"
          onClick={() => { setIntent('position'); setProposal(null) }} disabled={busy}>代理设置</button>
        <button className={intent === 'question' ? 'primary-button' : 'ghost-button'} type="button"
          onClick={() => { setIntent('question'); setProposal(null) }} disabled={busy}>讨论案情</button>
        <button className="ghost-button" type="button" disabled={busy} onClick={() => void run(async () => {
          const result = await api.retryCaseAgent(folder.id, folder.agent?.autoAnalyze === false)
          if (mounted.current) onWorkspace(result.workspace)
        })}>{folder.agent?.autoAnalyze === false ? '恢复自动梳理' : '暂停自动梳理'}</button>
      </div>
    </div>
    {folder.agent?.task ? <div className="case-agent-task" role="status">
      <span>{busy ? '正在分析你的说明...' : folder.agent.task.stage}</span>
      {folder.agent.task.status === 'failed' ? <>
        <p>{folder.agent.task.error}</p>
        <button className="ghost-button" type="button" disabled={busy} onClick={() => void run(async () => {
          const result = await api.retryCaseAgent(folder.id)
          if (mounted.current) onWorkspace(result.workspace)
        })}>重试梳理</button>
      </> : null}
    </div> : null}
    {(folder.agent?.messages ?? []).slice(-8).map(item => <article className={`agent-message ${item.role}`} key={item.id}>
      <strong>{item.role === 'user' ? '你' : '案件助手'}</strong><p>{item.content}</p>
    </article>)}
    <form className="case-agent-composer" onSubmit={event => {
      event.preventDefault()
      if (!message.trim() || busy) return
      void run(async () => {
        const result = await api.caseAgentMessage(folder.id, message.trim(), intent)
        if (!mounted.current) return
        onWorkspace(result.workspace)
        setProposal(result.proposal ? { position: result.proposal, version: result.positionVersion } : null)
        setMessage('')
      })
    }}>
      <small>材料理解和案件沟通按积分规则计费，原件理解结果可复用。</small>
      <textarea aria-label="案件沟通" value={message} maxLength={6000} disabled={busy}
        placeholder={intent === 'position' ? '例如：我代理被告李某，认可借款，但已归还部分款项，希望核减本金与利息。' : '就本案主张、证据和补证事项提问'}
        onChange={event => setMessage(event.target.value)} />
      <button className="primary-button" disabled={busy || !message.trim()}>{busy ? '正在分析...' : '发送'}</button>
    </form>
    {proposal ? <article className="case-agent-confirm">
      <strong>待确认代理立场</strong>
      <label>当事人<input value={proposal.position.party} onChange={e => setProposal({
        ...proposal, position: { ...proposal.position, party: e.target.value },
      })} /></label>
      <label>诉讼地位<select className="streamlined-case-select" value={proposal.position.role} onChange={e => setProposal({
        ...proposal, position: { ...proposal.position, role: e.target.value as CasePositionDraft['role'] },
      })}>{Object.entries(roleLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
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
