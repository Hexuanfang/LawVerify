import { useState } from 'react'
import { Tabs } from 'radix-ui'
import profile from '../../../server/src/intelligence/verification/doc-element-profile.json'
import { declarationEditRange } from '../../../server/src/intelligence/verification/review-status.ts'
import { useApp } from './AppContext'
import { Button } from './components/ui/button'
import { groupReview } from './reviewOverview'
import { wordExportReadiness } from './workflow'

const tabs = [
  ['todo', '待办'],
  ['warnings', '预警'],
  ['annotated', '标注'],
  ['passed', '已通过'],
] as const

type ReviewView = typeof tabs[number][0]
const statusLabels = {
  fail: '不通过',
  miss: '不通过 · 缺源',
  pending: '待核验',
  warn: '预警',
  note: '通过 · 标注',
  pass: '通过',
}

export function ReviewTodos({ hidden }: { hidden: boolean }) {
  const app = useApp()
  const [view, setView] = useState<ReviewView>('todo')
  const groups = groupReview(app.elements)
  const total = app.elements.length
  const blocking = groups.required.length + groups.pending.length
  const processed = total - blocking
  const percentage = total ? Math.round(processed / total * 100) : 0
  const optional = groups.warnings.filter(item => !item.ignored).length
  const rows = {
    todo: groups.todo,
    warnings: groups.warnings,
    annotated: groups.passed.filter(item => item.verdict === 'note'),
    passed: groups.passed.filter(item => item.verdict === 'pass'),
  }
  const { certificate, workspace } = app
  const paragraphNumbers = new Map(certificate?.paragraphs.map((item, index) => [item.id, index + 1]))
  const readiness = !blocking && total && workspace && certificate
    ? wordExportReadiness(workspace, certificate.id) : undefined
  const caption = blocking ? '先处理不通过和待核验，才能导出 Word。'
    : readiness?.allowed ? '必处理项已清零，可导出 Word。'
    : readiness?.reason || '必处理项已清零。'
  const startDraft = () => app.setAssistantRequest({ mode: 'document' })

  return <section className="review-todos" hidden={hidden} aria-labelledby="review-todos-heading">
    <h2 id="review-todos-heading" className="review-pane-head">核验待办</h2>
    <div className="rp review-todos-content">
      {!certificate ? <p className="review-view-empty">导入或起草文书后，这里会列出核验待办。</p>
        : !total ? <div className="review-todos-empty">
          <h3>暂无核验结果</h3>
          <p className="review-view-empty">运行 AI 核验后，可以在这里处理需要复核的声明。</p>
          <Button className="btn btn-pri btn-sm" disabled={app.busy}
            onClick={async () => { if (await app.prepareDocument()) void app.verify() }}>AI 核验当前文书</Button>
        </div> : <>
          <div className="review-todos-progress" data-blocking={blocking > 0}>
            <span className="review-todos-count"><strong>{blocking}</strong> 项待办</span>
            <span>{processed}/{total} 已处理 · {percentage}%</span>
            <progress max={total} value={processed} aria-label="核验待办处理进度" />
            <p>{caption}</p>
          </div>
          <Tabs.Root value={view} onValueChange={value => setView(value as ReviewView)}>
            <Tabs.List className="review-todo-tabs" aria-label="核验结果筛选">
              {tabs.map(([key, label]) => <Tabs.Trigger value={key} key={key}>
                {label} <b>{key === 'todo' ? blocking : rows[key].length}</b>
              </Tabs.Trigger>)}
            </Tabs.List>
            {tabs.map(([key]) => <Tabs.Content className="review-todo-list" value={key} key={key}>
              {key === view && (rows[key].length ? rows[key].map(element => {
                const paragraph = paragraphNumbers.get(element.paragraphId)
                const category = profile.elementTypes[element.type as keyof typeof profile.elementTypes] ?? element.type
                const suggestion = element.declaration && element.sources.length
                  ? declarationEditRange(element.original.text, element.declaration, 'adopt')?.replacement : undefined
                return <button type="button" key={element.id} className="review-todo-card" data-verdict={element.verdict} data-type={element.type}
                  onClick={() => {
                    app.setFilter('all')
                    app.select(element.id)
                  }}>
                  <span className="review-todo-meta">
                    <b>{statusLabels[element.verdict]}</b>
                    <span>{category}</span>
                    <span className="review-todo-location">{paragraph ? `第 ${paragraph} 段` : '正文'}</span>
                  </span>
                  <b className="review-todo-reason">{element.reason || '等待处理'}</b>
                  <small className="review-todo-quote">{element.quote}</small>
                  {view === 'annotated' && element.note && <small className="review-todo-note">批注 · {element.note}</small>}
                  {suggestion && <small className="review-todo-fix">建议改为：{suggestion}</small>}
                  {element.ignored && <small className="review-todo-note">已忽略，仍保留在报告</small>}
                  <span className="review-todo-open">处理 →</span>
                </button>
              }) : <p className="review-view-empty">此分组暂无条目。</p>)}
            </Tabs.Content>)}
          </Tabs.Root>
          {view === 'todo' && optional > 0 && <details className="review-todo-warnings">
            <summary>预警 {optional} 项 · 可选复核，不阻断导出</summary>
            <Button type="button" variant="ghost" size="sm" onClick={() => setView('warnings')}>查看全部预警</Button>
          </details>}
          <div className="review-todo-actions">
            <Button className="btn btn-pri btn-sm" disabled={app.busy} onClick={async () => {
              if (await app.prepareDocument()) {
                app.setAssistantRequest(null)
                app.setPage('report')
              }
            }}>{readiness?.allowed ? '查看报告并导出 Word' : '查看核验报告'}</Button>
            <Button variant="ghost" size="sm" disabled={app.busy} onClick={startDraft}>＋ AI 起草</Button>
          </div>
        </>}
    </div>
  </section>
}
