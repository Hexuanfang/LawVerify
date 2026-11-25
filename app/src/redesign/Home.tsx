import { useMemo, useState } from 'react'
import { ArrowRight, FileText, Pencil, Plus, Trash2 } from 'lucide-react'
import { Button } from './components/ui/button'
import { useApp } from './AppContext'
import { CaseDeleteDialog, type CaseDeleteTarget } from './CaseDeleteDialog'
import { groupReview } from './reviewOverview'

export function Brand({
  title,
  size = 26,
}: {
  title?: string
  size?: number
}) {
  if (title === undefined) {
    return (
      <span className="brand">
        <img className="brand-wordmark" src="/lawverify-wordmark.svg" alt="LawVerify" width={Math.round(size * 478 / 137)} height={size} />
      </span>
    )
  }

  return (
    <span className="brand">
      <span
        className="seal"
        style={{ width: size, height: size, borderRadius: 6 }}
      >
        <img src="/lawverify-icon.svg" alt="" />
      </span>
      <span className="brand-name">{title}</span>
    </span>
  )
}

export function BrandHome({ onHome }: { onHome: () => void }) {
  return (
    <button type="button" className="brand-home" aria-label="LawVerify 首页" title="返回首页" onClick={onHome}>
      <Brand />
    </button>
  )
}

const steps = [
  ['新建案件，选择任务', '选择 AI 核验已有文书或 AI 起草新文书。'],
  ['备齐卷内材料', '链接本地材料，再导入待核验文书或设置代理立场。'],
  ['处理待办，导出 Word', '对照原件、法条和类案核查文书，审阅后生成交付文件。'],
]

const samples = [
  { name: '王某诉李某 · 民间借贷纠纷', quote: '被告于 2023 年 4 月 1 日支付利息 30,000 元。', source: '招商银行流水 · 2023 年 4 月 11 日收到 35,000 元。', status: '日期与金额冲突', action: '对照流水核实付款日期和利息金额后重核。' },
  { name: '买卖合同纠纷', quote: '被告法定代表人亲自签收并组织验收。', source: '送货单与验收单 · 签收人为库管员刘某。', status: '签收人待复核', action: '核实签收人的身份及权限，并按原件修改文书。' },
]

export function Home() {
  const app = useApp()
  const { projects } = app
  const [pendingDelete, setPendingDelete] = useState<CaseDeleteTarget | null>(null)
  const pendingByCase = useMemo(() => new Map(projects.map(project => {
    const { required, pending } = groupReview(Object.values(project.els).flat())
    return [project.id, required.length + pending.length]
  })), [projects])
  const create = () => app.setForm({ tab: 'proj' })
  let previous = { caseId: app.caseId, docId: app.docId }
  try {
    if (!previous.caseId) {
      const saved = localStorage.getItem(`lawverify-new-last:${app.workspace?.user.id}`)
      if (saved) previous = JSON.parse(saved) ?? previous
    }
  } catch {
    // 历史记录不可用时仍可从案件列表进入。
  }
  const last = projects.find(project => project.id === previous.caseId)
  return (
    <div className="page active" id="pg-home">
      <main className="home">
        <div className="home-in fade mvp-home-page">
          <header className="home-header">
            <Brand size={30} />
            <span>律师工作台</span>
          </header>
          <section className="home-intro">
            <div>
              <h1 id="home-heading">文书核验与起草</h1>
              <p>逐句核验证据联动，按代理立场起草，跨文书复用案件记忆。</p>
              <div className="home-intro-actions">
                <Button className="btn btn-pri home-create" onClick={create}><Plus size={16} />新建案件</Button>
                {last && <Button variant="ghost" onClick={() => app.enter(last.id, previous.docId)}>继续上次工作 <ArrowRight size={14} /></Button>}
              </div>
            </div>
            <section className="home-steps" aria-labelledby="home-steps-title">
              <h2 id="home-steps-title">如何开始</h2>
              <ol>{steps.map(([title, description]) => <li key={title}><b>{title}</b><p>{description}</p></li>)}</ol>
            </section>
          </section>
          <section aria-labelledby="home-cases-heading">
            <div className="home-case-heading">
              <h2 id="home-cases-heading">我的案件</h2><span>{projects.length} 件</span>
            </div>
            {projects.length ? (
              <ul className="mvp-case-list">
                {projects.map(project => {
                  const todo = pendingByCase.get(project.id) ?? 0
                  return <li key={project.id}>
                    <span className="home-case-icon"><FileText size={17} aria-hidden="true" /></span>
                    <div className="home-case-info">
                      <div className="home-case-title">
                        <button type="button" className="case-card case-name" title={project.name} onClick={() => app.enter(project.id)}>{project.name}</button>
                        <Button type="button" variant="outline" size="sm" className="case-edit" title="编辑案件信息"
                          aria-label={`编辑案件：${project.name}`} onClick={() => app.setForm({ tab: 'proj', id: project.id })}>
                          <Pencil size={12} aria-hidden="true" />编辑
                        </Button>
                        <Button type="button" variant="outline" size="sm" className="case-delete" title="删除案件"
                          aria-label={`删除案件：${project.name}`} onClick={event => setPendingDelete({
                            id: project.id, name: project.name, docs: project.docs, trigger: event.currentTarget,
                          })}>
                          <Trash2 size={12} aria-hidden="true" />删除
                        </Button>
                      </div>
                      <small>{project.mats.length} 份材料 · {project.docs.length} 份文书</small>
                    </div>
                    {todo > 0 && <span className="home-case-pending">{todo} 项待处理</span>}
                    <span className="home-case-open" aria-hidden="true"><span>进入工作台</span><ArrowRight size={15} /></span>
                  </li>
                })}
              </ul>
            ) : <p className="home-case-empty">暂无案件。点击「新建案件」开始。</p>}
          </section>
          <section className="home-samples" aria-labelledby="home-samples-heading">
            <div className="home-case-heading"><h2 id="home-samples-heading">示例案件</h2><span>内置演示</span></div>
            <div className="home-sample-list">{samples.map(sample => <details className="home-sample" key={sample.name}>
              <summary><FileText size={16} aria-hidden="true" /><b>{sample.name}</b><span>体验示例</span></summary>
              <div><b>{sample.status}</b><p>文书声明 · {sample.quote}</p><p>原材料 · {sample.source}</p><p>{sample.action}</p></div>
            </details>)}</div>
          </section>
        </div>
      </main>
      <CaseDeleteDialog target={pendingDelete} onClose={() => setPendingDelete(null)} />
    </div>
  )
}

export function Dock() {
  const app = useApp()
  if (app.page !== 'home') return null
  const name = app.cloudProfile?.user.name || app.workspace?.user.name || '律师'
  return (
    <div className="dock">
      <button type="button" className="dock-ava" onClick={() => {
        app.setLibTab('acct')
        app.setPage('lib')
      }}>
        <span className="av" aria-hidden="true">{name[0]}</span>
        <span><b>{name}</b><span>账号设置</span></span>
      </button>
    </div>
  )
}
