import { useState } from 'react'
import { ChevronDown, CircleAlert, CircleCheck, CircleX, Clock, LoaderCircle, Plus, Search } from 'lucide-react'
import { EVIDENCE_PARSING_LABELS, type Evidence } from '../types'
import { useApp } from './AppContext'
import { Button } from './components/ui/button'
import { Input } from './components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from './components/ui/tooltip'
import { linkedAuthorities } from './reviewOverview'
import { evidenceCategory, evidenceCategoryKey, evidenceCategoryOrder, readEvidenceCategories, type EvidenceCategory } from './caseFileKind'

const parsingStatusIcons = {
  queued: Clock,
  processing: LoaderCircle,
  ready: CircleCheck,
  review_required: CircleAlert,
  failed: CircleX,
}

const evidenceDragType = 'application/x-lawverify-evidence'

function groupEvidence(materials: Evidence[], keyword: string, overrides: ReadonlyMap<string, EvidenceCategory>) {
  const groups = new Map(evidenceCategoryOrder.map(category => [category, [] as Evidence[]]))
  for (const item of materials) {
    const path = item.relativePath?.split(/[\\/]+/).filter(Boolean).slice(0, -1) ?? []
    const suffix = '--' + item.directoryId
    if (item.directoryId && path[0]?.endsWith(suffix)) path[0] = path[0].slice(0, -suffix.length)
    const category = overrides.get(item.id) ?? evidenceCategory([item.name, item.fileName].join(' '), path)
    const searchable = [item.number?.trim(), item.name, item.fileName, path.join('/'), category].join(' ').toLowerCase()
    if (searchable.includes(keyword)) groups.get(category)!.push(item)
  }
  return groups
}

export function WorkspaceMaterials() {
  const app = useApp()
  const caseId = app.project?.id ?? ''
  const account = sessionStorage.getItem('lawverify-login-account') ?? ''
  const storageKey = evidenceCategoryKey(account, caseId)
  const [query, setQuery] = useState('')
  const [collapsedCategories, setCollapsedCategories] = useState<string[]>([])
  const [collapsedMatches, setCollapsedMatches] = useState<string[]>([])
  const [overrides, setOverrides] = useState(() => readEvidenceCategories(storageKey))
  const [drag, setDrag] = useState<{ id: string; from: EvidenceCategory; over?: EvidenceCategory }>()
  const keyword = query.trim().toLowerCase()
  const allMaterials = app.workspace?.evidences.filter(item => item.caseId === caseId) ?? []
  const groups = [...groupEvidence(allMaterials, keyword, overrides)].filter(([, files]) => drag || files.length)
  const [collapsed, setCollapsed] = keyword ? [collapsedMatches, setCollapsedMatches] : [collapsedCategories, setCollapsedCategories]
  const authorities = linkedAuthorities(app.elements, app.workspace ?? undefined)
    .filter(item => [item.name, item.version, ...item.locations.map(({ source }) => source.loc)].join(' ').toLowerCase().includes(keyword))
  const law = authorities.filter(item => item.tier === 'l2')
  const cases = authorities.filter(item => item.tier === 'l3')
  const allGroups = [...groups.map(([category]) => category), 'l2', 'l3']
  const folded = new Set(collapsed)
  const anyFolded = allGroups.some(id => folded.has(id))
  const toggle = (id: string) => setCollapsed(current => current.includes(id) ? current.filter(group => group !== id) : [...current, id])
  const moveEvidence = (id: string, category: EvidenceCategory) => {
    const item = allMaterials.find(file => file.id === id)
    if (!item || !account || !caseId) return false
    const next = new Map(overrides).set(id, category)
    try {
      localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(next)))
    } catch {
      app.toast('证据分类暂时无法保存，请重试')
      return false
    }
    setOverrides(next)
    setCollapsedCategories(current => current.filter(group => group !== category))
    if (keyword && !groupEvidence([item], keyword, next).get(category)?.length) {
      setQuery('')
      setCollapsedMatches([])
    } else setCollapsedMatches(current => current.filter(group => group !== category))
    app.toast(`已移至「${category}」`)
    return true
  }
  const heading = (id: string, title: string, count: number) => (
    <button type="button" className="mat-gn material-group-toggle" aria-expanded={!folded.has(id)} onClick={() => toggle(id)}>
      <ChevronDown size={13} aria-hidden="true" />{title}<span className="n">{count}</span>
    </button>
  )
  const fileRow = (item: Evidence, category: EvidenceCategory) => {
    const number = item.number?.trim()
    const title = number ? number + ' · ' + item.name : item.name
    const status = item.parsing?.status
    const StatusIcon = status && parsingStatusIcons[status]
    const statusLabel = status === 'failed' ? '解析失败' : status && EVIDENCE_PARSING_LABELS[status]
    return (
      <li key={item.id}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" className="mat-it material-file" draggable data-evidence-id={item.id}
              data-dragging={drag?.id === item.id || undefined} aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
              onDragStart={event => {
                event.dataTransfer.setData(evidenceDragType, item.id)
                event.dataTransfer.effectAllowed = 'move'
                setDrag({ id: item.id, from: category })
              }}
              onDragEnd={() => setDrag(undefined)}
              onKeyDown={event => {
                if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return
                event.preventDefault()
                const offset = event.key === 'ArrowUp' ? -1 : 1
                const destination = evidenceCategoryOrder[evidenceCategoryOrder.indexOf(category) + offset]
                const list = event.currentTarget.closest('.material-categories')
                if (destination && moveEvidence(item.id, destination)) {
                  requestAnimationFrame(() => list?.querySelector<HTMLButtonElement>(`[data-evidence-id="${CSS.escape(item.id)}"]`)?.focus())
                }
              }}
              onClick={() => app.setDrawer({ st: 'l1', targetId: item.id, name: title, loc: item.fileName, quote: '' })}>
              <span className="fico l1" aria-hidden="true">材</span>
              <span className="mat-nm">{title}</span>
              {StatusIcon && <>
                <StatusIcon className="material-parsing-status" data-status={status} size={15} strokeWidth={2.25} aria-hidden="true" />
                <span className="sr-only">{statusLabel}</span>
              </>}
            </button>
          </TooltipTrigger>
          <TooltipContent className="max-w-64 wrap-anywhere" sideOffset={4}>
            <div>{title}</div>
            {item.fileName !== item.name && <div>{item.fileName}</div>}
            {statusLabel && <div>{statusLabel}</div>}
            <div>拖到分类标题可调整归类，也可按 Alt + ↑ / ↓</div>
          </TooltipContent>
        </Tooltip>
      </li>
    )
  }
  return (
    <aside className="pane-l" id="workspace-materials" aria-label="案件材料和关联依据">
      <div className="pane-head">
        <div className="pane-t"><h2>案件材料 <span>{allMaterials.length} 份</span></h2>
          <div className="material-fold-controls">
            <Button variant="ghost" size="xs" onClick={() => setCollapsed(anyFolded ? [] : allGroups)}>{anyFolded ? '展开全部' : '收起全部'}</Button>
          </div>
        </div>
        <div className="search">
          <Search size={13} aria-hidden="true" />
          <Input className="new-search-input" aria-label="搜索材料、法条和案例" placeholder="搜索材料 / 法条 / 案例" value={query} onChange={event => {
            setQuery(event.target.value)
            setCollapsedMatches([])
          }} />
        </div>
      </div>
      <div className="mat-scroll">
        <div className="material-categories" role="region" aria-label="证据目录">
          {groups.length ? groups.map(([category, files]) => (
            <div className="mat-g" key={category} data-category={category}
              data-drop-target={drag?.over === category || undefined}
              onDragOver={event => {
                if (!drag || drag.from === category) return
                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'
                if (drag.over !== category) setDrag({ ...drag, over: category })
              }}
              onDragLeave={event => {
                if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return
                setDrag(current => current?.over === category ? { ...current, over: undefined } : current)
              }}
              onDrop={event => {
                if (!drag) return
                event.preventDefault()
                setDrag(undefined)
                if (drag.from !== category && event.dataTransfer.getData(evidenceDragType) === drag.id)
                  moveEvidence(drag.id, category)
              }}>
              {heading(category, category, files.length)}
              {!folded.has(category) && <ul className="material-category-files" role="list" aria-label={category}>
                {files.map(item => fileRow(item, category))}
              </ul>}
            </div>
          )) : <p className="lib-empty">{keyword ? '未找到材料' : '暂无案件原材料'}</p>}
        </div>
        <h2 className="material-authority-title">关联依据</h2>
        {([
          ['l2', '法条 L2', law],
          ['l3', '案例 L3', cases],
        ] as const).map(([id, title, rows]) => (
          <div className="mat-g" key={id}>
            {heading(id, title, rows.length)}
            {!folded.has(id) && (rows.length ? rows.map(row => (
              <div className="material-authority" key={row.id}>
                <div className="material-authority-name">
                  <span className={`fico ${id}`} aria-hidden="true">{id === 'l2' ? '法' : '例'}</span>
                  <h3 className="mat-nm" title={row.name}>{row.name}{row.version && <span className="material-description">{row.version}</span>}</h3>
                </div>
                {row.locations.map(({ source, manual, mcp }) => (
                  <button type="button" className="mat-it" key={JSON.stringify([source.loc, source.quote])}
                    aria-label={`${row.name} · ${source.loc || '查看出处'}`} onClick={() => app.setDrawer(source)}>
                    <span className="material-description material-text">{source.loc || '查看出处'}</span>
                    {manual && <span className="material-origin">手动</span>}
                    {mcp && <span className="material-origin">检索</span>}
                  </button>
                ))}
              </div>
            )) : <p className="empty-inline">暂无关联</p>)}
          </div>
        ))}
      </div>
      <div className="material-actions">
        <Button variant="outline" className="add-mat" onClick={() => app.setDocumentCase(app.project?.id ?? null)}>
          <Plus size={15} aria-hidden="true" />导入材料或文书</Button>
      </div>
    </aside>
  )
}
