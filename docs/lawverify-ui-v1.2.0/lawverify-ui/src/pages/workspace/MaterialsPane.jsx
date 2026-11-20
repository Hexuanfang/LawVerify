import React, { useState } from 'react';
import { useApp, selEls, patchedDocEls } from '../../store/AppStore.jsx';

/* 打开预览抽屉：按材料类型映射变体 */
export function openSource(dispatch, source) {
  const { name, st, t } = source;
  const variant = source.url ? 'file' : st === 'l2' ? 'law' : st === 'l3' ? 'case'
    : name === '招商银行流水.png' ? 'bank'
    : name === '借条原件.jpg' ? 'jt' : name === '微信聊天截图.png' ? 'wc'
    : t === 'pdf' || name.endsWith('.pdf') ? 'pdf' : 'generic';
  dispatch({ type: 'OPEN_DRAWER', variant, name, source, sub: st.toUpperCase() + ' · ' + (source.loc || '材料预览') });
}

export function openMat(dispatch, material) {
  const st = material.t === 'law' ? 'l2' : material.t === 'case' ? 'l3' : 'l1';
  openSource(dispatch, { ...material, name: material.n, st });
}

/* 可折叠分组 */
function FoldGroup({ id, title, count, fold, onFold, children }) {
  const open = !fold[id];
  return (
    <div className={'mat-g' + (open ? '' : ' folded')}>
      <button type="button" className="mat-gn" onClick={() => onFold(id)} aria-expanded={open}>
        <span className="chev" aria-hidden="true">{open ? '▾' : '▸'}</span>
        <span className="mat-gt">{title}</span>
        {count !== undefined && <span className="n">{count}</span>}
      </button>
      {open && children}
    </div>
  );
}

export default function MaterialsPane() {
  const { state, dispatch } = useApp();
  const [q, setQ] = useState('');
  const [fold, setFold] = useState({});
  const [alignment, setAlignment] = useState(false);
  const c = state.projects.find((x) => x.id === state.caseId) || state.projects[0];
  const toggleFold = (id) => setFold((old) => ({ ...old, [id]: !old[id] }));

  const kind = (m) => (m.t === 'law' ? 'l2' : m.t === 'case' ? 'l3' : 'l1');
  const groups = {};
  const links = Object.values(c.els || {}).flat().flatMap((item) => item.sources);
  const evidenceDoc = c.docs.find((key) => key.startsWith('zj-')) || 'zj';
  const evidence = selEls({ ...state, doc: evidenceDoc }).filter((item) => !item.alignmentDiagnostic && ['E-EVID', 'E-PURP'].includes(item.type));
  const planned = c.mats.filter((m) => m.submit || (m.t !== 'law' && m.t !== 'case' && evidence.some((entry) => entry.sources.some((source) => source.name === m.n))));
  const normalize = (value) => value.toLowerCase().replace(/[,，\s]/g, '');

  /* L1 原材料（法条/案例不再混入，单独列在下方关联区） */
  const materials = c.mats.filter((m) => !['law', 'case'].includes(m.t));
  materials.forEach((m) => {
    if (q && !normalize([m.n, m.sub, m.text, ...links.filter((source) => source.name === m.n).map((source) => source.excerpt + ' ' + source.loc)].join(' ')).includes(normalize(q))) return;
    (groups[m.g] = groups[m.g] || []).push(m);
  });

  /* 统一折叠 / 展开 */
  const allIds = [...new Set([...Object.keys(groups).map((g) => 'g:' + g), 'l2', 'l3'])];
  const anyFolded = allIds.some((id) => fold[id]);
  const toggleAll = () => {
    setFold(anyFolded ? {} : Object.fromEntries(allIds.map((id) => [id, true])));
  };

  /* AI 关联 / 手动挂靠 / MCP 引用的 L2 法条与 L3 案例，聚合去重 */
  const linked = { l2: [], l3: [] };
  const seen = new Set();
  const pushLinked = (source, st) => {
    const name = source.name || source.n;
    if (!name || seen.has(name)) return;
    seen.add(name);
    linked[st].push({
      key: name + (source.loc || ''),
      name,
      loc: source.loc || source.sub || '',
      excerpt: source.excerpt || source.text || '',
      manual: source.manual,
      mcp: source.mcp,
      st,
      raw: { ...source, name, st },
    });
  };
  c.mats.filter((m) => m.t === 'law').forEach((m) => pushLinked(m, 'l2'));
  c.mats.filter((m) => m.t === 'case').forEach((m) => pushLinked(m, 'l3'));
  for (const doc of c.docs) {
    for (const item of patchedDocEls(state, doc)) {
      for (const source of item.sources || []) {
        if (source.st === 'l2') pushLinked(source, 'l2');
        else if (source.st === 'l3') pushLinked(source, 'l3');
      }
    }
  }
  const matchQ = (text) => !q || normalize(text).includes(normalize(q));
  linked.l2 = linked.l2.filter((item) => matchQ([item.name, item.loc, item.excerpt].join(' ')));
  linked.l3 = linked.l3.filter((item) => matchQ([item.name, item.loc, item.excerpt].join(' ')));
  const linkedCount = linked.l2.length + linked.l3.length;

  const renderItem = (item, onClick) => (
    <button key={item.key || item.id} className="mat-it material-button" onClick={onClick}>
      <span className={`fico ${item.st || kind(item)}`} aria-hidden="true">{item.st === 'l2' || item.t === 'law' ? '法' : item.st === 'l3' || item.t === 'case' ? '例' : '材'}</span>
      <span className="mat-nm" title={item.name || item.n}>{item.name || item.n}</span>
      {item.manual && <span className="link-flag">手动</span>}
      {item.mcp && <span className="link-flag mcp">检索</span>}
    </button>
  );

  return (
    <aside className="pane-l">
      <div className="pane-head">
        <div className="pane-t">
          <span>案件材料 <b>{materials.length}</b> 份</span>
          <button type="button" className="fold-all" onClick={toggleAll} title={anyFolded ? '展开全部分组' : '收起全部分组'}>
            {anyFolded ? '⊞ 展开全部' : '⊟ 收起全部'}
          </button>
        </div>
        <div className="search">
          <input aria-label="搜索材料与关联依据" placeholder="搜索材料 / 法条 / 案例" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      {alignment && <div className="alignment">
        <b>清单 → 卷内材料</b>
        {evidence.length ? evidence.map((entry) => <div key={entry.id}>{entry.id} · {entry.sources.some((source) => c.mats.some((m) => m.n === source.name)) ? '已对应' : '待补材料'}<small>{entry.quote}</small></div>) : <div>尚无证据清单</div>}
        <b>拟提交材料 → 清单</b>
        {planned.length ? planned.map((m) => <div key={m.id}>{m.n} · {evidence.some((entry) => entry.sources.some((source) => source.name === m.n)) ? '已列入' : '待补清单'}</div>) : <div>尚未标记拟提交材料</div>}
      </div>}
      <div className="mat-scroll">
        {Object.entries(groups).map(([g, items]) => (
          <FoldGroup key={g} id={'g:' + g} title={g} count={items.length} fold={fold} onFold={toggleFold}>
            {items.map((m) => renderItem({ ...m, st: kind(m) }, () => openMat(dispatch, m)))}
          </FoldGroup>
        ))}
        {!Object.keys(groups).length && <div className="mat-empty">未找到材料</div>}

        <div className="linked-head">关联依据 · AI / 手动</div>
        <FoldGroup id="l2" title="法条 L2" count={linked.l2.length} fold={fold} onFold={toggleFold}>
          {linked.l2.length
            ? linked.l2.map((item) => renderItem(item, () => openSource(dispatch, item.raw)))
            : <p className="linked-empty">核验或助手关联的法条会出现在这里</p>}
        </FoldGroup>
        <FoldGroup id="l3" title="案例 L3" count={linked.l3.length} fold={fold} onFold={toggleFold}>
          {linked.l3.length
            ? linked.l3.map((item) => renderItem(item, () => openSource(dispatch, item.raw)))
            : <p className="linked-empty">核验或助手关联的案例会出现在这里</p>}
        </FoldGroup>
        {!linkedCount && !q && <p className="linked-tip">在右侧核验卡或 AI 助手中关联出处后，法条与案例会自动归档到此。</p>}
      </div>
      <div className="sidebar-footer">
        <button className="add-mat" onClick={() => dispatch({ type: 'OPEN_UPLOAD', caseId: c.id })}>＋ 导入材料或文书</button>
        <button className="btn-txt alignment-trigger" onClick={() => setAlignment(!alignment)}>{alignment ? '收起证据清单对齐' : '证据清单对齐'}</button>
      </div>
    </aside>
  );
}
