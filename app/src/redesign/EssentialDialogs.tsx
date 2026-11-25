import { Button } from './components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './components/ui/dialog'
import { useApp } from './AppContext'

export function EssentialDialogs() {
  const app = useApp()
  const { confirmation } = app
  return <Dialog open={Boolean(confirmation)} onOpenChange={open => { if (!open && !app.busy) app.setConfirmation(null) }}>
      <DialogContent className="fm-box new-form"><DialogHeader><DialogTitle>确认本段全部声明</DialogTitle>
        <DialogDescription>现有审阅记录按段落保存。本次将同时确认下列全部声明，请逐项核对出处。</DialogDescription></DialogHeader>
        <ol className="essential-confirm-list">{app.elements.filter(item => item.paragraphId === confirmation?.target.paragraphId).map(item => <li key={item.id}>{item.quote}<small>{item.sources.map(source => source.name).join('；') || '缺少出处'}</small></li>)}</ol>
        <div className="fm-ft"><Button className="btn btn-gh" disabled={app.busy} onClick={() => app.setConfirmation(null)}>取消</Button>
          <Button className="btn btn-pri" disabled={app.busy} onClick={() => confirmation && void app.confirm(confirmation.target, true, undefined, confirmation.note)}>已核对，确认整段</Button></div>
      </DialogContent>
  </Dialog>
}
