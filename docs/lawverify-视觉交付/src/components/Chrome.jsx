import React from 'react';
import LawLogo from './LawLogo.jsx';

// 桌面窗体标题栏
export default function Chrome() {
  return (
    <div className="chrome">
      <span className="dot" style={{ background: '#FF5F57' }} />
      <span className="dot" style={{ background: '#FEBC2E' }} />
      <span className="dot" style={{ background: '#28C840' }} />
      <span className="title">LawVerify — 文书AI智能证据联动</span>
      <span className="ver">交互原型 v1.1</span>
    </div>
  );
}

export { LawLogo };
