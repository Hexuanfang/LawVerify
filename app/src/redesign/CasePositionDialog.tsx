import { useRef, useState, type FormEvent } from 'react'
import { api } from '../api'
import type { CaseFolder, RoleType } from '../types'
import { caseRoleLabels } from '../../../server/src/intelligence/case-roles'
import { useApp } from './AppContext'
import { Button } from './components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './components/ui/dialog'
import { Input } from './components/ui/input'
import { Textarea } from './components/ui/textarea'

export function CasePositionDialog({ folder, onClose, restoreFocus }: {
  folder: CaseFolder
  onClose: () => void
  restoreFocus: () => void
}) {
  const app = useApp()
  const input = useRef<HTMLTextAreaElement>(null)
  const [initial] = useState(() => {
    const position = folder.agent?.position
    const side = folder.basicInfo?.ourSide
    const goals = position?.goals.join('\n') ?? ''
    const boundaries = position?.boundaries.join('\n') ?? ''
    return {
      position,
      party: position?.party ?? (side ? folder.basicInfo?.[side] : '') ?? '',
      role: position?.role ?? side ?? '',
      text: boundaries ? `${goals}\n\n写作约束：\n${boundaries}` : goals,
    } as const
  })
  const [party, setParty] = useState(initial.party)
  const [role, setRole] = useState<RoleType | ''>(initial.role)
  const [text, setText] = useState(initial.text)
  const [error, setError] = useState('')

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (app.busy || !party.trim() || !role) return
    const heading = /(?:^|\r?\n)写作约束[：:][ \t]*/u.exec(text)
    const goalText = heading ? text.slice(0, heading.index) : text
    const boundaryText = heading ? text.slice(heading.index + heading[0].length) : ''
    const lines = (value: string) => value.split(/\r?\n/u).map(line => line.trim()).filter(Boolean)
    const goals = text === initial.text && initial.position ? initial.position.goals : lines(goalText)
    const boundaries = text === initial.text && initial.position ? initial.position.boundaries : lines(boundaryText)
    if (!goals.length) { setError('请至少填写一项办案目标。'); return }
    if (goals.length > 12 || boundaries.length > 12 || [...goals, ...boundaries].some(line => line.length > 1000)) {
      setError('办案目标和写作约束各最多 12 项，每项最多 1000 字。'); return
    }
    setError('')
    const saved = await app.run(() => api.confirmCasePosition(folder.id, {
      party: party.trim(), role, goals, boundaries,
      admissions: initial.position?.admissions ?? [], disputes: initial.position?.disputes ?? [],
    }, initial.position?.version ?? 0), '代理立场已保存')
    if (saved) onClose()
  }

  return <Dialog open onOpenChange={open => { if (!open && !app.busy) onClose() }}>
    <DialogContent className="case-position-dialog" showCloseButton={false} aria-busy={app.busy}
      onOpenAutoFocus={event => { if (initial.party && initial.role) { event.preventDefault(); input.current?.focus() } }}
      onCloseAutoFocus={event => { event.preventDefault(); restoreFocus() }}
      onEscapeKeyDown={event => { if (app.busy) event.preventDefault() }}
      onInteractOutside={event => { if (app.busy) event.preventDefault() }}>
      <form onSubmit={save}>
        <DialogHeader className="case-position-header">
          <DialogTitle>代理立场</DialogTitle>
          <DialogDescription>AI 起草时可参考本案的代理立场。</DialogDescription>
        </DialogHeader>
        <div className="case-position-body">
          <div className="case-position-party">
            <label>代理当事人<Input value={party} maxLength={200} disabled={app.busy} required
              placeholder="姓名或单位" onChange={event => setParty(event.target.value)} /></label>
            <label>诉讼地位<select value={role} disabled={app.busy} required onChange={event => setRole(event.target.value as RoleType)}>
              <option value="" disabled>请选择</option>
              {Object.entries(caseRoleLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
            </select></label>
          </div>
          <label>办案目标与写作约束
            <Textarea ref={input} value={text} disabled={app.busy} required onChange={event => { setText(event.target.value); setError('') }}
              placeholder={'写明希望达成什么目标。\n如有写作约束，可另起一行写「写作约束：」后列出。'} />
          </label>
          {error && <p role="alert">{error}</p>}
        </div>
        <DialogFooter className="case-position-footer">
          <Button type="button" variant="outline" disabled={app.busy} onClick={onClose}>取消</Button>
          <Button type="submit" disabled={app.busy || !party.trim() || !role || !text.trim()}>{app.busy ? '正在保存…' : '保存代理立场'}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
}
