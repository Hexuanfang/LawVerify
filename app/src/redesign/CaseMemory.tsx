import { useEffect, useState, type ReactNode } from 'react'
import { ArrowRight, RefreshCw, Sparkles } from 'lucide-react'
import { api } from '../api'
import type { Evidence } from '../types'
import type { AnalysisOutput } from '../../../server/src/assistant/analysis'
import { useApp } from './AppContext'
import { formatVerificationCalculation, verifiedCaseMemory } from './verificationMemory'
import { Button } from './components/ui/button'
import { Textarea } from './components/ui/textarea'
import { Tabs, TabsContent, TabsList, TabsTrigger } from './components/ui/tabs'
import { groupReview } from './reviewOverview'
import { caseNoteKey } from './caseNotes'
import { caseRoleLabels } from '../../../server/src/intelligence/case-roles'
import { STATUS_NAMES } from './model'

const views = [
  ['brief', '办案速览'],
  ['focus', '立场与焦点'],
  ['timeline', '事实时间线'],
  ['evidence', '证据地图'],
  ['amounts', '金额台账'],
  ['risks', '风险与待办'],
] as const

function MemoryCard({ title, action, wide, children }: { title: string; action?: ReactNode; wide?: boolean; children: ReactNode }) {
  return <section className={`case-memory-card ${wide ? 'wide' : ''}`}>
    <header><h2>{title}</h2>{action}</header>
    {children}
  </section>
}

function MemoryList({ values, empty = '暂无记录。', ordered }: { values?: string[]; empty?: string; ordered?: boolean }) {
  if (!values?.length) return <p className="review-view-empty">{empty}</p>
  const List = ordered ? 'ol' : 'ul'
  return <List className="case-memory-list">{values.map((value, index) => <li key={index}>{value}</li>)}</List>
}

type TimelineState = 'loading' | 'error' | Extract<AnalysisOutput, { events: unknown }>

function CaseTimeline({ caseId, materials }: { caseId: string; materials: Evidence[] }) {
  const { setDrawer } = useApp()
  const [attempt, setAttempt] = useState(0)
  const [timeline, setTimeline] = useState<TimelineState>('loading')
  const hasMaterials = materials.length > 0
  useEffect(() => {
    if (!hasMaterials) return
    const controller = new AbortController()
    void api.executeAssistantSkill<AnalysisOutput>('timeline', { caseId }, controller.signal).then(result => {
      if (!controller.signal.aborted) setTimeline('events' in result ? result : 'error')
    }).catch(() => {
      if (!controller.signal.aborted) setTimeline('error')
    })
    return () => controller.abort()
  }, [caseId, hasMaterials, attempt])

  if (!hasMaterials) return <p className="review-view-empty">暂无卷内材料。</p>
  if (timeline === 'loading') return <p className="review-view-empty" role="status">正在提取材料中的时间线…</p>
  if (timeline === 'error') return <div className="case-memory-links">
    <p role="alert">暂时无法读取材料时间线。</p>
    <Button size="sm" variant="outline" onClick={() => { setTimeline('loading'); setAttempt(value => value + 1) }}>重试</Button>
  </div>
  if (!timeline.events.length) return <p className="review-view-empty">暂无可从材料定位的事件。</p>

  const ids = new Set(materials.map(item => item.id))
  const ready = materials.filter(item => (!item.parsing || item.parsing.status === 'ready') && !ids.has(item.duplicateOf ?? ''))
  return <ol className="case-memory-list">{timeline.events.map(({ date, event, material, loc }, index) => {
    // 时间线返回材料名称，同名材料不能据此跳转到某一份原件。
    const candidates = ready.filter(item => (item.name.trim() || item.fileName) === material)
    const label = `${material} · ${loc}`
    return <li key={index}>
      <p><b>{date ?? '日期待核'}</b>　{event}</p>
      <div className="case-memory-links">
        {candidates.length === 1 ? <Button size="sm" variant="outline" onClick={() => setDrawer({
          st: 'l1', targetId: candidates[0].id, name: material, loc, quote: event.endsWith('…') ? '' : event,
        })}>{label}</Button> : <small>{label} · 原件待核</small>}
      </div>
    </li>
  })}</ol>
}

export function CaseMemory({ onBack, onDraft, onAssistant }: {
  onBack: () => void
  onDraft: () => void
  onAssistant: (prompt?: string) => void
}) {
  const app = useApp()
  const project = app.project!
  const workspace = app.workspace!
  const folder = workspace.cases.find(item => item.id === project.id)
  const basics = folder?.basicInfo
  const basicRows = [
    ['原告', basics?.plaintiff], ['被告', basics?.defendant],
    ['我方', basics?.ourSide === 'plaintiff' ? '原告' : basics?.ourSide === 'defendant' ? '被告' : ''],
    ['案由', basics?.cause], ['受诉法院', basics?.court], ['案号', basics?.caseNumber],
  ].filter(([, value]) => value)
  const position = folder?.agent?.position
  const memory = workspace.caseContextMemories.find(item => item.caseId === project.id)
  const task = folder?.agent?.task
  const running = task?.status === 'queued' || task?.status === 'processing'
  const noteKey = caseNoteKey(workspace.user.id, project.id)
  const [note, setNote] = useState(() => {
    try { return localStorage.getItem(noteKey) ?? '' } catch { return '' }
  })
  const [view, setView] = useState('brief')
  const timelineMaterials = view === 'timeline' ? workspace.evidences.filter(item => item.caseId === project.id) : []
  const timelineKey = JSON.stringify([noteKey, timelineMaterials.map(item => [item.id, item.name, item.fileName, item.duplicateOf,
    item.contentHash, item.sourceFingerprint, item.anchorHint, item.parsing?.revision, item.parsing?.artifactKey, item.parsing?.status])])
  const { todo } = groupReview(Object.values(project.els).flat())
  const snapshots = verifiedCaseMemory(workspace, project.id)
  const calculations = snapshots.flatMap(item => item.calculation && item.verdict !== 'fail' && item.verdict !== 'miss'
    ? [{ item, calculation: item.calculation }] : [])
  const assistantAudits = app.audits.filter(item => item.caseId === project.id && !item.certificateId)
  const sourceButtons = (sources: typeof snapshots[number]['sources']) => sources.map((source, index) => <Button size="sm" variant="outline" key={`${source.id}:${index}`}
    onClick={() => app.setDrawer({ st: 'l1', targetId: source.id, name: source.name, loc: source.locator ?? '', quote: source.quote ?? '' })}>{source.name} · {source.locator}</Button>)
  const ask = (prompt: string) => <Button size="sm" variant="ghost" onClick={() => onAssistant(prompt)}><Sparkles size={14} />问 AI</Button>
  const focus = (id: string, elementId = '') => {
    app.switchDocument(id)
    app.select(elementId)
    onBack()
  }
  const saveNote = () => {
    try { localStorage.setItem(noteKey, note); app.toast('律师笔记已保存在本机') }
    catch { app.setError('无法保存律师笔记，请检查本机存储空间。') }
  }

  return <main className="case-memory-scroll">
    <div className="case-memory-content">
      <header className="case-memory-heading">
        <div><p>案件记忆{memory && ` · 第 ${memory.version} 版 · ${new Date(memory.updatedAt).toLocaleString('zh-CN')}`}</p><h1>{project.name}</h1>
          <span>{[basics?.court || folder?.description, basics?.caseNumber, basics?.cause].filter(Boolean).join(' ｜ ')}</span></div>
        <div className="case-memory-actions">
          <Button variant="outline" disabled={!folder} onClick={() => app.setForm({ tab: 'proj', id: project.id })}>编辑案件信息</Button>
          <Button variant="outline" disabled={app.busy || running || !project.mats.length}
            onClick={() => void app.run(() => api.retryCaseAgent(project.id, folder?.agent?.autoAnalyze !== false), '已提交案件梳理')}>
            <RefreshCw size={14} />{running ? '正在梳理' : '重新梳理案件'}
          </Button>
        </div>
      </header>
      {task?.status === 'failed' && <p role="alert" className="text-fail">{task.error || '案件记忆梳理失败，请重试。'}</p>}
      <Tabs value={view} onValueChange={setView} className="case-memory-tabs">
        <TabsList aria-label="案件记忆分区">
          {views.map(([id, label]) => <TabsTrigger value={id} key={id} aria-label={id === 'risks' && todo.length ? `${label}，${todo.length} 项` : label}>
            {label}{id === 'risks' && todo.length > 0 && <span className="case-memory-risk-count">{todo.length}</span>}
          </TabsTrigger>)}
        </TabsList>
        <TabsContent value="brief" className="case-memory-grid">
          <MemoryCard title="本案一句话" wide action={ask('请概括本案案情与当前最需要核实的事实。')}>
            <p>{memory?.summary || '链接并解析材料后，可梳理案件摘要。'}</p>
            <div className="case-memory-metrics">
              <span><b>{project.mats.length}</b> 份卷内材料</span><span><b>{project.docs.length}</b> 份文书</span>
              <button type="button" onClick={() => setView('evidence')}><b>{snapshots.length}</b> 条声明有卷内出处 <ArrowRight size={12} /></button>
              <button type="button" onClick={() => setView('risks')}><b>{todo.length}</b> 项待处理 <ArrowRight size={12} /></button>
            </div>
          </MemoryCard>
          <MemoryCard title="代理立场" action={<Button variant="outline" size="sm" onClick={() => onAssistant()}>{position ? '调整立场' : '设置立场'}</Button>}>
            <p>{position ? `代理当事人 · ${position.party}（${caseRoleLabels[position.role]}）` : '尚未确认代理立场。'}</p>
            {position && <MemoryList values={position.goals} empty="暂无办案目标。" />}
            <Button size="sm" variant="outline" onClick={onDraft}><Sparkles size={14} />按立场起草</Button>
          </MemoryCard>
          <MemoryCard title="律师笔记" action={<Button size="sm" variant="outline" onClick={saveNote}>保存笔记</Button>}>
            <Textarea aria-label="律师笔记" placeholder="记录本案的工作思路…" value={note} maxLength={20000} onChange={event => setNote(event.target.value)} />
            <small>笔记保存在本机，使用 AI 助手问答、起草或改写时自动作为案件上下文发送给模型。</small>
          </MemoryCard>
          <MemoryCard title="文书进度">
            {project.docs.length ? <ul className="case-memory-documents">{project.docs.map(id => {
              const elements = project.els[id] ?? []
              return <li key={id}><button type="button" className="case-memory-link" onClick={() => focus(id)}>
                {project.docNames[id]}<small>{groupReview(elements).processed}/{elements.length} 项已处理</small><ArrowRight size={14} /></button></li>
            })}</ul> : <p className="review-view-empty">本案暂无文书。</p>}
          </MemoryCard>
          <MemoryCard title="关键人物"><MemoryList values={[...new Set([...(memory?.parties ?? []), ...(memory?.keyPersons ?? [])])]} /></MemoryCard>
          {basicRows.length > 0 && <MemoryCard title="案件基本信息" wide>
            <dl className="case-basic-fields">{basicRows.map(([label, value]) => <div key={label}>
              <dt>{label}</dt><dd>{value}</dd>
            </div>)}</dl>
          </MemoryCard>}
        </TabsContent>
        <TabsContent value="focus" className="case-memory-grid">
          <MemoryCard title="争议焦点" action={ask('请结合代理立场，梳理主要争议焦点。')}><MemoryList values={memory?.disputeFocuses} /></MemoryCard>
          <MemoryCard title="主张与抗辩"><MemoryList values={memory?.claimsAndDefenses} /></MemoryCard>
          <MemoryCard title="代理目标"><MemoryList values={position?.goals} /></MemoryCard>
          <MemoryCard title="待核实事实"><MemoryList values={memory?.disputedFacts} /></MemoryCard>
        </TabsContent>
        <TabsContent value="timeline" className="case-memory-grid">
          <MemoryCard title="事实时间线" wide action={ask('请核对本案时间线，按事件给出对应材料和定位。')}>
            <div className="case-memory-timeline">
              {view === 'timeline' && <CaseTimeline key={timelineKey} caseId={project.id} materials={timelineMaterials} />}
            </div>
          </MemoryCard>
          {Boolean(memory?.timeline?.length) && <MemoryCard title="记忆中的事件线索（待核）" wide>
            <MemoryList values={memory?.timeline} ordered />
          </MemoryCard>}
        </TabsContent>
        <TabsContent value="evidence" className="case-memory-grid">
          <MemoryCard title="证据支持矩阵" wide action={ask('请梳理本案证据支持关系和需要补证的事项。')}>
            {snapshots.length ? <table className="case-memory-evidence-table" aria-label="证据支持矩阵">
              <thead><tr><th scope="col">文书声明</th><th scope="col">卷内出处</th><th scope="col">核验状态</th></tr></thead>
              <tbody>{snapshots.map(item => {
                const verdict = project.els[item.certificateId]?.find(element => element.id === item.id)?.verdict ?? item.verdict
                return <tr key={item.id}>
                  <td><button type="button" className="case-memory-link" onClick={() => focus(item.certificateId, item.id)}>{item.quote}</button><small>{item.certificateTitle}</small></td>
                  <td><div className="case-memory-links">{sourceButtons(item.sources)}</div></td>
                  <td data-verdict={verdict}>{STATUS_NAMES[verdict]}</td>
                </tr>
              })}</tbody>
            </table> : <p className="review-view-empty">暂无带可回查原文的当前核验结果。</p>}
          </MemoryCard>
          <MemoryCard title="待核对的记忆线索" wide>
            {memory?.supportMatrix.length ? <ul className="case-memory-list">{memory.supportMatrix.map((row, index) => (
              <li key={index}><p>{row.fact}</p><div className="case-memory-links">
                {row.evidenceIds.map(id => {
                  const source = project.mats.find(item => item.id === id)
                  return source && <Button size="sm" variant="outline" key={id}
                    onClick={() => app.setDrawer({ st: 'l1', targetId: id, name: source.n, loc: source.sub, quote: '' })}>{source.n}</Button>
                })}
                {!row.evidenceIds.some(id => project.mats.some(item => item.id === id)) && <small>缺少可打开的材料</small>}
              </div></li>
            ))}</ul> : <p className="review-view-empty">暂无证据地图。</p>}
          </MemoryCard>
          <MemoryCard title="证据薄弱点" wide><MemoryList values={memory?.evidenceWeaknesses} /></MemoryCard>
        </TabsContent>
        <TabsContent value="amounts" className="case-memory-grid">
          <MemoryCard title="核验复算" wide action={ask('请复核本案关键金额，逐项列出计算口径、算式和证据。')}>
            {calculations.length ? <ul className="case-memory-list">{calculations.map(({ item, calculation }) => (
              <li key={item.id}>
                <button type="button" className="case-memory-link" onClick={() => focus(item.certificateId, item.id)}>{item.quote}<small>{item.certificateTitle}</small><ArrowRight size={14} /></button>
                <p>{formatVerificationCalculation(calculation)}</p>
                <div className="case-memory-links">{sourceButtons(calculation.sources ?? item.sources)}</div>
              </li>
            ))}</ul> : <p className="review-view-empty">暂无可回查的复算结果。</p>}
          </MemoryCard>
          <MemoryCard title="关键金额（待核对）"><MemoryList values={memory?.keyAmounts} /></MemoryCard>
          <MemoryCard title="资金往来（待核对）"><MemoryList values={memory?.paymentFlow} /></MemoryCard>
        </TabsContent>
        <TabsContent value="risks" className="case-memory-grid">
          {assistantAudits.length > 0 && <MemoryCard title="案件助手操作记录" wide>
            <ul className="case-memory-list">{assistantAudits.map(item => <li key={item.id}>
              <time dateTime={item.t}>{new Date(item.t).toLocaleString('zh-CN')}</time> · {item.account} · {item.msg}
            </li>)}</ul>
          </MemoryCard>}
          <MemoryCard title="核验待办" wide action={ask('请梳理本案核验风险，列出优先处理及补证事项。')}>
            <ul className="case-memory-list">{todo.map(item => <li key={item.id}>
              <button type="button" className="case-memory-link" onClick={() => focus(item.certificateId, item.id)}>
                {item.quote}<small>{project.docNames[item.certificateId]}</small><ArrowRight size={14} /></button>
            </li>)}</ul>
            {!todo.length && <p className="review-view-empty">暂无待处理的声明。</p>}
          </MemoryCard>
          <MemoryCard title="程序风险"><MemoryList values={memory?.proceduralRisks} /></MemoryCard>
          <MemoryCard title="矛盾与待查问题"><MemoryList values={[...(memory?.contradictions ?? []), ...(memory?.openQuestions ?? [])]} /></MemoryCard>
        </TabsContent>
      </Tabs>
    </div>
  </main>
}
