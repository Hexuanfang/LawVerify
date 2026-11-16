import { Button } from './components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './components/ui/dialog'
import { useApp } from './AppContext'
import { ReferenceEditor } from './ReferenceEditor'

export function EssentialDialogs() {
  const app = useApp()
  return <>
    <Dialog open={app.reviewListOpen} onOpenChange={app.setReviewListOpen}>
      <DialogContent className="fm-box new-form essential-review-dialog"><DialogHeader><DialogTitle>文书审阅清单</DialogTitle>
        <DialogDescription>逐段核对全文，包括标题与未高亮内容；确认以整个段落为单位保存。</DialogDescription></DialogHeader>
        {app.certificate?.paragraphs.map((paragraph, index) => <div className="essential-reference-item" key={paragraph.id}>
          <b>第 {index + 1} 段 · {paragraph.verified ? '已确认' : '待审阅'}</b><p>{paragraph.text}</p>
          <Button className="btn btn-gh btn-sm" disabled={app.busy} onClick={() => void app.confirmParagraph(paragraph)}>{paragraph.verified ? '取消本段确认' : '已核对，确认本段'}</Button>
        </div>)}
      </DialogContent>
    </Dialog>
    {app.referenceTarget && <ReferenceEditor key={app.referenceTarget.id} />}
    <Dialog open={Boolean(app.confirmation)} onOpenChange={open => { if (!open && !app.busy) app.setConfirmation(null) }}>
      <DialogContent className="fm-box new-form"><DialogHeader><DialogTitle>确认本段全部声明</DialogTitle>
        <DialogDescription>现有审阅记录按段落保存。本次将同时确认下列全部声明，请逐项核对出处。</DialogDescription></DialogHeader>
        <ol className="essential-confirm-list">{app.elements.filter(item => item.paragraphId === app.confirmation?.paragraphId).map(item => <li key={item.id}>{item.quote}<small>{item.sources.map(source => source.name).join('；') || '缺少出处'}</small></li>)}</ol>
        <div className="fm-ft"><Button className="btn btn-gh" disabled={app.busy} onClick={() => app.setConfirmation(null)}>取消</Button>
          <Button className="btn btn-pri" disabled={app.busy} onClick={() => app.confirmation && void app.confirm(app.confirmation, true)}>已核对，确认整段</Button></div>
      </DialogContent>
    </Dialog>
  </>
}
