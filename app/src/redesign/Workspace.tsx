import { lazy, Suspense, useEffect, useState } from 'react'
import { EVIDENCE_PARSING_LABELS } from '../types'
import { ChevronDown, FileText, Search } from 'lucide-react'
import { Button } from './components/ui/button'
import { Input } from './components/ui/input'
import { Textarea } from './components/ui/textarea'
import { Tabs, TabsList, TabsTrigger } from './components/ui/tabs'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './components/ui/dropdown-menu'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from './components/ui/tooltip'
import { Brand } from './Home'
import { EssentialDialogs } from './EssentialDialogs'
import { DocumentPaper } from './DocumentPaper'
import { useApp } from './AppContext'
import { DOCUMENT_TYPES, STATUS_NAMES, type ReviewElement } from './model'

const CaseAssistant = lazy(() => import('./CaseAssistant').then(module => ({ default: module.CaseAssistant })))
const DocumentAssistant = lazy(() => import('./DocumentAssistant').then(module => ({ default: module.DocumentAssistant })))

function Topbar() {
  const app = useApp()
  const project = app.project
  if (!project) return null
  return (
    <div className="topbar">
      <Brand />
      <div className="top-sep" />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" className="case-btn">
            <b>{project.name}</b>
            <ChevronDown size={14} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="new-case-menu">
          {app.projects.map((item) => (
            <DropdownMenuItem
              key={item.id}
              className={`case-opt ${item.id === project.id ? 'on' : ''}`}
              onSelect={async () => { if (await app.flushDocument()) app.enter(item.id) }}
            >
              <div className="case-letter">{item.name[0]}</div>
              <div>
                <div className="n">{item.name}</div>
                <div className="m">
                  {item.court} · {item.mats.length} 份材料
                </div>
              </div>
              <span className="ck">{item.id === project.id ? '✓' : ''}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <Tabs
        value={app.docId}
        onValueChange={async id => { if (await app.flushDocument()) app.switchDocument(id) }}
        className="doc-switch"
      >
        <TabsList className="new-doc-tabs">
          {project.docs.map((id) => (
            <TabsTrigger key={id} className="doc-tab" value={id}>
              {project.docNames[id]}
            </TabsTrigger>
          ))}
          {DOCUMENT_TYPES.filter(
            (type) =>
              !Object.values(project.docNames).some((name) =>
                name.includes(type),
              ),
          ).map((type) => (
            <button
              type="button"
              key={type}
              className="doc-tab dis"
              onClick={() => app.toast('本案暂未导入该文书，可点「导入待核验文书」')}
            >
              {type}
            </button>
          ))}
        </TabsList>
      </Tabs>
      <div className="filters">
        {[
          ['all', '全部'],
          ['pass', '绿'],
          ['warn', '黄'],
          ['fail', '红'],
        ].map(([value, title]) => (
          <Button
            variant="ghost"
            key={value}
            className={`fchip ${app.filter === value ? 'on' : ''}`}
            onClick={() => app.setFilter(value)}
          >
            {value !== 'all' && <i className={`dot color-${value}`} />}
            {title}
          </Button>
        ))}
      </div>
      <Button
        className="btn btn-pri btn-sm"
        disabled={!app.certificate}
        onClick={async () => { if (await app.prepareDocument()) app.setPage('report') }}
      >
        导出 Word
      </Button>
      <Button
        className="btn btn-gh btn-sm"
        disabled={app.busy || !app.certificate}
        onClick={async () => { if (await app.prepareDocument()) void app.verify() }}
      >
        ↻ 重核
      </Button>
      <Button
        variant="ghost"
        className="btn-txt"
        onClick={async () => { if (await app.flushDocument()) app.setPage('home') }}
      >
        首页
      </Button>
    </div>
  )
}

function Materials() {
  const app = useApp()
  const [query, setQuery] = useState('')
  const materials = (app.project?.mats ?? []).filter((item) =>
    `${item.n}${item.sub}`.toLowerCase().includes(query.toLowerCase()),
  )
  const groups = [...new Set(materials.map((item) => item.g))]
  return (
    <aside className="pane-l">
      <div className="pane-head">
        <div className="pane-t">
          案件原材料{' '}
          <span style={{ fontWeight: 400 }}>
            {app.project?.mats.length || 0} 份
          </span>
        </div>
        <div className="search">
          <Search size={13} />
          <Input
            className="new-search-input"
            placeholder="搜材料、金额、日期…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <Button
          variant="ghost"
          className="add-mat"
          onClick={() => app.setUploadCase(app.project?.id ?? null)}
        >
          本地文件夹联动
        </Button>
        <Button variant="ghost" className="add-doc" onClick={() => app.setDocumentCase(app.project?.id ?? null)}>
          导入待核验文书
        </Button>
      </div>
      <div className="mat-scroll">
        {groups.map((group) => (
          <div className="mat-g" key={group}>
            <div className="mat-gn">
              ▾ {group}
              <span className="n">
                {materials.filter((item) => item.g === group).length}
              </span>
            </div>
            {materials
              .filter((item) => item.g === group)
              .map((item) => (
                <button
                  className="mat-it"
                  key={item.id}
                  onClick={() =>
                    app.setDrawer({
                      st: 'l1',
                      targetId: item.id,
                      name: item.n,
                      loc: item.sub,
                      quote: '',
                    })
                  }
                >
                  <div className="fico l1">材</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="mat-nm">{item.n}</div>
                    <div className="mat-description">{item.sub}</div>
                    {item.parsingStatus && <div className="mat-description">{EVIDENCE_PARSING_LABELS[item.parsingStatus]}</div>}
                  </div>
                  <span className="mat-bd l1">L1</span>
                </button>
              ))}
          </div>
        ))}
        {!materials.length && <div className="lib-empty">未找到材料</div>}
      </div>
    </aside>
  )
}

function LinkageCard({ element }: { element: ReviewElement }) {
  const app = useApp()
  const [editing, setEditing] = useState(false)
  const [noteOpen, setNoteOpen] = useState(false)
  const [text, setText] = useState(element.quote)
  const [note, setNote] = useState(element.note)
  const sk = ['pass', 'note'].includes(element.verdict)
    ? 'ok'
    : element.verdict === 'warn'
      ? 'warn'
      : 'bad'
  const names = { l1: '案件原材料', l2: '法条', l3: '案例', l0: '未联动' }
  useEffect(() => {
    const handler = (event: Event) => {
      if (app.busy) return
      const op = (event as CustomEvent<string>).detail
      if (op === 'confirm') void app.confirm(element)
      if (op === 'reject') void app.reject(element)
      if (op === 'edit') setEditing(true)
    }
    window.addEventListener('lv-operation', handler)
    return () => window.removeEventListener('lv-operation', handler)
  }, [app, element])
  return (
    <div className={`rc st-${sk}`}>
      <div className="rc-h">
        <span className={`src-dot ${element.src}`} />
        <span className="rc-type">
          {element.type} · {names[element.src]}
        </span>
        {element.verified && <span className="user-tag">已确认</span>}
        <span className="rc-st">
          <i className={`color-${element.verdict}`} />
          {STATUS_NAMES[element.verdict]}
        </span>
      </div>
      <div className="rc-q">
        {editing ? (
          <>
            <Textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              aria-label="修改声明"
            />
            <div className="inline-actions">
              <Button
                className="op pri"
                disabled={app.busy}
                onClick={async () => {
                  if (await app.edit(element, text)) setEditing(false)
                }}
              >
                保存并局部重核
              </Button>
              <Button
                className="op"
                disabled={app.busy}
                onClick={() => {
                  setEditing(false)
                  setText(element.quote)
                }}
              >
                取消
              </Button>
            </div>
          </>
        ) : (
          element.quote
        )}
      </div>
      <div className="rc-reason">
        <b>一句话结论：</b>
        {element.reason}
      </div>
      <div className="conf">
        <span className="mat-description">置信度</span>
        <div className="conf-track">
          <i
            className={`color-${element.verdict}`}
            style={{ width: `${element.conf ?? 0}%` }}
          />
        </div>
        <span className="conf-num">
          {element.conf === null ? '—' : `${element.conf}%`}
        </span>
      </div>
      {element.sources.map((source, index) => (
        <button
          className="rc-loc"
          key={`${source.targetId}-${index}`}
          onClick={() => app.setDrawer(source)}
        >
          <span className={`src-dot ${source.st}`} />
          <span className="nm">{source.name}</span>
          <span className="mat-description">· {source.loc}</span>
          <span className="source-preview-link">预览 →</span>
        </button>
      ))}
      {!element.sources.length && (
        <div className="rc-loc text-fail">
          <span className="src-dot color-fail" />
          未找到出处 · AI 不编造
        </div>
      )}
      {element.verdict === 'fail' && element.sources[0]?.quote && (
        <div className="diff">
          <div className="diff-r">
            <div className="h">对照</div>
            <div className="h">文书声明</div>
            <div className="h">出处原文</div>
          </div>
          <div className="diff-r">
            <div className="h">内容</div>
            <div className="bad">{element.quote}</div>
            <div className="good">{element.sources[0].quote}</div>
          </div>
        </div>
      )}
      <div className={`advise ${sk}`}>
        {element.verdict === 'miss'
          ? '请补充案件原材料，或手动重新关联出处。'
          : element.verdict === 'fail'
            ? '请核对出处并修改声明后复检。'
            : element.verified
              ? '已记录律师确认。'
              : '请核对出处后确认或添加人工意见。'}
      </div>
      {element.note && !noteOpen && (
        <div className="advise g">
          <b>律师批注：</b>
          {element.note}
        </div>
      )}
      {noteOpen && (
        <div className="note-box">
          <Textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="写人工批注，将进入导出 Word 与审计日志…"
          />
          <div className="inline-actions">
            <Button
              className="op pri"
              disabled={app.busy}
              onClick={async () => {
                if (await app.saveNote(element, note)) setNoteOpen(false)
              }}
            >
              保存批注
            </Button>
            <Button className="op" onClick={() => setNoteOpen(false)}>
              取消
            </Button>
          </div>
        </div>
      )}
      {!editing && (
        <div className="ops">
          <Button
            className={`op pri ${element.verified ? 'ok' : ''}`}
            disabled={app.busy}
            onClick={() => void app.confirm(element)}
          >
            {element.verified ? '✓ 已确认' : '确认通过'}
          </Button>
          <Button
            className="op bye"
            disabled={app.busy}
            onClick={() => void app.reject(element)}
          >
            驳回
          </Button>
          <Button
            className="op"
            disabled={app.busy}
            onClick={() => setEditing(true)}
          >
            修改声明
          </Button>
          <Button className="op" onClick={() => app.setReferenceTarget(element)}>
            管理引用
          </Button>
          <Button
            className={`op ${noteOpen ? 'on' : ''}`}
            onClick={() => setNoteOpen(!noteOpen)}
          >
            批注
          </Button>
        </div>
      )}
      <div className="audit">
        <div className="audit-t">操作留痕</div>
        {app.audits
          .filter((item) => item.elementId === element.id)
          .map((item, index) => (
            <div className="audit-i" key={index}>
              <time>{new Date(item.t).toLocaleTimeString('zh-CN')}</time>
              <span>{item.msg}</span>
            </div>
          ))}
      </div>
    </div>
  )
}

export function Workspace() {
  const app = useApp()
  const [leftOpen, setLeftOpen] = useState(true)
  const [rightOpen, setRightOpen] = useState(true)
  const [rightTab, setRightTab] = useState('linkage')
  return (
    <div className="page active" id="pg-ws">
      <Topbar />
      <EssentialDialogs />
      <div className="case-review-bar"><Button className="btn btn-gh btn-sm" onClick={async () => { if (await app.prepareDocument()) app.setReviewListOpen(true) }} disabled={!app.certificate}>审阅清单</Button><span>人工审阅 {app.caseReview.total - app.caseReview.unreviewed}/{app.caseReview.total} 段 · 红灯 {app.caseReview.red} 项</span>
        <Button className="btn btn-gh btn-sm" disabled={app.busy || !app.caseReview.ready} onClick={async () => { if (await app.prepareDocument()) void app.markCaseReady() }}>标记案件完成</Button>
        {app.workspace?.cases.find(item => item.id === app.project?.id)?.status === 'ready' && app.caseReview.ready && <span>待归档</span>}
      </div>
      <div
        className={`ws ${leftOpen ? '' : 'no-l'} ${rightOpen ? '' : 'no-r'}`}
      >
        <Materials />
        <main className="pane-c">
          <div className="ctool">
            <span>{app.certificate?.title || '文书'}</span>
            <span className="mat-description">｜ 点击高亮看依据</span>
            <div className="legend">
              {[
                ['l1', '原材料'],
                ['l2', '法条'],
                ['l3', '案例'],
                ['fail', '红灯'],
              ].map(([key, label]) => (
                <span className="lg" key={key}>
                  <i className={`color-${key}`} />
                  {label}
                </span>
              ))}
            </div>
          </div>
          <DocumentPaper />
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                className="hd l"
                aria-label={leftOpen ? '收起材料栏' : '展开材料栏'}
                onClick={() => setLeftOpen(!leftOpen)}
              >
                {leftOpen ? '◀' : '▶'}
              </button>
            </TooltipTrigger>
            <TooltipContent>案件原材料</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                className="hd r"
                aria-label={rightOpen ? '收起依据栏' : '展开依据栏'}
                onClick={() => setRightOpen(!rightOpen)}
              >
                {rightOpen ? '▶' : '◀'}
              </button>
            </TooltipTrigger>
            <TooltipContent>联动依据</TooltipContent>
          </Tooltip>
        </main>
        <aside className="pane-r">
          <Tabs className="workbench-assistant-tabs" value={rightTab} onValueChange={value => { if (!app.busy) setRightTab(value) }}>
            <TabsList>
              <TabsTrigger value="linkage" disabled={app.busy}>联动依据</TabsTrigger>
              <TabsTrigger value="case" disabled={app.busy}>案件助手</TabsTrigger>
              <TabsTrigger value="document" disabled={app.busy}>起草与改写</TabsTrigger>
            </TabsList>
          </Tabs>
          {rightTab !== 'linkage' && <div className="rp">
            <Suspense fallback={<div className="assistant-panel-loading" role="status">正在加载助手…</div>}>
              {rightTab === 'case' && app.project && <CaseAssistant key={app.project.id} />}
              {rightTab === 'document' && app.project && <DocumentAssistant key={app.project.id} />}
            </Suspense>
          </div>}
          {rightTab === 'linkage' && (app.element ? (
            <div className="rp">
              <LinkageCard key={app.element.id} element={app.element} />
            </div>
          ) : (
            <div className="rp-empty">
              <FileText size={34} strokeWidth={1.2} />
              <p>
                点击文书中高亮文字，右侧展示这句话的联动出处、置信度与建议动作。
                <br />
                红灯项需先处理；多声明段落将整段核对后确认。
              </p>
            </div>
          ))}
        </aside>
      </div>
    </div>
  )
}
