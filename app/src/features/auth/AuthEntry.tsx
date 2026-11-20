import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import logo from './lawverify-icon.svg'
import walnut from './walnut.jpg'
import './auth-entry.css'

export interface DesktopRegisterForm {
  organizationName: string
  ownerName: string
  email: string
  password: string
  inviteCode?: string
}

interface Props {
  busy: boolean
  error: string
  onClearError: () => void
  onLogin: (email: string, password: string) => Promise<void>
  onRegister: (details: DesktopRegisterForm) => Promise<void>
  onWebsite: () => void
  onWebsiteRegister: () => void
  updateCard: ReactNode
}

function PasswordField({ registering }: { registering: boolean }) {
  const [visible, setVisible] = useState(false)
  return <div className="lv-field">
    <label htmlFor="lv-password">{registering ? '设置密码' : '密码'}</label>
    <div className="lv-secret">
      <input id="lv-password" name="password" required minLength={6}
        type={visible ? 'text' : 'password'} autoComplete={registering ? 'new-password' : 'current-password'}
        placeholder={registering ? '设置至少 6 位密码' : '输入账号密码'} />
      <button type="button" aria-label={visible ? '隐藏密码' : '显示密码'} onClick={() => setVisible(!visible)}>
        <svg aria-hidden="true" viewBox="0 0 24 24" width="18" fill="none" stroke="currentColor" strokeWidth="1.6">
          <path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6S2 12 2 12Z" />
          <circle cx="12" cy="12" r="2.5" />{!visible && <path d="m4 4 16 16" />}
        </svg>
      </button>
    </div>
  </div>
}

export default function AuthEntry(props: Props) {
  const [method, setMethod] = useState<'email' | 'phone'>('email')
  const [registering, setRegistering] = useState(false)
  const phoneLogin = !registering && method === 'phone'
  const firstField = useRef<HTMLInputElement>(null)
  useEffect(() => { firstField.current?.focus({ preventScroll: true }) }, [registering, method])

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (props.busy || phoneLogin) return
    const data = new FormData(event.currentTarget)
    const field = (name: string) => String(data.get(name) ?? '')
    const email = field('email')
    const password = field('password')
    if (registering) {
      void props.onRegister({ organizationName: field('organizationName'), ownerName: field('ownerName'),
        email, password, inviteCode: field('inviteCode') })
    } else {
      void props.onLogin(email, password)
    }
  }

  return <div className="lv-entry">
    <div className="lv-page">
      <header className="lv-mast">
        <div className="lv-brand"><img src={logo} alt="" />LawVerify</div>
        <button type="button" onClick={props.onWebsite}>产品官网 <span aria-hidden="true">↗</span></button>
      </header>
      <main className="lv-layout">
        <section className="lv-intro" aria-labelledby="lv-title">
          <p className="lv-overline"><i aria-hidden="true" />律师文书核验工作台</p>
          <h1 id="lv-title">每一句话，<br /><em>都经得起质证。</em></h1>
          <p className="lv-description">把文书中的事实逐句核对到证据原件，<br />查验引用的法条与案例，按代理立场起草文书。</p>
          <figure className="lv-figure">
            <img src={walnut} alt="围着蓝色对勾围巾的小核桃" />
            <figcaption><strong>小核桃</strong><span>语义核验助手</span></figcaption>
          </figure>
        </section>
        <section className="lv-card" data-lawverify-auth-entry aria-labelledby="lv-form-title">
          <h2 id="lv-form-title">{registering ? '创建账号' : '登录工作台'}</h2>
          <p className="lv-hint">{registering ? '使用邮箱注册 LawVerify 账号。' : '使用 LawVerify 账号，继续处理案件。'}</p>
          {!registering && <div className="lv-methods" role="group" aria-label="登录方式">
            {(['email', 'phone'] as const).map(value => <button key={value} type="button"
              aria-pressed={method === value} disabled={props.busy}
              onClick={() => { props.onClearError(); setMethod(value) }}>
              {value === 'email' ? '邮箱登录' : '手机号登录'}
            </button>)}
          </div>}
          <form onSubmit={submit} key={registering ? 'register' : method}>
            <fieldset disabled={props.busy}>
              {registering && <>
                <label>机构名称<input ref={firstField} name="organizationName" autoComplete="organization" required minLength={2} placeholder="输入律所或团队名称" /></label>
                <label>姓名或昵称<input name="ownerName" autoComplete="name" required minLength={2} placeholder="请输入姓名或昵称" /></label>
              </>}
              {phoneLogin
                ? <label>手机号<input ref={firstField} name="phone" type="tel" autoComplete="username"
                    inputMode="tel" placeholder="输入账号关联的手机号" /></label>
                : <label>邮箱<input ref={registering ? undefined : firstField} name="email" type="email"
                    autoComplete={registering ? 'email' : 'username'} required placeholder="输入注册邮箱" /></label>}
              <PasswordField registering={registering} />
              {registering && <label>邀请码（选填）<input name="inviteCode" maxLength={16} pattern="[A-Fa-f0-9]{16}" placeholder="输入 16 位邀请码" /></label>}
              {props.error && <p className="lv-error" role="alert">{props.error}</p>}
              {phoneLogin && <p className="lv-hint" role="status">云端账号服务尚未启用手机号登录，请使用邮箱登录。</p>}
              <button className="lv-submit" type="submit" disabled={phoneLogin}>{props.busy ? '正在提交…' : registering ? '注册并进入工作台' : '进入工作台'} <span aria-hidden="true">→</span></button>
            </fieldset>
          </form>
          <div className="lv-register">
            {registering ? '已有账号？' : '还没有账号？'}
            <button type="button" disabled={props.busy} onClick={() => { props.onClearError(); setRegistering(!registering) }}>
              {registering ? '返回登录' : '注册账号'}
            </button>
            <button type="button" onClick={props.onWebsiteRegister}>前往官网注册 ↗</button>
          </div>
        </section>
      </main>
      <footer className="lv-footer"><span>LawVerify <b>／</b> 律师工作台</span>
        {props.updateCard ? <details><summary>桌面端 v{__APP_VERSION__} · 版本更新</summary>{props.updateCard}</details> : <span>桌面端 v{__APP_VERSION__}</span>}
      </footer>
    </div>
  </div>
}
