import { lazy, Suspense, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { LawLibraryRows } from './LawLibraryRows'
import type { LibraryRow } from './libraryRows'
import { Search } from 'lucide-react'
import { Button } from './components/ui/button'
import { Input } from './components/ui/input'
import { Tabs, TabsList, TabsTrigger } from './components/ui/tabs'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from './components/ui/dialog'
import { useApp, type LibTab } from './AppContext'
import { CaseDeleteDialog, type CaseDeleteTarget } from './CaseDeleteDialog'
import { BrandHome } from './Home'
import { counts } from './model'

const AccountServices = lazy(() => import('./AccountServices').then(module => ({ default: module.AccountServices })))

const TABS = {
  law: '法条库',
  case: '案例库',
  proj: '案件库',
  acct: '账号与团队',
}

export function Library() {
  const app = useApp()
  const [logoutOpen, setLogoutOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [pendingCaseDelete, setPendingCaseDelete] = useState<CaseDeleteTarget | null>(null)
  const [pendingDelete, setPendingDelete] = useState<{
    id: string
    title: string
  } | null>(null)
  const [displayName, setDisplayName] = useState(app.workspace?.user.name || '')
  const [memberName, setMemberName] = useState('')
  const [role, setRole] = useState('律师助理 · 可上传与标问题')
  const tab = app.libTab
  const workspace = app.workspace!
  const lower = query.toLowerCase()
  const library = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => { library.current?.scrollTo(0, 0) }, [tab, query])
  const entries = useMemo<LibraryRow[]>(() => {
    if (tab === 'case') return workspace.knowledgeCases
      .filter(item => `${item.caseNumber}${item.title}${item.holdingSummary}`.toLowerCase().includes(lower))
      .map(item => ({ key: `case:${item.id}`, id: item.id, title: item.caseNumber,
        description: `${item.title} — ${item.holdingSummary}`, meta: `${item.courtName} · 裁判 ${item.judgmentDate || '未提供'}`,
        badge: item.courtLevel || '普通案例', badgeStyle: 'teal' }))
    if (tab === 'proj') return app.projects
      .filter(item => `${item.name}${item.court}`.toLowerCase().includes(lower))
      .map(item => {
        const total = counts(Object.values(item.els).flat())
        return { key: `proj:${item.id}`, id: item.id, title: item.name, description: item.court,
          meta: `${item.mats.length} 份材料 · ${item.docs.length} 份文书 · 绿 ${total.pass} · 黄 ${total.warn} · 红 ${total.fail} · 更新 ${item.date}`, badge: '', badgeStyle: '' }
      })
    return []
  }, [tab, workspace.knowledgeCases, app.projects, lower])
  const sync = async () => {
    try {
      await app.refresh()
      app.toast('已刷新当前工作区资料库')
    } catch (cause) {
      app.setError(cause instanceof Error ? cause.message : '刷新失败')
    }
  }
  const renderRow = (item: LibraryRow) => {
    if (tab === 'acct') return null
    return (
      <div className="lrow" key={item.key}>
        <div className={`lrow-ic source-${tab}`}>
          {tab === 'law' ? '条' : tab === 'case' ? '例' : '案'}
        </div>
        <div className="lrow-b">
          <div className="lrow-t">
            <button
              onClick={() =>
                tab === 'proj'
                  ? app.enter(item.id)
                  : app.setDrawer({
                      st: tab === 'law' ? 'l2' : 'l3',
                      targetId: item.id,
                      name: item.title,
                      loc: '',
                      quote: '',
                    })
              }
            >
              {item.title}
            </button>
            {item.badge && (
              <span className={`stpill ${item.badgeStyle}`}>
                {item.badge}
              </span>
            )}
          </div>
          <div className="lrow-d">{item.description}</div>
          <div className="lrow-m">{item.meta}</div>
        </div>
        <div className="lrow-ops">
          {tab === 'proj' && (
            <Button
              className="op pri"
              onClick={() => app.enter(item.id)}
            >
              打开核验
            </Button>
          )}
          <Button
            className="op"
            onClick={() => app.setForm({ tab, id: item.id })}
          >
            编辑
          </Button>
          <Button
            className="op bye"
            onClick={event => {
              if (tab === 'proj') {
                const project = app.projects.find(project => project.id === item.id)
                if (project) setPendingCaseDelete({
                  id: project.id, name: project.name, docs: project.docs, trigger: event.currentTarget,
                })
              } else setPendingDelete(item)
            }}
          >
            删除
          </Button>
        </div>
      </div>
    )
  }
  return (
    <div className="page active" id="pg-lib">
      <div className="topbar">
        <BrandHome onHome={() => app.setPage('home')} />
        <Tabs
          value={tab}
          onValueChange={(value) => {
            app.setLibTab(value as LibTab)
            setQuery('')
            setPendingDelete(null)
          }}
        >
          <TabsList className="lib-tabs">
            {Object.entries(TABS).map(([value, title]) => (
              <TabsTrigger className="lib-tab" key={value} value={value}>
                {title}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        {tab !== 'acct' && (
          <Button
            className="btn btn-pri btn-sm ml-auto"
            onClick={() => app.setForm({ tab })}
          >
            ＋ 新增
          </Button>
        )}
      </div>
      <div className="lib" key={tab} ref={library}>
        <div className="lib-in fade">
          {tab !== 'acct' ? (
            <>
              <div className="lib-head">
                <div>
                  <h2>{TABS[tab]}</h2>
                  <div className="sub">
                    {tab === 'law'
                      ? '法条效力与条文版本 ｜ 核验时请复核适用时点'
                      : tab === 'case'
                        ? '案号四要素 ｜ 指导性案例应当参照，其余仅参考'
                        : '在办案件与已归档材料 ｜ 可新建、打开核验、删除'}
                  </div>
                </div>
                <div className="lib-tools">
                  <div className="lib-search">
                    <Search size={13} />
                    <Input
                      value={query}
                      placeholder="搜索…"
                      onChange={(event) => setQuery(event.target.value)}
                    />
                  </div>
                  <Button
                    className="btn btn-gh btn-sm"
                    onClick={() => void sync()}
                  >
                    ⟳ 同步资料库
                  </Button>
                </div>
              </div>
              <div className="rowlist">
                {tab === 'law' ? <LawLibraryRows statutes={workspace.knowledgeStatutes} query={lower} renderRow={renderRow} />
                  : entries.length ? entries.map(renderRow) : <div className="lib-empty">未找到，试试清空搜索或新增一条</div>}
              </div>
            </>
          ) : (
            <div className="acct-grid">
              <Suspense fallback={<p role="status">正在读取账号服务…</p>}><AccountServices /></Suspense>
              <div className="acct-card">
                <h3>执业人</h3>
                <Button className="btn btn-gh btn-sm" onClick={() => setLogoutOpen(true)}>退出登录</Button>
                <div className="account-profile">
                  <div className="avatar">
                    {workspace.user.name?.[0] || '律'}
                  </div>
                  <div>
                    <b>{workspace.user.name || '律师'}</b>
                    <div>{workspace.user.organization}</div>
                    <div className="mat-description">
                      {workspace.user.title}
                    </div>
                  </div>
                </div>
                <div className="fld" style={{ marginTop: 14 }}>
                  <label htmlFor="account-name">显示名</label>
                  <Input
                    id="account-name"
                    value={displayName}
                    onChange={(event) => setDisplayName(event.target.value)}
                  />
                </div>
                <Button
                  className="op pri"
                  onClick={() => app.toast('账号显示名更新接口待接入。')}
                >
                  保存显示名
                </Button>
              </div>
              <div className="acct-card">
                <h3>团队与权限</h3>
                <div className="mem">
                  <div className="av">{workspace.user.name?.[0] || '律'}</div>
                  <div>
                    <b>{workspace.user.name}</b>
                    <div className="mat-description">当前账号</div>
                  </div>
                  <span className="r">本人</span>
                </div>
                <div className="team-add">
                  <Input
                    placeholder="姓名"
                    value={memberName}
                    onChange={(event) => setMemberName(event.target.value)}
                  />
                  <Select value={role} onValueChange={setRole}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {[
                        '律师助理 · 可上传与标问题',
                        '质控 · 只读报告与抽查',
                      ].map((value) => (
                        <SelectItem key={value} value={value}>
                          {value}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    className="op pri"
                    onClick={() =>
                      app.toast(
                        memberName.trim()
                          ? '团队成员管理接口待接入。'
                          : '请填姓名',
                      )
                    }
                  >
                    添加
                  </Button>
                </div>
              </div>
              <div className="acct-card" style={{ gridColumn: '1/-1' }}>
                <h3>数据与隐私</h3>
                <p>
                  案件材料与文书使用当前账号的本机工作区。AI
                  核验及法条、案例检索按现有服务配置执行。
                  <br />
                  导出 Word 记录生成时间、软件版本与人工核验状态。
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
      <Dialog open={logoutOpen} onOpenChange={setLogoutOpen}>
        <DialogContent className="fm-box new-form"><DialogHeader><DialogTitle>退出当前账号？</DialogTitle>
          <DialogDescription>本机案件和已保存草稿会保留；退出后需重新登录。正在进行的核验会停止。</DialogDescription></DialogHeader>
          <div className="fm-ft"><Button className="btn btn-gh" onClick={() => setLogoutOpen(false)}>取消</Button>
            <Button className="btn btn-pri" disabled={app.busy} onClick={app.logout}>确认退出</Button></div>
        </DialogContent>
      </Dialog>
      <CaseDeleteDialog target={pendingCaseDelete} onClose={() => setPendingCaseDelete(null)} />
      <Dialog
        open={Boolean(pendingDelete)}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null)
        }}
      >
        <DialogContent className="fm-box new-form">
          <DialogHeader>
            <DialogTitle>
              删除{tab === 'law' ? '法条' : '案例'}？
            </DialogTitle>
            <DialogDescription>
              将删除「{pendingDelete?.title}」，请确认后继续。
            </DialogDescription>
          </DialogHeader>
          <div className="fm-ft">
            <Button
              className="btn btn-gh"
              onClick={() => setPendingDelete(null)}
            >
              取消
            </Button>
            <Button
              className="btn btn-pri"
              disabled={app.busy}
              onClick={() => app.toast('资料库删除接口待接入，当前记录仍保留。')}
            >
              确认删除
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
