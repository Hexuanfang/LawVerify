import { StartupScreen } from '../StartupScreen'
import { whenUiIdle } from '../redesign-loader'
import { lazy, Suspense, useEffect } from 'react'
import { Button } from './components/ui/button'
import { TooltipProvider } from './components/ui/tooltip'
import { AppProvider, useApp } from './AppContext'
import { Home, Dock } from './Home'
import './shadcn.css'
import './fonts.css'
import './styles/global.css'
import './integration.css'

const DirectoryLinksModal = lazy(() => import('./DirectoryLinksModal').then(module => ({ default: module.DirectoryLinksModal })))
const loadWorkspace = () => import('./Workspace')
const Workspace = lazy(() => loadWorkspace().then(module => ({ default: module.Workspace })))
const Report = lazy(() => import('./Report').then(module => ({ default: module.Report })))
const Processing = lazy(() => import('./Report').then(module => ({ default: module.Processing })))
const Library = lazy(() => import('./Library').then(module => ({ default: module.Library })))
const UploadModal = lazy(() => import('./UploadModal').then(module => ({ default: module.UploadModal })))
const FormModal = lazy(() => import('./FormModal').then(module => ({ default: module.FormModal })))
const PreviewDrawer = lazy(() => import('./PreviewDrawer').then(module => ({ default: module.PreviewDrawer })))

function Shell() {
  const app = useApp()
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const editing = target?.closest(
        'input,textarea,select,[contenteditable="true"],[role="textbox"]',
      )
      if (
        editing ||
        app.uploadCase ||
        app.documentCase ||
        app.form ||
        app.drawer ||
        document.querySelector('[data-state="open"][role="dialog"]')
      )
        return
      if (app.page !== 'ws') return
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === 'e') {
        event.preventDefault()
        void app.prepareDocument().then(saved => { if (saved) { app.setAssistantRequest(null); app.setPage('report') } })
        return
      }
      if (
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        !app.element ||
        event.repeat
      )
        return
      const operation = { '1': 'confirm', '2': 'reject', '3': 'edit' }[
        event.key
      ]
      if (operation) {
        event.preventDefault()
        window.dispatchEvent(
          new CustomEvent('lv-operation', { detail: operation }),
        )
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [app])
  useEffect(() => {
    document.documentElement.removeAttribute('data-theme')
  }, [])
  const canPreloadWorkspace = app.page === 'home' && !app.loading && app.projects.length > 0
  useEffect(() => {
    if (canPreloadWorkspace) return whenUiIdle(() => { void loadWorkspace().catch(() => {}) })
  }, [canPreloadWorkspace])
  if (app.loading) return <StartupScreen />
  return (
    <div className="lawverify-redesign">
      <div className="chrome">
        <span className="title">LawVerify — 文书AI智能证据联动</span>
        <span className="ver">本地版 v{__APP_VERSION__}</span>
      </div>
      {app.workspace ? (
        <>
          <Suspense fallback={<div className="boot-status" role="status">正在加载页面…</div>}>
            {app.page === 'home' && <Home />}
            {app.page === 'ws' && <Workspace />}
            {app.page === 'report' && <Report />}
            {app.page === 'proc' && <Processing />}
            {app.page === 'lib' && <Library />}
          </Suspense>
          <Dock />
          <Suspense fallback={<div className="toast show" role="status">正在加载…</div>}>
            {app.uploadCase && <DirectoryLinksModal key={app.uploadCase} />}
            {app.documentCase && <UploadModal key={app.documentCase} />}
            {app.form && <FormModal key={`${app.form.tab}:${app.form.id ?? ''}`} />}
            {app.drawer && <PreviewDrawer />}
          </Suspense>
        </>
      ) : (
        <div className="boot-status">
          <p>工作区暂时无法读取</p>
          <Button className="btn btn-pri" onClick={() => location.reload()}>
            重试
          </Button>
        </div>
      )}
      {app.error && (
        <div className="new-error" role="alert">
          <span>{app.error}</span>
          <Button variant="ghost" onClick={() => app.setError('')}>
            关闭
          </Button>
        </div>
      )}
      {app.message && (
        <div className="toast show" role="status">
          {app.message}
        </div>
      )}
    </div>
  )
}

export default function RedesignApp() {
  return (
    <TooltipProvider>
      <AppProvider>
        <Shell />
      </AppProvider>
    </TooltipProvider>
  )
}
