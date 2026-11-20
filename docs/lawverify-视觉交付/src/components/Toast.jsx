import React, { useEffect, useState } from 'react';
import { useApp } from '../store/AppStore.jsx';

export default function Toast() {
  const { state } = useApp();
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (!state.toast.msg) return;
    setShow(true);
    const t = setTimeout(() => setShow(false), 2200);
    return () => clearTimeout(t);
  }, [state.toast.key, state.toast.msg]);

  return <div className={`toast ${show ? 'show' : ''}`}>{state.toast.msg}</div>;
}
