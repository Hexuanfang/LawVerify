export {}

declare global {
  const __APP_VERSION__: string

  interface LawVerifyDesktopUpdateRequest {
    version: string
    downloadUrl: string
    sha256: string
  }

  interface LawVerifyDesktopUpdateStatus {
    status: 'downloading' | 'ready' | 'error'
    version?: string
    progress?: number
    message?: string
  }

  interface Window {
    lawVerifyDesktop?: {
      platform: string
      arch?: string
      channel: string
      linkCaseDirectory?: (payload: { account: string; caseId: string; requestId?: string }) => Promise<CaseDirectoryManifest | null>
      onCaseDirectoryBatch?: (listener: (batch: CaseDirectoryBatch) => void) => () => void
      scanCaseDirectories?: (payload: { account: string; caseId: string }) => Promise<CaseDirectoryManifest[]>
      clearCaseDirectories?: (payload: { account: string; caseId: string }) => Promise<{ ok: boolean }>
      readCaseDirectoryFile?: (payload: { account: string; caseId: string; directoryId: string; relativePath: string; hash: string }) => Promise<Uint8Array<ArrayBuffer>>
      openExternal?: (url: string) => Promise<void> | void
      startAppUpdate?: (payload: LawVerifyDesktopUpdateRequest) => Promise<{ ok: boolean }>
      onAppUpdateStatus?: (listener: (payload: LawVerifyDesktopUpdateStatus) => void) => () => void
    }
  }

  interface CaseDirectoryManifest {
    id: string
    name: string
    files: Array<{ relativePath: string; fileName: string; size: number; hash: string }>
  }
  interface CaseDirectoryBatch extends CaseDirectoryManifest {
    requestId: string
    account: string
    caseId: string
    completed: number
    done: boolean
  }
}
