import { ArrowRight, BookOpen, BriefcaseBusiness, ChevronDown, FileText, FolderOpen, Layers3, Plus, Scale, ShieldCheck } from 'lucide-react'
import { Button } from './components/ui/button'
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from './components/ui/hover-card'
import { useApp, type LibTab } from './AppContext'
import { counts } from './model'

export function Brand({
  title = 'LawVerify',
  size = 26,
}: {
  title?: string
  size?: number
}) {
  return (
    <div className="brand">
      <div
        className="seal"
        style={{ width: size, height: size, borderRadius: 6 }}
      >
        <img src="/lawverify-icon.svg" alt="" />
      </div>
      <div className="brand-name">{title}</div>
    </div>
  )
}

export function Home() {
  const app = useApp()
  const steps = [
    ['选案件、链接目录', '链接本地案件材料文件夹，自动同步合同、流水、聊天记录与判决书。'],
    [
      '选文书，点「AI 智能核验」',
      '起诉状 / 答辩状 / 证据清单 / 质证意见 / 代理词 / 上诉状。',
    ],
    ['点高亮，看联动依据', '橙=原材料 · 蓝=法条 · 青=案例；红灯红底。'],
    ['确认、修改、批注', '红灯必须人工处理；改声明可局部重核；操作留痕。'],
    ['导出带批注 Word', '审阅版（红黄批注）或 清洁版 + 核验报告。⌘E'],
  ]
  const continueLast = () => {
    let previous: { caseId?: string; docId?: string } = {}
    try {
      previous = JSON.parse(
        localStorage.getItem(`lawverify-new-last:${app.workspace?.user.id}`) ||
          '{}',
      )
    } catch {
      /* 无有效历史时使用首个案件。 */
    }
    const target =
      app.projects.find((item) => item.id === previous.caseId) ??
      app.projects[0]
    if (target) app.enter(target.id, previous.docId)
    else app.setForm({ tab: 'proj' })
  }
  const documents = app.projects.reduce((sum, project) => sum + project.docs.length, 0)
  const materials = app.projects.reduce((sum, project) => sum + project.mats.length, 0)
  return (
    <div className="page active" id="pg-home">
      <div className="home">
        <div className="home-in fade">
          <header className="home-header">
            <div className="home-identity">
              <Brand size={34} />
              <span className="home-product">文书证据核验工作台</span>
            </div>
            <Button className="btn home-create" onClick={() => app.setForm({ tab: 'proj' })}>
              <Plus size={16} />新建核验案件
            </Button>
          </header>
          <section className="home-welcome" aria-labelledby="home-heading">
            <div>
              <span className="home-eyebrow">案件工作空间</span>
              <h1 id="home-heading">每一句主张，<em>有据可查。</em></h1>
              <p>从文书到证据，让每一处事实、法条与案例的依据清晰可循。</p>
            </div>
            <div className="home-overview" aria-label="工作区概览">
              {[
                { label: '案件', value: app.projects.length, Icon: BriefcaseBusiness },
                { label: '文书', value: documents, Icon: FileText },
                { label: '材料', value: materials, Icon: Layers3 },
              ].map(({ label, value, Icon }) => (
                <div className="home-metric" key={label}>
                  <span><Icon size={15} />{label}</span>
                  <strong>{value}<small>{label === '案件' ? '个案件' : '份' + label}</small></strong>
                </div>
              ))}
            </div>
          </section>
          <section className="home-resume" aria-label="开始核验">
            <div className="home-resume-icon"><ShieldCheck size={26} /></div>
            <div className="home-resume-copy">
              <h2>{app.projects.length ? '接着上次的工作，继续核验' : '从第一个案件，开始有据可查的核验'}</h2>
              <p>{app.projects.length ? '回到案件，核对文书主张与原始材料，处理待审阅内容。' : '新建案件，链接材料目录并导入待核验文书，建立案件级证据关联。'}</p>
            </div>
            <Button className="btn home-resume-button" onClick={continueLast}>
              {app.projects.length ? '继续上次核验' : '新建核验案件'}<ArrowRight size={16} />
            </Button>
          </section>
          <section className="home-cases" aria-labelledby="home-cases-heading">
            <div className="home-section-heading">
              <div><h2 id="home-cases-heading">我的案件</h2><span>{app.projects.length} 个案件</span></div>
              <span className="home-section-hint">选择案件，进入核验工作台</span>
            </div>
            <div className="case-grid">
              {app.projects.map((project) => {
                const total = counts(Object.values(project.els).flat())
                return (
                  <button type="button" key={project.id} className="case-card" onClick={() => app.enter(project.id)}>
                    <div className="home-case-top">
                      <span className="home-case-icon"><FolderOpen size={20} /></span>
                      <span className="home-case-open">进入案件<ArrowRight size={14} /></span>
                    </div>
                    <div className="case-name">{project.name}</div>
                    <div className="home-case-court">{project.court || '尚未填写法院信息'}</div>
                    <div className="case-meta">
                      <span><FileText size={13} />{project.docs.length} 份文书</span>
                      <span><Layers3 size={13} />{project.mats.length} 份材料</span>
                    </div>
                    <div className="home-case-status" aria-label="核验状态汇总">
                      {total.all ? <>
                        <span><i className="color-pass" />通过 {total.pass}</span>
                        <span><i className="color-warn" />预警 {total.warn}</span>
                        <span><i className="color-fail" />不通过 / 缺源 {total.fail}</span>
                      </> : <span>暂无核验记录</span>}
                    </div>
                    <div className="case-foot"><span>更新 {project.date}</span><span>查看详情 →</span></div>
                  </button>
                )
              })}
              <button type="button" className="case-card hint-new" onClick={() => app.setForm({ tab: 'proj' })}>
                <span className="home-new-icon"><Plus size={23} /></span>
                <b>新建核验案件</b>
                <span>归集文书与材料，开始新的核验</span>
              </button>
            </div>
          </section>
          <details className="home-guide">
            <summary><BookOpen size={17} /><b>第一次使用 LawVerify？</b><span>查看核验流程</span><ChevronDown size={16} /></summary>
            <div className="home-guide-steps">
              {steps.map(([title, text], index) => (
                <div className="gstep" key={title}>
                  <div className="gn">{index + 1}</div>
                  <div><b>{title}</b><span>{text}</span></div>
                </div>
              ))}
            </div>
          </details>
          <footer className="home-footer"><ShieldCheck size={14} />支持 PDF、Word 与图片材料<span>·</span>AI 核验结果需由律师审阅确认</footer>
        </div>
      </div>
    </div>
  )
}
export function Dock() {
  const app = useApp()
  if (['proc', 'ws', 'report'].includes(app.page)) return null
  const open = (tab: LibTab) => {
    app.setLibTab(tab)
    app.setPage('lib')
  }
  const name = app.workspace?.user.name || '律师'
  return (
    <div className="dock">
      <HoverCard openDelay={80} closeDelay={150}>
        <HoverCardTrigger asChild>
          <button className="dock-ava" onClick={() => open('acct')}>
            <div className="av">{name[0]}</div>
            <div>
              <b>{name}</b>
              <span>账号与团队</span>
            </div>
          </button>
        </HoverCardTrigger>
        <HoverCardContent side="top" align="start" className="new-dock-menu">
          {(
            [
              ['law', '法条库', '效力版本 · 可维护', Scale],
              ['case', '案例库', '四要素 · 可维护', BookOpen],
              ['proj', '案件库', '在办案件 · 归档', BriefcaseBusiness],
            ] as const
          ).map(([key, title, detail, Icon]) => (
            <button
              key={key}
              className={`dock-it source-${key}`}
              onClick={() => open(key)}
            >
              <div className="ic">
                <Icon size={19} />
              </div>
              <div>
                <b>{title}</b>
                <span>{detail}</span>
              </div>
            </button>
          ))}
        </HoverCardContent>
      </HoverCard>
    </div>
  )
}
