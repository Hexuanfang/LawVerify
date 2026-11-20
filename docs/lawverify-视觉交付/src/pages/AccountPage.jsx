import React, { useState } from 'react';
import { useApp } from '../store/AppStore.jsx';

export default function AccountPage({ toast }) {
  const { state, dispatch } = useApp();
  const [name, setName] = useState(state.accountName);
  const [firm, setFirm] = useState(state.accountFirm || '');
  const [pwd, setPwd] = useState({ old: '', next: '', again: '' });
  const [pwdErr, setPwdErr] = useState('');

  const profileDirty = name.trim() !== state.accountName || firm.trim() !== (state.accountFirm || '');
  const saveProfile = (event) => {
    event.preventDefault();
    if (!name.trim()) return;
    dispatch({ type: 'SET_ACCOUNT_NAME', name: name.trim() });
    dispatch({ type: 'SET_ACCOUNT_FIRM', firm: firm.trim() });
    toast('账号资料已保存');
  };

  const changePwd = (event) => {
    event.preventDefault();
    setPwdErr('');
    if (!pwd.old) return setPwdErr('请输入当前密码');
    if (pwd.next.length < 8) return setPwdErr('新密码至少 8 位');
    if (pwd.next !== pwd.again) return setPwdErr('两次输入的新密码不一致');
    if (pwd.next === pwd.old) return setPwdErr('新密码不能与当前密码相同');
    setPwd({ old: '', next: '', again: '' });
    toast('密码已更新（演示环境，未接入真实认证）');
  };

  return <div className="page active">
    <header className="topbar">
      <button className="btn-txt" onClick={() => dispatch({ type: 'NAV', page: 'home' })}>← 返回首页</button>
      <b>账号设置</b>
    </header>

    <main className="acct-scroll">
      <div className="acct-page">
        <div className="acct-hero">
          <span className="avatar" aria-hidden="true">{state.accountName[0]}</span>
          <div className="acct-hero-main">
            <b>{state.accountName}</b>
            <small>{state.accountEmail}</small>
          </div>
          <div className="acct-credits">
            <small>可用积分</small>
            <b>{Number(state.accountCredits || 0).toLocaleString('zh-CN')}</b>
          </div>
        </div>

        <section className="acct-sec">
          <h2>基本资料</h2>
          <form className="acct-form" onSubmit={saveProfile}>
            <label className="acct-row">
              <span>显示名称</span>
              <input value={name} onChange={(event) => setName(event.target.value)} maxLength={24} />
            </label>
            <label className="acct-row">
              <span>律所 / 单位</span>
              <input value={firm} placeholder="如：北京某某律师事务所" onChange={(event) => setFirm(event.target.value)} maxLength={48} />
            </label>
            <div className="acct-ops">
              <button className="btn btn-pri btn-sm" disabled={!profileDirty || !name.trim()}>保存资料</button>
              {profileDirty && <small>有未保存的修改</small>}
            </div>
          </form>
        </section>

        <section className="acct-sec">
          <h2>登录邮箱</h2>
          <div className="acct-row readonly">
            <span>邮箱</span>
            <div className="readonly-row">
              <input value={state.accountEmail} readOnly aria-readonly="true" tabIndex={-1} />
              <em className="lock-tag">不可修改</em>
            </div>
          </div>
          <p className="acct-hint">邮箱为登录凭证，如需变更请联系管理员。</p>
        </section>

        <section className="acct-sec">
          <h2>修改密码</h2>
          <form className="acct-form" onSubmit={changePwd}>
            <label className="acct-row">
              <span>当前密码</span>
              <input type="password" value={pwd.old} autoComplete="current-password"
                onChange={(event) => setPwd({ ...pwd, old: event.target.value })} />
            </label>
            <label className="acct-row">
              <span>新密码</span>
              <input type="password" value={pwd.next} autoComplete="new-password" placeholder="至少 8 位"
                onChange={(event) => setPwd({ ...pwd, next: event.target.value })} />
            </label>
            <label className="acct-row">
              <span>确认新密码</span>
              <input type="password" value={pwd.again} autoComplete="new-password"
                onChange={(event) => setPwd({ ...pwd, again: event.target.value })} />
            </label>
            {pwdErr && <p className="acct-err" role="alert">{pwdErr}</p>}
            <div className="acct-ops">
              <button className="btn btn-pri btn-sm" disabled={!pwd.old || !pwd.next || !pwd.again}>修改密码</button>
            </div>
          </form>
        </section>
      </div>
    </main>
  </div>;
}
