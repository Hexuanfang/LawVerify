import { useState, type ReactNode } from 'react'
import { ChevronDown, CircleAlert, CircleCheck, CircleX, Clock, FileText, FileUp, Folder, FolderOpen, LoaderCircle, Search } from 'lucide-react'
import { EVIDENCE_PARSING_LABELS, type Evidence } from '../types'
import { useApp } from './AppContext'
import { Button } from './components/ui/button'
import { Input } from './components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from './components/ui/tooltip'
import { linkedAuthorities } from './reviewOverview'

const parsingStatusIcons = {
  queued: Clock,
  processing: LoaderCircle,
  ready: CircleCheck,
  review_required: CircleAlert,
  failed: CircleX,
}

type MaterialFolder = {
  id: string
  name: string
  linkedRoot: boolean
  count: number
  folders: Map<string, MaterialFolder>
  files: Evidence[]
}

function evidenceTree(materials: Evidence[], keyword: string) {
  const roots = new Map<string, MaterialFolder>()
  const folderIds: string[] = []

  for (const item of materials) {
    const path = item.relativePath?.split(/[\\/]+/).filter(Boolean).slice(0, -1) ?? []
    // 联动目录用后缀区分同名目录，界面只显示目录名。
    const suffix = '--' + item.directoryId
    if (item.directoryId && path[0]?.endsWith(suffix)) path[0] = path[0].slice(0, -suffix.length)
    const names = path.length ? path : ['案件原材料']
    const searchable = [item.number?.trim(), item.name, item.fileName, names.join('/')].join(' ').toLowerCase()
    if (!searchable.includes(keyword)) continue

    let folders = roots
    names.forEach((name, depth) => {
      const id = JSON.stringify(path.length ? [item.directoryId ?? '', ...names.slice(0, depth + 1)] : ['unfiled'])
      let folder = folders.get(id)
      if (!folder) {
        const linkedRoot = depth === 0 && path.length > 0 && Boolean(item.directoryId)
        folder = { id, name, linkedRoot, count: 0, folders: new Map(), files: [] }
        folders.set(id, folder)
        folderIds.push(id)
      }
      folder.count++
      folders = folder.folders
      if (depth === names.length - 1) folder.files.push(item)
    })
  }

  return { roots, folderIds }
}

export function WorkspaceMaterials() {
  const app = useApp()
  const [query, setQuery] = useState('')
  const [collapsedFolders, setCollapsedFolders] = useState<string[]>([])
  const [collapsedMatches, setCollapsedMatches] = useState<string[]>([])
  const keyword = query.trim().toLowerCase()
  const allMaterials = app.workspace?.evidences.filter(item => item.caseId === app.project?.id) ?? []
  const { roots, folderIds } = evidenceTree(allMaterials, keyword)
  const [collapsed, setCollapsed] = keyword ? [collapsedMatches, setCollapsedMatches] : [collapsedFolders, setCollapsedFolders]
  const authorities = linkedAuthorities(app.elements, app.workspace ?? undefined)
    .filter(item => [item.name, item.version, ...item.locations.map(({ source }) => source.loc)].join(' ').toLowerCase().includes(keyword))
  const law = authorities.filter(item => item.tier === 'l2')
  const cases = authorities.filter(item => item.tier === 'l3')
  const allGroups = [...folderIds, 'l2', 'l3']
  const folded = new Set(collapsed)
  const anyFolded = allGroups.some(id => folded.has(id))
  const toggle = (id: string) => setCollapsed(current => current.includes(id) ? current.filter(group => group !== id) : [...current, id])
  const heading = (id: string, title: string, count: number) => (
    <button type="button" className="mat-gn material-group-toggle" aria-expanded={!folded.has(id)} onClick={() => toggle(id)}>
      <ChevronDown size={13} aria-hidden="true" />{title}<span className="n">{count}</span>
    </button>
  )
  const fileRow = (item: Evidence) => {
    const number = item.number?.trim()
    const title = number ? number + ' · ' + item.name : item.name
    const status = item.parsing?.status
    const StatusIcon = status && parsingStatusIcons[status]
    const statusLabel = status === 'failed' ? '解析失败' : status && EVIDENCE_PARSING_LABELS[status]
    return (
      <li key={item.id}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" className="mat-it material-file"
              onClick={() => app.setDrawer({ st: 'l1', targetId: item.id, name: title, loc: item.fileName, quote: '' })}>
              <FileText size={14} aria-hidden="true" className="material-file-icon" />
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
          </TooltipContent>
        </Tooltip>
      </li>
    )
  }
  const folderRow = (folder: MaterialFolder): ReactNode => {
    const open = !folded.has(folder.id)
    const FolderIcon = open ? FolderOpen : Folder
    return (
      <li className="material-branch" key={folder.id}>
        <button type="button" className="mat-gn material-group-toggle material-folder" aria-expanded={open}
          title={folder.name} onClick={() => toggle(folder.id)}>
          <ChevronDown className="material-chevron" size={12} aria-hidden="true" />
          <FolderIcon className="material-folder-icon" size={15} aria-hidden="true" />
          <span className="material-folder-label">
            <span className="material-folder-name">{folder.name}</span>
            {folder.linkedRoot && <span className="mat-bd l1">L1</span>}
          </span>
          <span className="n">{folder.count}<span className="sr-only"> 份材料</span></span>
        </button>
        {open && <ul className="material-branch-children" role="list">
          {Array.from(folder.folders.values(), folderRow)}
          {folder.files.map(fileRow)}
        </ul>}
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
          <Input className="new-search-input" aria-label="按编号或名称搜索材料、目录和关联依据" placeholder="搜索材料、目录或依据…" value={query} onChange={event => {
            setQuery(event.target.value)
            setCollapsedMatches([])
          }} />
        </div>
      </div>
      <div className="mat-scroll">
        {roots.size > 0 ? <ul className="material-tree" role="list" aria-label="证据目录">
          {Array.from(roots.values(), folderRow)}
        </ul> : <p className="lib-empty">{keyword ? '未找到材料' : '暂无案件原材料'}</p>}
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
                    {mcp && <span className="material-origin">MCP</span>}
                  </button>
                ))}
              </div>
            )) : <p className="empty-inline">暂无关联</p>)}
          </div>
        ))}
      </div>
      <div className="material-actions">
        <Button variant="outline" className="add-mat" onClick={() => app.setUploadCase(app.project?.id ?? null)}>
          <FolderOpen size={15} />本地文件夹联动</Button>
        <Button variant="ghost" className="add-doc" onClick={() => app.setDocumentCase(app.project?.id ?? null)}>
          <FileUp size={15} />导入待核验文书</Button>
      </div>
    </aside>
  )
}
