import { useState, type ReactNode } from 'react'
import { Tabs } from 'radix-ui'
import profile from '../../../server/src/intelligence/verification/doc-element-profile.json'
import { declarationEditRange } from '../../../server/src/intelligence/verification/review-status.ts'
import { useApp } from './AppContext'
import { Button } from './components/ui/button'
import { currentReviewFinding, groupReview, reviewStatusLabel } from './reviewOverview'
import { wordExportReadiness } from './workflow'

const tabs = [
  ['todo', '待办'],
  ['warnings', '预警'],
  ['annotated', '标注'],
  ['passed', '已通过'],
] as const

type ReviewView = typeof tabs[number][0]

export function ReviewTodos({ detail, hasResults, onOpen }: {
  detail: ReactNode
  hasResults: boolean
  onOpen: (id: string) => void
}) {
  const app = useApp()
  const [view, setView] = useState<ReviewView>('todo')
  if (detail) return detail

  const { certificate, workspace, elements } = app
  const groups = groupReview(elements)
  const total = elements.length
  const blocking = groups.required.length + groups.pending.length
  const processed = total - blocking
  const percentage = total ? Math.round(processed / total * 100) : 0
  const optional = groups.warnings.filter(item => !item.ignored).length
  const rows = {
    todo: groups.todo,
    warnings: groups.warnings,
    annotated: elements.filter(item => item.verdict === 'note'),
    passed: groups.passed.filter(item => item.verdict === 'pass'),
  }
  const paragraphNumbers = new Map(certificate?.paragraphs.map((item, index) => [item.id, index + 1]))
  const readiness = !blocking && total && workspace && certificate && wordExportReadiness(workspace, certificate.id)
  const caption = blocking ? '先处理不通过和待核验，才能导出 Word。'
    : readiness && !readiness.allowed ? readiness.reason : '必处理项已清零，可导出 Word。'

  return <section className="review-todos" aria-labelledby="review-todos-heading">
    <header className="review-pane-head">
      <h2 id="review-todos-heading" tabIndex={-1}>核验待办</h2>
    </header>
    <div className="review-todos-content">
      {!certificate ? <p className="review-view-empty">导入或起草文书后，这里按律师核验重点列出待办。</p>
        : !hasResults ? <div className="review-todos-empty">
          <h3>暂无核验结果</h3>
          <p className="review-view-empty">运行 AI 核验后，这里只列需要处理的声明。</p>
          <Button className="btn btn-pri btn-sm" disabled={app.busy}
            onClick={async () => { if (await app.prepareDocument()) void app.verify() }}>AI 核验当前文书</Button>
        </div> : <>
          <div className="review-todos-progress" data-blocking={blocking > 0}>
            <div className="review-todos-meter">
              <span className="review-todos-count"><strong>{blocking}</strong> 项待办</span>
              <small>{processed}/{total} 已处理 · {percentage}%</small>
            </div>
            <progress max={total} value={processed} aria-label="核验条目处理进度" />
            <p className="review-view-empty">{caption}</p>
          </div>
          <Tabs.Root value={view} onValueChange={value => setView(value as ReviewView)}>
            <Tabs.List className="review-todo-tabs" aria-label="核验结果筛选">
              {tabs.map(([key, label]) => <Tabs.Trigger value={key} key={key}>
                {label}{' '}<b>{key === 'todo' ? blocking : rows[key].length}</b>
              </Tabs.Trigger>)}
            </Tabs.List>
            {tabs.map(([key]) => <Tabs.Content className="review-todo-list" value={key} key={key}>
              {rows[key].length ? rows[key].map(element => {
                const paragraph = paragraphNumbers.get(element.paragraphId)
                const category = profile.elementTypes[element.type as keyof typeof profile.elementTypes] ?? element.type
                const finding = currentReviewFinding(certificate, element)
                const suggestion = finding && declarationEditRange(element.original.text, finding, 'adopt')?.replacement
                return <button key={element.id} type="button" className="review-todo-card"
                  data-verdict={element.verdict} data-type={element.type} data-element-id={element.id}
                  onClick={() => onOpen(element.id)}>
                  <b className="review-todo-tag">{reviewStatusLabel(element)}</b>
                  <span className="review-todo-type">{category}</span>
                  <span className="review-todo-location">{paragraph ? `第 ${paragraph} 段` : '正文'}</span>
                  <b className="review-todo-reason">{element.reason || '等待处理'}</b>
                  <small className="review-todo-quote">{element.quote}</small>
                  {suggestion && <span className="review-todo-fix">建议改为：{suggestion}</span>}
                  <span className="review-todo-go">处理 →</span>
                </button>
              }) : <p className="review-view-empty">此分组暂无条目。</p>}
            </Tabs.Content>)}
          </Tabs.Root>
          {view === 'todo' && optional > 0 && <details className="review-todo-warnings">
            <summary>预警 {optional} 项 · 可选复核，不阻断导出</summary>
          </details>}
        </>}
    </div>
  </section>
}
