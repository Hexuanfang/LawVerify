export {}

declare global {
  const __APP_VERSION__: string

  interface LawVerifyDesktopUpdateRequest {
    version: string
    downloadUrl: string
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
      channel: string
      openExternal?: (url: string) => Promise<void> | void
      startAppUpdate?: (payload: LawVerifyDesktopUpdateRequest) => Promise<{ ok: boolean }>
      onAppUpdateStatus?: (listener: (payload: LawVerifyDesktopUpdateStatus) => void) => () => void
    }
  }
}
