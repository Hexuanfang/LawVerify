import { useEffect, useId, useRef, useState } from 'react'
import { ArrowUp, Loader2, RefreshCw } from 'lucide-react'
import { api } from '../api'
import { assistantAgents, assistantSkills, VoiceInputButton, type AssistantSelection } from '../AssistantControls'
import type { CasePositionDraft, Evidence } from '../types'
import { useApp } from './AppContext'
import { Button } from './components/ui/button'
import { Input } from './components/ui/input'
import { Textarea } from './components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './components/ui/select'
import './case-assistant.css'

const roleLabels: Record<CasePositionDraft['role'], string> = {
  plaintiff: '原告', defendant: '被告', third_party: '第三人',
  applicant: '申请人', respondent: '被申请人', other: '其他',
}
const positionFields = { goals: '办案目标', admissions: '认可事项', disputes: '争议事项', boundaries: '办案约束' } as const

// 与旧案件助手保持相同的排除材料判定，补齐正文后不再沿用旧提示。
function isStillUnparsed(evidence: Evidence | undefined) {
  if (!evidence || evidence.summaryStatus === 'ready' || evidence.summaryStatus === 'failed') return false
  const lines = (evidence.ocrText ?? '').split('\n').map(line => line.trim()).filter(Boolean)
    .filter(line => !/^-{2,}\s*第\s*\d+\s*\/\s*\d+\s*页\s*-{2,}$/u.test(line))
  const placeholders = [/^【.*】$/u, /^文件：/u, /^1\.\s*当前内容为/u, /^2\.\s*请结合/u, /^3\.\s*(?:支持用于|可直接用于)/u]
  return !lines.length || lines.every(line => placeholders.some(pattern => pattern.test(line)))
}

function Picker({ label, value, items, disabled, onChange, open, onOpenChange }: {
  label: string
  value: string
  items: ReadonlyArray<{ id: string; label: string }>
  disabled: boolean
  onChange: (value: string) => void
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  return <Select value={value} disabled={disabled} onValueChange={value => { if (!disabled) onChange(value) }} open={disabled ? false : open} onOpenChange={onOpenChange}>
    <SelectTrigger size="sm" aria-label={label}><SelectValue placeholder={label} /></SelectTrigger>
    <SelectContent className="case-assistant-select" position="popper">
      {items.map(item => <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>)}
    </SelectContent>
  </Select>
}

export function CaseAssistant() {
  const app = useApp()
  const caseId = app.project?.id ?? ''
  const folder = app.workspace?.cases.find(item => item.id === caseId)
  const [message, setMessage] = useState('')
  const [intent, setIntent] = useState<'position' | 'question'>(folder?.agent?.position ? 'question' : 'position')
  const [proposal, setProposal] = useState<{ position: CasePositionDraft; version: number } | null>(null)
  const [selection, setSelection] = useState<AssistantSelection>({ agent: 'case' })
  const [models, setModels] = useState<Array<{ id: string; label: string }>>([])
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const [voiceBusy, setVoiceBusy] = useState(false)
  const [skillOpen, setSkillOpen] = useState(false)
  const input = useRef<HTMLTextAreaElement>(null)
  const mounted = useRef(false)
  const currentCase = useRef(caseId)
  currentCase.current = caseId
  const operationLock = useRef(false)
  const voiceDone = useRef<(() => void) | null>(null)
  const voiceCurrent = useRef<(() => boolean) | null>(null)
  const composerId = useId()
  function snapshot() {
    const account = sessionStorage.getItem('lawverify-login-account')
    const session = sessionStorage.getItem('lawverify-auth-session')
    const originCase = caseId
    return () => mounted.current && currentCase.current === originCase
      && account === sessionStorage.getItem('lawverify-login-account')
      && session === sessionStorage.getItem('lawverify-auth-session')
  }
  useEffect(() => {
    mounted.current = true
    const isCurrent = snapshot()
    void api.assistantCapabilities().then(result => {
      if (isCurrent()) setModels(result.models)
    }).catch(cause => {
      if (isCurrent()) setError(cause instanceof Error ? cause.message : '无法获取可用模型。')
    })
    return () => { mounted.current = false; voiceDone.current?.() }
    // 父容器按案件 key 挂载，每次进入案件独立获取能力。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const blocked = app.busy || pending || voiceBusy
  const position = folder?.agent?.position
  const memory = app.workspace?.caseContextMemories.find(item => item.caseId === caseId)
  const task = folder?.agent?.task
  const analyzing = task?.status === 'queued' || task?.status === 'processing'
  const candidate = folder?.agent?.strategy
  const strategy = candidate?.positionVersion === position?.version && candidate?.memoryVersion === memory?.version && !analyzing
    ? candidate : undefined
  const selectedSkill = assistantSkills.find(item => item.id === selection.skill)
  const skillQuery = message.match(/\\([^\s\\]*)$/)?.[1]?.toLowerCase() ?? ''
  const skillItems = assistantSkills.filter(item => !skillQuery || item.label.includes(skillQuery) || item.id.includes(skillQuery))
  const unfinishedSkill = /\\[^\s\\]*$/.test(message)

  async function perform<T>(operation: () => Promise<T>, completed?: (result: T) => void) {
    if (blocked || operationLock.current || !folder) return
    operationLock.current = true
    setPending(true)
    setError('')
    const isCurrent = snapshot()
    let result: T | undefined
    let finished = false
    const success = await app.run(async () => {
      try {
        result = await operation()
        finished = true
      } catch (cause) {
        if (isCurrent()) {
          setError(cause instanceof Error ? cause.message : '案件助手暂不可用，请重试。')
          throw cause
        }
      }
    })
    if (isCurrent()) {
      if (success && finished) completed?.(result as T)
      setPending(false)
    }
    operationLock.current = false
  }
  function chooseSkill(id: string) {
    if (blocked) return
    setSelection(current => ({ ...current, skill: id === 'none' ? undefined : id as AssistantSelection['skill'] }))
    setIntent('question')
    setMessage(current => current.replace(/\\[^\s\\]*$/, ''))
    setSkillOpen(false)
    requestAnimationFrame(() => input.current?.focus())
  }
  function submit() {
    if (blocked || unfinishedSkill || (!message.trim() && !selectedSkill)) return
    const text = message.trim() || `请结合本案材料执行${selectedSkill!.label}。`
    void perform(() => api.caseAgentMessage(caseId, text, intent, selection), result => {
      setProposal(result.proposal ? { position: result.proposal, version: result.positionVersion } : null)
      setMessage('')
      setSelection(current => ({ ...current, skill: undefined }))
    })
  }
  function confirmPosition() {
    if (!proposal) return
    if (!proposal.position.party.trim()) { setError('请填写代理当事人。'); return }
    const draft = { ...proposal.position, party: proposal.position.party.trim() }
    for (const field of Object.keys(positionFields) as Array<keyof typeof positionFields>) {
      draft[field] = draft[field].map(line => line.trim()).filter(Boolean)
    }
    if (!draft.goals.length) { setError('请至少填写一项办案目标。'); return }
    void perform(() => api.confirmCasePosition(caseId, draft, proposal.version), () => {
      setProposal(null)
      setIntent('question')
    })
  }
  function evidenceButtons(ids: string[]) {
    return ids.map(id => {
      const evidence = app.workspace?.evidences.find(item => item.id === id && item.caseId === caseId)
      return evidence ? <Button type="button" variant="outline" size="sm" disabled={blocked} key={id}
        onClick={() => app.setDrawer({ st: 'l1', targetId: id, name: evidence.fileName, loc: '', quote: '' })}>
        {evidence.number} {evidence.fileName}
      </Button> : null
    })
  }
  function onVoiceBusy(value: boolean) {
    if (!value) {
      voiceDone.current?.()
      voiceDone.current = null
      if (mounted.current) setVoiceBusy(false)
      return
    }
    voiceCurrent.current = snapshot()
    setVoiceBusy(true)
    setError('')
    // 复用现有录音组件，同时由全局 mutation 暂停材料目录后台同步。
    void app.run(() => new Promise<void>(resolve => { voiceDone.current = resolve }))
  }
  const skipped = (task?.skippedEvidenceIds ?? []).filter(id => isStillUnparsed(app.workspace?.evidences.find(item => item.id === id)))
  const duplicates = task?.duplicateEvidenceIds ?? []
  if (!folder || !app.workspace) return <p className="case-assistant-empty">请先选择案件。</p>

  return <section className="case-assistant" aria-label="案件助手" aria-busy={blocked}>
    <header className="case-assistant-header">
      <div><strong>{position ? `代理${roleLabels[position.role]} · ${position.party}` : '设置代理身份'}</strong>
        <p>{position ? position.goals.join('；') : '说明代理当事人和办案目标，确认后形成办案思路。'}</p></div>
      <div className="case-assistant-modes" role="group" aria-label="案件助手模式">
        {(['position', 'question'] as const).map(mode => <Button key={mode} type="button" size="sm"
          variant={mode === intent ? 'secondary' : 'ghost'} disabled={blocked} aria-pressed={mode === intent}
          onClick={() => { setIntent(mode); setProposal(null); if (mode === 'position') setSelection(current => ({ ...current, skill: undefined })) }}>
          {mode === 'position' ? '代理设置' : '讨论案情'}
        </Button>)}
      </div>
    </header>
    <div className="case-assistant-body">
      <section className="case-assistant-memory" aria-label="案件分析状态">
        <div className="case-assistant-section-head"><strong>案件记忆</strong><span>{memory ? `第 ${memory.version} 版` : '待建立'}</span></div>
        <p>{memory?.summary || '导入材料并完成解析后，可重新梳理案件记忆。'}</p>
        {task ? <p role="status" className={task.status === 'failed' ? 'case-assistant-error' : 'case-assistant-status'}>
          {analyzing ? <Loader2 size={13} className="case-assistant-spin" /> : null}
          {task.stage || { queued: '等待分析', processing: '正在分析', ready: '分析完成', failed: '分析失败' }[task.status]}
          {task.error ? ` · ${task.error}` : ''}
        </p> : null}
        <div className="case-assistant-actions">
          <Button type="button" size="sm" variant="outline" disabled={blocked || analyzing}
            onClick={() => void perform(() => api.rebuildCaseMemory(caseId))}><RefreshCw size={13} />重建记忆</Button>
          <Button type="button" size="sm" variant="outline" disabled={blocked || analyzing}
            onClick={() => void perform(() => api.retryCaseAgent(caseId))}>重新分析</Button>
          <Button type="button" size="sm" variant="ghost" disabled={blocked} aria-pressed={folder.agent?.autoAnalyze !== false}
            onClick={() => void perform(() => api.retryCaseAgent(caseId, folder.agent?.autoAnalyze === false))}>
            {folder.agent?.autoAnalyze === false ? '开启自动分析' : '暂停自动分析'}
          </Button>
        </div>
        {skipped.length ? <div className="case-assistant-materials"><p>本次已排除 {skipped.length} 份未完成解析材料</p><div>{evidenceButtons(skipped)}</div></div> : null}
        {duplicates.length ? <div className="case-assistant-materials"><p>{duplicates.length} 份重复材料已沿用原件理解结果</p><div>{evidenceButtons(duplicates)}</div></div> : null}
      </section>
      {(folder.agent?.messages ?? []).length ? <div className="case-assistant-history" aria-label="历史对话">
        {folder.agent!.messages!.map(item => <article key={item.id} className={`case-assistant-message case-assistant-message-${item.role}`}>
          <span>{item.role === 'user' ? '你' : '案件助手'}</span><p>{item.content}</p>
        </article>)}
      </div> : <p className="case-assistant-empty">暂无对话记录</p>}
      {proposal ? <section className="case-assistant-proposal" aria-label="待确认代理立场">
        <h3>确认代理立场</h3>
        <label>当事人<Input disabled={blocked} value={proposal.position.party}
          onChange={event => setProposal({ ...proposal, position: { ...proposal.position, party: event.target.value } })} /></label>
        <label>诉讼地位<Picker label="诉讼地位" value={proposal.position.role} disabled={blocked}
          items={Object.entries(roleLabels).map(([id, label]) => ({ id, label }))}
          onChange={role => setProposal({ ...proposal, position: { ...proposal.position, role: role as CasePositionDraft['role'] } })} /></label>
        {(Object.keys(positionFields) as Array<keyof typeof positionFields>).map(field => <label key={field}>
          {positionFields[field]}<Textarea disabled={blocked} value={proposal.position[field].join('\n')}
            onChange={event => setProposal({ ...proposal, position: { ...proposal.position, [field]: event.target.value.split('\n') } })} />
        </label>)}
        <div className="case-assistant-actions"><Button type="button" size="sm" disabled={blocked} onClick={confirmPosition}>确认并更新办案思路</Button>
          <Button type="button" size="sm" variant="ghost" disabled={blocked} onClick={() => setProposal(null)}>取消</Button></div>
      </section> : null}
      {strategy ? <section className="case-assistant-strategy" aria-label="主张与举证思路">
        <h3>主张与举证思路</h3><p>{strategy.summary}</p>
        {strategy.claims.map(claim => <details key={claim.id}>
          <summary>{claim.claim}<span>{{ supported: '材料支持，待核验', needs_evidence: '需要补证', alternative: '备选论证' }[claim.status]}</span></summary>
          <p>成立要件 · {claim.requirements.join('；')}</p><p>证明责任 · {claim.burden}</p>
          <h4>支持材料</h4><div className="case-assistant-actions">{evidenceButtons(claim.supportEvidenceIds)}</div>
          <h4>不利材料</h4><div className="case-assistant-actions">{evidenceButtons(claim.adverseEvidenceIds)}</div>
          <p>补证事项 · {claim.gaps.join('；') || '仍需人工核验原件与证明力。'}</p>
          <p>对方可能反驳 · {claim.counterargument}</p><p>应对思路 · {claim.response}</p>
        </details>)}
        {strategy.nextSteps.length ? <><h4>下一步</h4><ul>{strategy.nextSteps.map((text, index) => <li key={index}>{text}</li>)}</ul></> : null}
        {strategy.warnings.length ? <><h4>风险关注</h4><ul>{strategy.warnings.map((text, index) => <li key={index}>{text}</li>)}</ul></> : null}
      </section> : null}
    </div>
    <form className="case-assistant-composer" onSubmit={event => { event.preventDefault(); submit() }}>
      {error ? <p role="alert" className="case-assistant-error">{error}</p> : null}
      <label htmlFor={composerId} className="case-assistant-input-label">{intent === 'position' ? '说明代理身份与目标' : '讨论案情'}</label>
      <Textarea id={composerId} ref={input} maxLength={6000} disabled={blocked} value={message}
        placeholder={intent === 'position' ? '我代理的当事人是…，办案目标是…' : '输入问题，或输入 \\ 选择 Skill…'}
        onChange={event => { setMessage(event.target.value); setSkillOpen(/\\[^\s\\]*$/.test(event.target.value)) }}
        onKeyDown={event => {
          if (event.key === 'Escape') setSkillOpen(false)
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !skillOpen) { event.preventDefault(); submit() }
        }} />
      <div className="case-assistant-tools">
        <VoiceInputButton disabled={app.busy || pending} onBusy={onVoiceBusy}
          onError={text => { if (voiceCurrent.current?.()) setError(text) }}
          onText={text => {
            if (!voiceCurrent.current?.()) return
            setMessage(current => `${current}${current && !/\s$/.test(current) ? '\n' : ''}${text}`.slice(0, 6000))
            requestAnimationFrame(() => input.current?.focus())
          }} />
        <Picker label="选择 Skill" value={selection.skill ?? 'none'} disabled={blocked} open={skillOpen} onOpenChange={setSkillOpen}
          items={[{ id: 'none', label: 'Skills' }, ...skillItems]} onChange={chooseSkill} />
        <Picker label="选择 Agent" value={selection.agent} items={assistantAgents} disabled={blocked}
          onChange={agent => { setSelection(current => ({ ...current, agent: agent as AssistantSelection['agent'] })); setIntent('question'); setProposal(null) }} />
        <Picker label="选择模型" value={selection.model ?? 'default'} items={[{ id: 'default', label: '默认模型' }, ...models]} disabled={blocked}
          onChange={model => setSelection(current => ({ ...current, model: model === 'default' ? undefined : model }))} />
        <Button type="submit" size="icon" aria-label="发送消息" disabled={blocked || unfinishedSkill || (!message.trim() && !selectedSkill)}>
          {pending ? <Loader2 className="case-assistant-spin" size={16} /> : <ArrowUp size={16} />}
        </Button>
      </div>
    </form>
  </section>
}

