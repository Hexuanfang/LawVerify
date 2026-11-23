import { useState } from 'react'
import { FileText, FolderOpen, X } from 'lucide-react'
import { CaseFileCard } from './CaseFileCard'
import { Button } from './components/ui/button'

export function CaseMaterialCard({ links, onLinks, files, onFiles, disabled, pickerOpen, onPicking, onReading }: {
  links: CaseMaterialSelection[]
  onLinks: (update: (links: CaseMaterialSelection[]) => CaseMaterialSelection[]) => void
  files: File[]
  onFiles: (update: (files: File[]) => File[]) => void
  disabled: boolean
  pickerOpen: boolean
  onPicking: (open: boolean) => void
  onReading: (reading: boolean) => void
}) {
  const [feedback, setFeedback] = useState('')
  const desktop = window.lawVerifyDesktop
  const canLink = desktop?.pickCaseDirectory && desktop.stageDroppedCaseMaterials && desktop.attachCaseDirectory && desktop.readCaseDirectoryFile
  const stage = async (dropped?: File[]) => {
    if (disabled || !canLink || (!dropped && pickerOpen)) return
    const account = sessionStorage.getItem('lawverify-login-account') || ''
    const session = sessionStorage.getItem('lawverify-auth-session')
    const retainIds = links.map(item => item.id)
    const setPending = dropped ? onReading : onPicking
    setPending(true)
    setFeedback('')
    try {
      let selected: CaseMaterialSelection[]
      if (dropped) {
        const { links, skipped } = await desktop.stageDroppedCaseMaterials!(account, dropped, retainIds)
        selected = links
        if (!dropped.length) setFeedback('请从本机文件管理器拖入材料。')
        else if (skipped) setFeedback(`有 ${skipped} 项无法链接。请检查材料格式、大小和文件夹内容，最多可待链接 128 项。`)
      } else {
        const folder = await desktop.pickCaseDirectory!({ account, retainIds })
        selected = folder ? [folder] : []
      }
      if (account !== sessionStorage.getItem('lawverify-login-account') || session !== sessionStorage.getItem('lawverify-auth-session')) return
      onLinks(current => [...new Map([...current, ...selected].map(item => [item.id, item])).values()])
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : '无法读取本地材料，请重试。')
    } finally {
      setPending(false)
    }
  }

  return <CaseFileCard material files={files} onFiles={onFiles} disabled={disabled} pickerOpen={pickerOpen} onReading={onReading}
    localLinks={canLink ? { pick: () => void stage(), drop: files => void stage(files) } : undefined}>
    {feedback && <p className="case-file-feedback" role="status">{feedback}</p>}
    {links.length > 0 && <ul className="case-file-list" aria-label="待链接的案件原材料">
      {links.map(link => <li key={link.id} className="chip">
        {link.kind === 'file' ? <FileText size={17} aria-hidden="true" /> : <FolderOpen size={17} aria-hidden="true" />}
        <div><b>{link.name}</b><small>{link.kind === 'file' ? '待链接' : `${link.count} 份材料 · 待链接`}</small></div>
        <Button variant="ghost" size="icon" type="button" disabled={disabled || pickerOpen} aria-label={`移除 ${link.name}`}
          onClick={() => onLinks(current => current.filter(item => item.id !== link.id))}><X size={14} aria-hidden="true" /></Button>
      </li>)}
    </ul>}
  </CaseFileCard>
}
