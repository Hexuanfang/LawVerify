import { DocumentEditor } from './DocumentEditor'
import { useApp } from './AppContext'

export function DocumentPaper({ editing }: { editing: '' | 'declarations' | 'document' }) {
  const app = useApp()
  return app.certificate ? <DocumentEditor key={app.certificate.id} editing={editing} /> : (
    <article className="doc-paper"><div className="empty-doc">
      <b>本案还没有文书</b>点击左侧「导入待核验文书」添加文书。
    </div></article>
  )
}
