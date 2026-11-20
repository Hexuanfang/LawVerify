import React, { useEffect } from 'react';
import { useApp, selCase, selEls } from '../store/AppStore.jsx';

const PLAN = [
  { t: 350, p: 14 },
  { t: 850, p: 30, el: '定位文段' },
  { t: 1400, p: 52, l1: '溯源与一致性' },
  { t: 1950, p: 70, l2: '效力与要件' },
  { t: 2500, p: 86, l3: '真实性与相关性' },
  { t: 3000, p: 96 },
  { t: 3450, p: 100, done: true },
];

const STEPS = [
  ['读取文书定位', '版面 · 坐标'],
  ['抽取声明', 'pm-el'],
  ['匹配案件原材料 L1', 'pm-l1'],
  ['匹配法条效力 L2', 'pm-l2'],
  ['匹配类案 L3', 'pm-l3'],
  ['生成分档与批注', null],
];

export default function ProcessingPage() {
  const { state, dispatch } = useApp();
  const c = selCase(state);
  const { proc } = state;

  useEffect(() => {
    const timers = PLAN.map((s, i) =>
      setTimeout(() => {
        if (s.done) dispatch({ type: 'PROC_DONE' });
        else {
          const meta = {};
          if (s.el) meta.el = s.el;
          if (s.l1) meta.l1 = s.l1;
          if (s.l2) meta.l2 = s.l2;
          if (s.l3) meta.l3 = s.l3;
          dispatch({ type: 'PROC_TICK', step: i, pct: s.p, meta });
        }
      }, s.t)
    );
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="page active" id="pg-proc">
      <div className="proc">
        <div className="proc-box fade">
          <div className="proc-t">正在核验《{(c.docNames || {})[state.doc] || '文书'}》</div>
          <div className="proc-s">演示核验 · 检查 {selEls(state).length} 条声明与本地依据</div>
          {STEPS.map(([name, key], i) => (
            <div key={i} className={`pst ${proc.step === i ? 'on' : ''} ${proc.step > i || proc.done ? 'done' : ''}`}>
              <div className="pst-i">{i + 1}</div>
              <div style={{ fontWeight: 500 }}>{name}</div>
              <div style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--ink-3)' }}>
                {key ? (proc.metas[key] || (i === 0 ? '版面 · 坐标' : '—')) : '—'}
              </div>
            </div>
          ))}
          <div className="pbar"><i style={{ width: proc.pct + '%' }} /></div>
          <div className="ppct">{proc.pct}%</div>
        </div>
      </div>
    </div>
  );
}
