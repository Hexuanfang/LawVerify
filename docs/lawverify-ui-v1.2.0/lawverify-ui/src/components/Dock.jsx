import React from 'react';
import { useApp } from '../store/AppStore.jsx';

export default function Dock() {
  const { state, dispatch } = useApp();
  if (state.page !== 'home') return null;
  return <div className="dock">
    <button className="dock-ava" onClick={() => dispatch({ type: 'NAV', page: 'account' })}>
      <span className="av">{state.accountName[0]}</span>
      <span><b>{state.accountName}</b><span>账号设置</span></span>
    </button>
  </div>;
}
