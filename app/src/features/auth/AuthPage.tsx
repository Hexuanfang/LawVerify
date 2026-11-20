import { useEffect, useRef, useState } from 'react'
import { api } from '../../api'
import { handoffLoginWorkspace } from '../../auth-transition'
import { loadRedesign, preloadRedesign } from '../../redesign-loader'
import { SESSION_NOTICE } from '../../redesign/session'
import AuthEntry, { type DesktopRegisterForm } from './AuthEntry'
import { DesktopUpdateCard } from './DesktopUpdateCard'
import { ACCOUNT_CENTER_BASE_URL, isLocalOriginUrl, OFFICIAL_PLATFORM_BASE_URL, openExternalUrl } from './accountLinks'
import '../../index.css'

const AUTH = 'lawverify-auth-session'
const ACCOUNT = 'lawverify-login-account'
const CLOUD = 'lawverify-cloud-token'
const REGISTER_URL = ACCOUNT_CENTER_BASE_URL + '/register'

type CloudSession = Awaited<ReturnType<typeof api.loginCloudAccount>>

async function startWorkspaceSession(result: CloudSession) {
  const account = result.user.email.trim().toLowerCase()
  localStorage.setItem(CLOUD, result.token)
  try {
    const { token, workspace } = await api.createCloudWorkspaceSession({
      email: account,
      name: result.user.name,
      organization: result.organization.name,
      role: result.organization.role,
    })
    await loadRedesign()
    sessionStorage.setItem(ACCOUNT, account)
    sessionStorage.setItem(AUTH, token)
    void api.getAnalyticsPreference().then(() => api.recordAppOpen()).catch(() => {})
    handoffLoginWorkspace(account, token, workspace)
  } catch (error) {
    if (localStorage.getItem(CLOUD) === result.token) localStorage.removeItem(CLOUD)
    throw error
  }
}

export default function AuthPage() {
  const [busy, setBusy] = useState(false)
  const submitting = useRef(false)
  const [error, setError] = useState(() => sessionStorage.getItem(SESSION_NOTICE) || '')

  useEffect(() => {
    sessionStorage.removeItem(SESSION_NOTICE)
    localStorage.removeItem(AUTH)
    localStorage.removeItem('lawverify-auth-token')
  }, [])

  async function submit(task: () => Promise<void>) {
    if (submitting.current) return
    submitting.current = true
    setBusy(true)
    setError('')
    preloadRedesign()
    try {
      await task()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作失败，请重试。')
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }

  async function login(email: string, password: string) {
    const account = email.trim().toLowerCase()
    if (!account) {
      setError('请输入账号中心注册邮箱。')
      return
    }
    if (!/\S+@\S+\.\S+/.test(account)) {
      setError('请使用官网注册邮箱登录。')
      return
    }
    await submit(async () => {
      await startWorkspaceSession(await api.loginCloudAccount({ email: account, password }))
    })
  }

  async function register(form: DesktopRegisterForm) {
    const email = form.email.trim().toLowerCase()
    const organizationName = form.organizationName.trim()
    const ownerName = form.ownerName.trim()
    if (!organizationName) {
      setError('请输入机构名称。')
      return
    }
    if (ownerName.length < 2) {
      setError('请输入姓名或昵称（至少 2 个字符）。')
      return
    }
    if (!email) {
      setError('请输入注册邮箱。')
      return
    }

    await submit(async () => {
      let result: CloudSession
      try {
        result = await api.registerCloudAccount({
          organizationName, ownerName, email, password: form.password,
          inviteCode: form.inviteCode?.trim() || undefined,
        })
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : '平台注册失败。'
        if (!['当前无法连接平台账户服务', '未配置平台账户服务地址', '本地联调账户服务'].some(hint => message.includes(hint))) {
          throw cause
        }
        if (!ACCOUNT_CENTER_BASE_URL) {
          throw new Error('当前安装包尚未配置正式官网地址，需要补齐官网域名后重新打包。')
        }
        if (isLocalOriginUrl(ACCOUNT_CENTER_BASE_URL)) {
          throw new Error(message + ' 当前安装包仍使用本地联调官网地址 ' + ACCOUNT_CENTER_BASE_URL + '，需要改为正式官网地址后重新打包。')
        }
        await openExternalUrl(REGISTER_URL)
        setError('当前桌面端暂时无法直连注册服务，已为你打开官网注册页。注册完成后回到桌面端直接登录即可。')
        return
      }
      await startWorkspaceSession(result)
    })
  }

  return <AuthEntry busy={busy} error={error}
    onClearError={() => setError('')} onLogin={login} onRegister={register}
    onWebsite={() => void openExternalUrl(OFFICIAL_PLATFORM_BASE_URL)}
    onWebsiteRegister={() => void openExternalUrl(REGISTER_URL)}
    updateCard={window.lawVerifyDesktop?.channel === 'electron' ? <DesktopUpdateCard /> : null} />
}
