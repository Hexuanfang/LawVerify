import WideEditor from '../components/WideEditor.jsx';
import SearchSelect from '../components/SearchSelect.jsx';
import React, { useState } from 'react';
import { selCase, selEls, useApp } from '../store/AppStore.jsx';
import { CASE_MEMORY, noteRecord } from '../data/memory.js';
import { blocksExport, statusLabel, ELEMENTS } from '../utils/review.js';
import { openMat, openSource } from './workspace/MaterialsPane.jsx';

const views = [
  ['brief', '办案速览'],
  ['focus', '立场与焦点'],
  ['timeline', '事实时间线'],
  ['evidence', '证据地图'],
  ['money', '金额台账'],
  ['risk', '风险与待办'],
];

export default function CaseMemoryPage() {
  const { state, dispatch } = useApp();
  const c = selCase(state);
  const seed = CASE_MEMORY[c.id];
  const items = c.docs.flatMap((doc) => selEls({ ...state, doc }).map((item) => ({ ...item, doc })));
  const support = items.filter((item) => item.sources.some((source) => source.st === 'l1') &&
    ['E-FACT', 'E-CALC', 'E-SUBJ', 'E-EVID'].includes(item.type));
  const required = items.filter(blocksExport);
  const warnings = items.filter((item) => item.verdict === 'warn' && !item.ignored);
  const issues = [...required, ...warnings];
  const calcItems = items.filter((item) => item.type === 'E-CALC' || /元|％|%|利率|基数/.test(item.quote));
  const missing = items.filter((item) => item.verdict === 'miss' || item.issue === '缺源');
  const record = noteRecord(state.memoryNotes, c.id);
  const [view, setView] = useState('brief');
  const [editor, setEditor] = useState(null);
  const at = () => new Date().toLocaleString('zh-CN', { hour12: false });
  const save = (next) => dispatch({ type: 'SAVE_MEMORY', caseId: c.id, record: { ...next, updatedAt: at() } });
  const saveNote = (text) => {
    const value = text.trim();
    if (!value) return;
    const entry = { id: editor.entry?.id || String(Date.now()), text: value, at: at() };
    const notes = editor.entry ? record.notes.map((n) => n.id === entry.id ? entry : n) : [...record.notes, entry];
    save({ ...record, notes });
    setEditor(null);
  };
  const notes = [...record.notes].reverse();
  const noteRow = (entry) => <div className="memory-note" key={entry.id}>
    <p>{entry.text}</p>
    <div className="memory-note-actions">
      <small>{entry.at}</small>
      <button className="btn-txt" onClick={() => setEditor({ kind: 'note', entry })}>编辑笔记</button>
      <button className="btn-txt" onClick={() => save({ ...record, notes: record.notes.filter((n) => n.id !== entry.id) })}>删除笔记</button>
    </div>
  </div>;
  const previewDocument = (item) => dispatch({
    type: 'OPEN_DRAWER', variant: 'document', name: c.docNames[item.doc] || '文书',
    sub: '文书预览 · ' + statusLabel(item), doc: item.doc, itemId: item.id,
  });
  const askAi = (tool, text) => dispatch({ type: 'ASSISTANT', open: true, tool, selection: text ? { text, position: '案件记忆', canReplace: false } : null });
  const docProgress = c.docs.map((doc) => {
    const list = selEls({ ...state, doc });
    const todo = list.filter(blocksExport).length;
    return { doc, name: c.docNames[doc] || doc, all: list.length, todo, warn: list.filter((item) => item.verdict === 'warn').length };
  });

  return <div className="page active" id="pg-memory">
    <div className="topbar">
      <button className="btn-txt" onClick={() => dispatch({ type: 'NAV', page: 'ws' })}>← 返回工作台</button>
      <b>案件记忆</b>
      <SearchSelect label="查看案件记忆" value={c.id} options={state.projects.map((project) => ({ value: project.id, label: project.name, keywords: project.court }))}
        onChange={(id) => {
          dispatch({ type: 'ENTER_CASE', id });
          dispatch({ type: 'NAV', page: 'memory' });
        }} />
      <button className="btn-txt" onClick={() => askAi('draft')}>✦ 让 AI 起草</button>
    </div>
    <main className="memory-scroll">
      <div className="memory-content">
        <header className="memory-heading">
          <div><h1>{c.name}</h1><p>{[c.court, c.no, c.cause].filter(Boolean).join(' ｜ ')}</p></div>
          <button className="btn btn-gh btn-sm" onClick={() => dispatch({ type: 'OPEN_FORM', edit: true })}>编辑案件信息</button>
        </header>
        <nav className="memory-views" aria-label="案件记忆分区">
          {views.map(([id, label]) => <button key={id} aria-current={view === id ? 'page' : undefined} onClick={() => setView(id)}>
            {label}{id === 'risk' && issues.length > 0 && <span className="memory-risk-count">{issues.length}</span>}
          </button>)}
        </nav>
        <div className="memory-grid">
          {view === 'brief' && <>
            <section className="memory-card memory-wide memory-summary">
              <h2>本案一句话{seed && <small>示例材料梳理</small>}</h2>
              <p>{seed?.summary || c.parties || '暂无案情摘要。可先在工作台导入材料并建立证据关联。'}</p>
              <div className="memory-stats">
                <span><b>{c.mats.filter((m) => !['law', 'case'].includes(m.t)).length}</b> 份卷内材料</span>
                <span><b>{c.docs.length}</b> 份文书</span>
                <button className="memory-link" onClick={() => setView('evidence')}><b>{support.length}</b> 条声明有卷内出处 →</button>
                <button className="memory-link" onClick={() => setView('risk')}><b>{required.length}</b> 项需处理 · <b>{warnings.length}</b> 项预警 →</button>
              </div>
            </section>
            <section className="memory-card memory-task">
              <div className="memory-card-heading"><h2>代理立场</h2>
                <button className="btn btn-gh btn-sm" onClick={() => setEditor({ kind: 'stance' })}>{record.stance ? '编辑立场' : '填写立场'}</button>
              </div>
              <p className="review-meta">代理对象、办案目标和写作约束，AI 起草时自动参考。</p>
              {record.stance ? <p className="memory-stance">{record.stance}</p>
                : <button className="btn-txt" onClick={() => setEditor({ kind: 'stance' })}>＋ 填写立场，起草更贴案</button>}
              <div className="memory-ops">
                <button className="op" onClick={() => askAi('draft')}>✍️ 按立场起草</button>
                <button className="op" onClick={() => askAi('auto', seed?.summary)}>✦ 追问本案</button>
              </div>
            </section>
            <section className="memory-card memory-task">
              <div className="memory-card-heading"><h2>律师笔记</h2>
                <button className="btn btn-gh btn-sm" onClick={() => setEditor({ kind: 'note' })}>新增笔记</button>
              </div>
              <p className="review-meta">待办、补证线索或写作要求。</p>
              {notes.length ? notes.slice(0, 1).map(noteRow) : <p className="review-meta">暂无笔记。</p>}
              {notes.length > 1 && <details className="memory-note-list">
                <summary>查看更早笔记（{notes.length - 1}）</summary>
                {notes.slice(1).map(noteRow)}
              </details>}
            </section>
            <section className="memory-card">
              <h2>文书进度</h2>
              <ul className="memory-doc-progress">
                {docProgress.map((row) => <li key={row.doc}>
                  <button className="memory-link" onClick={() => { dispatch({ type: 'SET_DOC', doc: row.doc }); dispatch({ type: 'NAV', page: 'ws' }); }}>
                    {row.name}
                  </button>
                  <small>{row.todo ? row.todo + ' 待办' : '可导出'} · {row.all} 条 · {row.warn} 预警</small>
                </li>)}
              </ul>
            </section>
            {seed?.keyPersons?.length ? <section className="memory-card">
              <h2>关键人物</h2>
              <ul>{seed.keyPersons.map((line) => <li key={line}>{line}</li>)}</ul>
            </section> : null}
          </>}

          {view === 'focus' && <>
            {seed?.disputeFocuses?.length ? <section className="memory-card memory-wide">
              <h2>争议焦点</h2>
              <ul>{seed.disputeFocuses.map((line) => <li key={line}>
                {line}
                <button className="btn-txt" onClick={() => askAi('auto', line)}>✦ 问 AI</button>
              </li>)}</ul>
            </section> : <section className="memory-card memory-wide"><h2>争议焦点</h2>
              <p className="review-meta">暂无已归纳争点。可让 AI 从双方诉辩归纳。</p>
              <button className="op" onClick={() => askAi('auto', '归纳本案争议焦点')}>✦ 归纳争议焦点</button>
            </section>}
            {seed?.claimsAndDefenses?.length ? <section className="memory-card memory-wide">
              <h2>主张与抗辩</h2>
              <ul>{seed.claimsAndDefenses.map((line) => <li key={line}>{line}</li>)}</ul>
            </section> : null}
            {record.stance ? <section className="memory-card memory-wide">
              <h2>我方立场</h2>
              <p>{record.stance}</p>
            </section> : null}
          </>}

          {view === 'timeline' && <section className="memory-card memory-wide">
            <h2>事实时间线{seed && <small>示例材料记载</small>}</h2>
            {seed?.timeline ? <ol className="memory-timeline">{seed.timeline.map((entry) => {
              const material = c.mats.find((m) => m.id === entry.material);
              const item = items.find((candidate) => candidate.doc === entry.doc && candidate.id === entry.id);
              const source = material && item?.sources.find((candidate) => candidate.st === 'l1' && candidate.name === material.n);
              return <li key={entry.date}>
                <time>{entry.date}</time><span>{entry.text}</span>
                {material && <button className="op" onClick={() => source ? openSource(dispatch, { ...material, ...source }) : openMat(dispatch, material)}>{material.n}</button>}
                {item && <button className="op" onClick={() => previewDocument(item)}>预览文书</button>}
              </li>;
            })}</ol> : <p className="review-meta">暂无已整理的时间线</p>}
            <div className="memory-ops">
              <button className="op" onClick={() => askAi('auto', '梳理本案时间线')}>✦ 让 AI 重梳时间线</button>
            </div>
          </section>}

          {view === 'evidence' && <section className="memory-card memory-wide">
            <h2>证据支持矩阵<small>随文书核验状态更新</small></h2>
            {support.length ? <table className="memory-matrix">
              <thead><tr><th>文书声明</th><th>卷内出处</th><th>核验状态</th></tr></thead>
              <tbody>{support.map((item) => <tr key={item.id}>
                <td><button className="memory-link" onClick={() => previewDocument(item)}>{item.quote}</button><small>{c.docNames[item.doc]} · {ELEMENTS[item.type]?.[0]}</small></td>
                <td className="memory-source-links">{item.sources.filter((source) => source.st === 'l1').map((source) => <button className="memory-link" key={source.name + source.loc} onClick={() => openSource(dispatch, source)}>{source.name} · {source.loc}</button>)}</td>
                <td>{statusLabel(item)}</td>
              </tr>)}</tbody>
            </table> : <p className="review-meta">当前没有带卷内出处的声明</p>}
            {missing.length > 0 && <div className="memory-evidence-gap">
              <h3>缺源声明（不得编造出处）</h3>
              {missing.map((item) => <div key={item.id}>
                <button className="memory-link" onClick={() => previewDocument(item)}>{c.docNames[item.doc]} · {item.quote}</button>
                <small>{item.advice || item.reason}</small>
              </div>)}
            </div>}
          </section>}

          {view === 'money' && <section className="memory-card memory-wide">
            <h2>金额台账<small>基数 · 利率 · 期间 · 结果可复算</small></h2>
            {seed?.keyAmounts?.length ? <table className="memory-matrix">
              <thead><tr><th>关键金额</th><th>说明</th></tr></thead>
              <tbody>{seed.keyAmounts.map((line) => {
                const [amount, ...rest] = line.split(' · ');
                return <tr key={line}><td>{amount}</td><td>{rest.join(' · ')}</td></tr>;
              })}</tbody>
            </table> : <p className="review-meta">暂无结构化金额。</p>}
            {calcItems.length > 0 && <>
              <h3>文书中的计算声明</h3>
              {calcItems.map((item) => <div key={item.id} className="memory-calc">
                <button className="memory-link" onClick={() => previewDocument(item)}>{item.quote}</button>
                <small>{c.docNames[item.doc]} · {statusLabel(item)} · {item.reason}</small>
                <button className="op" onClick={() => askAi('auto', '复算：' + item.quote)}>🧮 让 AI 复算</button>
              </div>)}
            </>}
          </section>}

          {view === 'risk' && <section className="memory-card memory-wide">
            <h2>矛盾、风险与待补强</h2>
            {issues.length ? <ul className="memory-issues">{issues.map((item) => <li key={item.id}>
              <button className="memory-link" onClick={() => previewDocument(item)}>{c.docNames[item.doc]} · {statusLabel(item)}</button>
              <p>{item.impact?.reason || item.reason}</p>
              {item.advice && <small>{item.advice}</small>}
              <div className="memory-ops">
                <button className="op" onClick={() => previewDocument(item)}>预览文书</button>
                <button className="op" onClick={() => askAi('auto', item.quote)}>✦ 问 AI 怎么补</button>
              </div>
            </li>)}</ul> : <p className="review-meta">暂无待处理或预警声明</p>}
            <div className="memory-ops">
              <button className="op" onClick={() => askAi('auto', '本案还有哪些证据短板')}>🛡️ 盘点证据短板</button>
              <button className="op" onClick={() => dispatch({ type: 'NAV', page: 'report' })}>查看核验报告 →</button>
            </div>
          </section>}
        </div>
        {view === 'brief' && <p className="memory-storage" role="status">
          {state.memorySaved === false ? '浏览器本地存储不可用，立场和笔记保留在本次会话。' : '立场和笔记保存在当前浏览器。'} {record.updatedAt && '最近保存 ' + record.updatedAt}
        </p>}
      </div>
    </main>
    {editor?.kind === 'stance' && <WideEditor title="代理立场" label="代理对象、办案目标与写作约束"
      hint="AI 起草时可参考本案的代理立场。" initial={record.stance} canClear
      placeholder="写明代理哪一方、希望达成什么目标，以及写作时要遵守的约束。"
      saveLabel="保存代理立场" onClose={() => setEditor(null)}
      onSave={(value) => { save({ ...record, stance: value.trim() }); setEditor(null); }} />}
    {editor?.kind === 'note' && <WideEditor title={editor.entry ? '编辑律师笔记' : '新增律师笔记'} label="笔记内容"
      initial={editor.entry?.text} placeholder="例如，向客户补取签收回单，核对签收人。"
      saveLabel="保存笔记" onClose={() => setEditor(null)} onSave={saveNote} />}
  </div>;
}
