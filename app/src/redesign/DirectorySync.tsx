import { CaseDirectorySync } from '../CaseDirectorySync'
import { useApp } from './AppContext'

export function DirectorySync() {
  const app = useApp()
  const account = sessionStorage.getItem('lawverify-login-account') || ''
  return <>{app.workspace?.cases.map(folder => <CaseDirectorySync key={`${account}:${folder.id}`}
    account={account} caseId={folder.id}
    enabled={!app.busy && app.page !== 'proc' && folder.agent?.autoAnalyze !== false}
    onWorkspace={() => { void app.refresh().catch(cause => app.setError(cause instanceof Error ? cause.message : '目录同步后刷新失败')) }}
    onError={app.setError} />)}</>
}
