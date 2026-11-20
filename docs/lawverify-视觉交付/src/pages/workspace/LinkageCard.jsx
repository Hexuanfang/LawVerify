import WideEditor from '../../components/WideEditor.jsx';
import SearchSelect from '../../components/SearchSelect.jsx';
import React, { useState } from 'react';
import { useApp, selCase } from '../../store/AppStore.jsx';
import { blocksExport, checksFor, ELEMENTS, evaluateEdit, isMissing, statusLabel } from '../../utils/review.js';
import { openSource } from './MaterialsPane.jsx';
import { exportCaseReport } from '../../utils/caseReport.js';

export default function LinkageCard({ el, toast, dispatch }) {
  const { state } = useApp();
  const [mode, setMode] = useState('');
  const [draft, setDraft] = useState('');
  const [location, setLocation] = useState('');
  const [material, setMaterial] = useState('');
  const [excerpt, setExcerpt] = useState('');
  const [checked, setChecked] = useState({});
  const c = selCase(state);
  const standards = checksFor(el);
  const canManualReview = el.verdict === 'pending'
    && el.sources.some((source) => source.excerpt?.trim() && source.loc?.trim() && source.loc !== '材料目录');
  const act = (action, auditMsg, extra = {}) => dispatch({ type: 'OP', id: el.id, action, auditMsg, ...extra });
  const open = (name, value = '') => { setMode(name); setDraft(value || ''); setChecked({}); };
  const saveEdit = (text) => {
    if (!text.trim()) return toast('声明不能为空');
    const result = evaluateEdit(el, text.trim());
    act('edit', '修改声明 · ' + statusLabel(result), { quote: text.trim(), patch: result });
    setMode('');
  };
  const relink = () => {
    const selected = c.mats.find((m) => m.id === material);
    if (!selected || !location.trim() || !excerpt.trim()) return toast('请填写材料、原文定位和摘录');
    const st = selected.t === 'law' ? 'l2' : selected.t === 'case' ? 'l3' : 'l1';
    const source = { ...selected, st, name: selected.n, loc: location.trim(), excerpt: excerpt.trim(), manual: true, match: [] };
    act('relink', '手动挂靠 ' + selected.n + ' · ' + source.loc, {
      patch: { src: st, sources: [source], verdict: 'pending', issue: null, conf: null, diff: null, checks: {}, reason: '律师已挂靠原文，等待重新核对。' },
    });
    setMode('');
  };
  const [primarySource, ...moreSources] = el.sources;
  const complete = !blocksExport(el);
  const editingText = mode === 'edit' || mode === 'note';
  const primary = canManualReview ? ['人工核验', () => open('manual')]
    : el.verifiedText && !complete ? ['采纳修改建议', () => open('edit', el.verifiedText)]
    : isMissing(el) ? ['关联出处', () => open('relink')]
    : !complete ? ['修改声明', () => open('edit', el.quote)]
    : el.verdict === 'warn' ? ['修改声明', () => open('edit', el.quote)]
    : !el.confirmed ? ['确认通过', () => act('confirm', '确认通过')] : null;
  const renderSource = (source) => <button className="mvp-source" key={source.name + source.loc} onClick={() => openSource(dispatch, source)}>
    <span><b>{source.name}</b><small>{source.loc}{source.manual ? ' · 人工关联' : ['l2', 'l3'].includes(source.st) ? ' · 示例引用' : ''}</small></span><span aria-hidden="true">↗</span>
  </button>;
  return (
    <div className="rc mvp-result">
      <div className="result-status" data-tone={blocksExport(el) ? 'attention' : el.verdict === 'warn' ? 'warning' : 'neutral'}>{statusLabel(el)}</div>
      <p className="result-conclusion">{el.impact?.reason || el.reason || '已完成核验。'}</p>
      {el.diff && <table className="result-diff">
        <thead><tr>{el.diff.head.map((value, i) => <th key={i}>{value || '核对项'}</th>)}</tr></thead>
        <tbody>{el.diff.rows.map(([name, actual, expected]) => <tr key={name}><th>{name}</th><td>{actual}</td><td>{expected}</td></tr>)}</tbody>
      </table>}
      {primarySource ? <section className="result-source">
        <h4>出处</h4>
        {renderSource(primarySource)}
      </section> : <p className="review-meta">暂无可回查出处</p>}
      {el.advice && <p className="result-advice">{el.advice}</p>}
      {el.note && <p className="result-advice">律师批注 · {el.note}</p>}
      {el.confirmed && <p className="review-meta">已确认</p>}
      {el.ignored && <p className="review-meta">已忽略，仍列入报告</p>}
      {(!mode || editingText) && <div className="result-actions">
        {primary && <button className="btn btn-pri btn-sm" onClick={primary[1]}>{primary[0]}</button>}
        <button className="btn-txt" onClick={() => dispatch({ type: 'ASSISTANT', open: true, tool: 'auto',
          selection: { id: el.id, text: el.quote, position: el.loc, canReplace: true } })}>✦ 问 AI</button>
        {(el.type === 'E-CASE' || el.src === 'l3') && <button className="btn-txt"
          onClick={async () => {
            try {
              await exportCaseReport({ caseName: c.name, docTitle: c.docNames?.[state.doc], items: [el], lawyer: state.accountName });
              toast('已下载单案检索报告');
            } catch (error) { toast('导出失败 · ' + error.message); }
          }}>📦 本案检索报告</button>}
        <SearchSelect action label="更多操作" options={[
          ...(primary?.[0] !== '修改声明' ? [{value: 'edit', label: '修改声明'}] : []),
          ...(primary?.[0] !== '关联出处' ? [{value: 'relink', label: '关联出处'}] : []),
          {value: 'note', label: '批注'},
          ...(el.verdict === 'warn' && !el.ignored ? [{value: 'ignore', label: '忽略预警'}] : []),
          ...(isMissing(el) ? [{value: 'delete', label: '删除此句'}] : []),
        ]} onChange={(value) => {
          if (value === 'ignore') act('ignore', '忽略预警 · 保留在报告');
          else open(value, value === 'edit' ? el.quote : value === 'note' ? el.note : '');
        }} />
      </div>}
      <details className="result-details"><summary>核验详情</summary>
        <p className="review-meta">{ELEMENTS[el.type]?.[0]} · {el.loc || '正文'}{el.conf != null ? ' · 演示置信度 ' + el.conf + '%' : ''}</p>
        <blockquote>{el.quote}</blockquote>
        {primarySource?.excerpt && <blockquote>{primarySource.excerpt}</blockquote>}
        {moreSources.map(renderSource)}
        {el.impact && !el.impact.detached && <button className="btn-txt" onClick={() => dispatch({ type: 'SELECT', id: el.impact.from })}>查看关联声明</button>}
        {el.timing && <ul>{el.timing.map((date) => <li key={date}>{date}</li>)}</ul>}
        <div className="check-list">{standards.map(({ code, name, status }) => <span key={code} data-status={status}>{name} · {status}</span>)}</div>
        {!!el.audit?.length && <div className="audit"><div className="audit-t">人工操作记录</div>
          {el.audit.map((entry, i) => <div className="audit-i" key={i}><time>{entry.t}</time><span>{entry.actor} · {entry.msg}</span></div>)}
        </div>}
      </details>
      {editingText && <WideEditor title={mode === 'edit' ? '修改声明' : '律师批注'}
        label={mode === 'edit' ? '修改后的正文' : '批注内容'}
        initial={draft} original={el.quote} canClear={mode === 'note'}
        hint={mode === 'edit' ? `${el.loc || '正文'} · 保存后局部重核` : '批注会显示在本句核验结果和审阅版 Word 中。'}
        saveLabel={mode === 'edit' ? '保存并局部重核' : '保存批注'}
        onClose={() => setMode('')}
        onSave={(value) => {
          if (mode === 'edit') saveEdit(value);
          else { act('note', '保存人工批注', { note: value.trim() }); setMode(''); }
        }} />}
      {mode && !editingText && <div className="note-box">
        {mode === 'manual' ? <>
          <p>对照原文逐项确认，填写本次核验说明。</p>
          {standards.map(({ code, name }) => <label className="manual-check" key={code}>
            <input type="checkbox" checked={!!checked[code]} onChange={(e) => setChecked({ ...checked, [code]: e.target.checked })} />{code} {name}
          </label>)}
          <textarea aria-label="人工核验说明" value={draft} onChange={(e) => setDraft(e.target.value)} />
        </> : mode === 'relink' ? <>
          <SearchSelect label="选择材料" value={material} placeholder="选择卷内材料"
            options={c.mats.filter((m) => !['law', 'case'].includes(m.t)).map((m) => ({ value: m.id, label: m.n, keywords: m.g }))}
            onChange={setMaterial} />
          <input placeholder="页码 / 条款 / 时间戳" value={location} onChange={(e) => setLocation(e.target.value)} />
          <textarea placeholder="粘贴命中原文" value={excerpt} onChange={(e) => setExcerpt(e.target.value)} />
        </> : <p>删除后该声明将从正文移除，报告保留操作记录。</p>}
        <div className="ops">
          {mode === 'manual' && <button className="op pri" disabled={!draft.trim() || !standards.every(({ code }) => checked[code])}
            onClick={() => {
              act('verify', '逐项核验 · ' + draft.trim(), { patch: {
                verdict: 'note', issue: null, conf: null, reason: '人工核验 · ' + draft.trim(), advice: '', diff: null,
                checks: Object.fromEntries(standards.map(({ code }) => [code, '通过'])),
              } });
              setMode('');
            }}>通过并保留人工标注</button>}
          {mode === 'relink' && <button className="op pri" onClick={relink}>保存挂靠</button>}
          {mode === 'delete' && <button className="op bye" onClick={() => act('delete', '删除缺源声明 · ' + el.quote, { quote: '', patch: { deleted: true } })}>确认删除</button>}
          <button className="op" onClick={() => setMode('')}>取消</button>
        </div>
      </div>}

    </div>
  );
}
