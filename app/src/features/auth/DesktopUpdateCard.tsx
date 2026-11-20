import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../../api'
import type { ReleaseItem } from '../../types'
import { openExternalUrl } from './accountLinks'

interface AppUpdateState {
  status: 'idle' | 'checking' | 'unavailable' | 'available' | 'up-to-date' | 'downloading' | 'installing' | 'ready' | 'error'
  latestRelease: ReleaseItem | null
  progress: number | null
  message: string
}

function parseVersionSegments(version: string) {
  const matches = String(version).match(/\d+/g)
  return matches ? matches.map((item) => Number(item)) : []
}

function compareAppVersions(currentVersion: string, nextVersion: string) {
  const left = parseVersionSegments(currentVersion)
  const right = parseVersionSegments(nextVersion)
  const length = Math.max(left.length, right.length)

  for (let index = 0; index < length; index += 1) {
    const leftValue = left[index] ?? 0
    const rightValue = right[index] ?? 0
    if (leftValue === rightValue) {
      continue
    }

    return leftValue > rightValue ? 1 : -1
  }

  return 0
}

export function DesktopUpdateCard() {
  const [appUpdateState, setAppUpdateState] = useState<AppUpdateState>({
    status: 'idle',
    latestRelease: null,
    progress: null,
    message: '',
  })
  const hasCheckedAppUpdateOnLaunchRef = useRef(false)
  const appUpdateBusyRef = useRef(false)
  const isDesktopClient = window.lawVerifyDesktop?.channel === 'electron'

  const checkForAppUpdate = useCallback(async (options: { silent?: boolean; channel?: 'stable' | 'test' } = {}) => {
    if (!isDesktopClient) {
      return
    }

    if (appUpdateBusyRef.current) {
      return
    }

    appUpdateBusyRef.current = true
    setAppUpdateState((current) => ({
      ...current,
      status: 'checking',
      progress: null,
      message: '正在检查桌面端新版本…',
    }))

    try {
      const channel = options.channel ?? window.lawVerifyDesktop?.updateChannel ?? 'stable'
      const latestRelease = await api.getLatestPublicRelease(channel)
      if (!latestRelease) {
        setAppUpdateState({
          status: 'unavailable', latestRelease: null, progress: null,
          message: channel === 'test'
            ? '暂未发布适用于此 Mac 的测试版。'
            : '暂未发布适用于此设备的正式版更新。',
        })
        return
      }
      if (latestRelease.platform !== window.lawVerifyDesktop?.platform
        || latestRelease.arch !== window.lawVerifyDesktop?.arch
        || latestRelease.channel !== channel) {
        throw new Error('更新版本与当前设备或更新通道不匹配，请前往官网下载。')
      }
      const hasNewerVersion = latestRelease && compareAppVersions(__APP_VERSION__, latestRelease.version) < 0

      setAppUpdateState({
        status: hasNewerVersion ? 'available' : 'up-to-date',
        latestRelease,
        progress: null,
        message: hasNewerVersion
          ? `发现${latestRelease.channel === 'test' ? '未签名测试版' : '新版本'} v${latestRelease.version}，可下载更新。`
          : options.silent ? '' : `当前已是最新版本 v${__APP_VERSION__}。`,
      })
    } catch (error) {
      const message = `检查更新失败，请确认网络和官网可访问后重试。${error instanceof Error ? error.message : ''}`
      setAppUpdateState((current) => ({
        ...current,
        status: 'error',
        progress: null,
        message,
      }))
    } finally {
      appUpdateBusyRef.current = false
    }
  }, [isDesktopClient])

  const handleStartAppUpdate = useCallback(async () => {
    const latestRelease = appUpdateState.latestRelease
    if (!latestRelease || appUpdateBusyRef.current) {
      return
    }

    if (window.lawVerifyDesktop?.startAppUpdate) {
      appUpdateBusyRef.current = true
      setAppUpdateState(current => ({ ...current, status: 'checking', message: '正在核实更新信息…' }))
      try {
        const result = await window.lawVerifyDesktop.startAppUpdate({
          version: latestRelease.version,
          downloadUrl: latestRelease.downloadUrl,
          sha256: latestRelease.sha256,
          channel: latestRelease.channel === 'test' ? 'test' : 'stable',
        })
        if (!result.ok) {
          setAppUpdateState(current => ({ ...current, status: 'available', message: '已取消更新，当前版本保持不变。' }))
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : '更新失败，请稍后重试。'
        setAppUpdateState((current) => ({
          ...current,
          status: 'error',
          progress: null,
          message,
        }))
      } finally {
        appUpdateBusyRef.current = false
      }
      return
    }

    await openExternalUrl(latestRelease.downloadUrl)
  }, [appUpdateState.latestRelease])

  useEffect(() => {
    if (!isDesktopClient || !window.lawVerifyDesktop?.onAppUpdateStatus) {
      return
    }

    return window.lawVerifyDesktop.onAppUpdateStatus((payload) => {
      setAppUpdateState((current) => ({
        ...current,
        status: payload.status === 'error' ? 'error' : payload.status,
        progress: typeof payload.progress === 'number' ? payload.progress : current.progress,
        message: payload.message ?? current.message,
      }))
    })
  }, [isDesktopClient])

  useEffect(() => {
    if (!isDesktopClient) {
      return
    }

    if (hasCheckedAppUpdateOnLaunchRef.current) {
      return
    }

    hasCheckedAppUpdateOnLaunchRef.current = true
    void (async () => {
      const result = await window.lawVerifyDesktop?.getAppUpdateResult?.().catch(() => null)
      if (result) {
        setAppUpdateState(current => ({ ...current, status: result.status, message: result.message }))
        return
      }
      await checkForAppUpdate({ silent: true })
    })()
  }, [checkForAppUpdate, isDesktopClient])

  const latestRelease = appUpdateState.latestRelease
  const updateBusy = ['checking', 'downloading', 'installing'].includes(appUpdateState.status)
  const hasAvailableUpdate = latestRelease && compareAppVersions(__APP_VERSION__, latestRelease.version) < 0
  const title = hasAvailableUpdate
    ? `发现新版本 v${latestRelease.version}`
    : `当前版本 v${__APP_VERSION__}`
  const detail = appUpdateState.message
    || (hasAvailableUpdate
      ? `最新安装包 ${latestRelease?.sizeLabel ?? ''}，可直接开始更新。`
      : '可手动检查更新，确保客户端保持最新。')

  return (
    <div data-status={appUpdateState.status} className={`app-update-card ${hasAvailableUpdate ? 'available' : ''}`}>
      <div className="app-update-copy">
        <span>桌面端更新</span>
        <strong>{title}</strong>
      </div>

      {appUpdateState.status === 'downloading' ? (
        <div className="app-update-progress" role="progressbar" aria-label="更新下载进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={appUpdateState.progress ?? undefined}>
          <div className="app-update-progress-bar" aria-hidden="true">
            <span style={{ width: `${appUpdateState.progress ?? 8}%` }} />
          </div>
          <strong>{appUpdateState.progress ? `${appUpdateState.progress}%` : '下载中'}</strong>
        </div>
      ) : null}

      <div className="app-update-actions">
        <button
          className="ghost-button"
          type="button"
          onClick={() => void checkForAppUpdate()}
          disabled={updateBusy}
        >
          {appUpdateState.status === 'checking' ? '检查中...' : '检查更新'}
        </button>
        {hasAvailableUpdate ? (
          <button
            className="primary-button"
            type="button"
            onClick={() => void handleStartAppUpdate()}
            disabled={updateBusy}
          >
            {appUpdateState.status === 'installing' ? '正在安装...' : appUpdateState.status === 'downloading' ? '正在更新...' : window.lawVerifyDesktop?.platform === 'darwin' ? '更新并重启' : '一键更新'}
          </button>
        ) : null}
      </div>
      <p className="app-update-detail" role="status" aria-live="polite">{detail}</p>
    </div>
  )
}
