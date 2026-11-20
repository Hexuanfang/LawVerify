import React, { useState } from 'react';
import { useApp, selCase, selEls, verdictCounts, SRCN } from '../store/AppStore.jsx';
import { exportWord } from '../utils/exportWord.js';
import { exportCaseReport } from '../utils/caseReport.js';
import { paperRef } from '../utils/verdict.js';
import { blocksExport, isRed, statusLabel, ELEMENTS, paragraphLocation } from '../utils/review.js';

const sections = [
  ['不通过 · 需人工处理', isRed],
  ['待核验', (item) => item.verdict === 'pending'],
  ['预警 · 建议复核', (item) => item.verdict === 'warn'],
  ['通过·标注', (item) => item.verdict === 'note'],
  ['通过', (item) => item.verdict === 'pass'],
];
const categories = [['l1', '事实及证据'], ['l2', '法条'], ['l3', '案例']];
const classify = (item) => item.src !== 'l0' ? item.src : item.type === 'E-CASE' ? 'l3' : ['E-LAW', 'E-CLAIM', 'E-PROC'].includes(item.type) ? 'l2' : 'l1';

export default function ReportPage({ toast }) {
  const { state, dispatch } = useApp();
  const [busy, setBusy] = useState(false);
  const [openSection, setOpenSection] = useState('fail');
  const c = selCase(state);
  const title = c.docNames?.[state.doc] || '文书';
  const hasDoc = c.docs.includes(state.doc);
  const body = paperRef.current;
  const items = selEls(state).map((item) => ({ ...item, loc: paragraphLocation(body, item.id) }));
  const counts = verdictCounts(items);
  const firstBlocker = items.find(blocksExport);
  const canExport = hasDoc && !!items.length && !firstBlocker;
  const hasWarnings = items.some((item) => item.verdict === 'warn' && !item.ignored);
  const outcome = counts.fail ? (['lsh', 'flyj'].includes(state.doc.split('-')[0]) ? '禁止外发' : '需修改后复检')
    : canExport ? '可导出 Word' : '待核验';
  const when = state.checkedAt[c.id + '/' + state.doc] || (c.fileDocs?.[state.doc] ? '尚未核验' : '演示快照 2026-11-05');
  const version = '原型 v1.2 · 示例引用';
  const audits = state.auditLog.filter((entry) => entry.caseId === c.id && entry.doc === state.doc);
  const impacts = items.filter((item) => item.impact);
  const caseItems = items.filter((item) => item.src === 'l3' || item.type === 'E-CASE' || item.sources.some((source) => source.st === 'l3'));
  const countText = (count) => '通过 ' + count.pass + ' · 标注 ' + count.note + ' · 预警 ' + count.warn + ' · 不通过 ' + count.fail + ' · 待核验 ' + count.pending;
  const summaries = categories.map(([key, name]) => [name, verdictCounts(items.filter((item) => classify(item) === key))]);
  const linesFor = (item) => [
    item.id + ' · ' + item.loc + ' · ' + statusLabel(item) + ' · ' + item.quote,
    item.sources.length ? item.sources.map((source) => SRCN[source.st] + ' ' + source.name + ' · ' + source.loc).join(' ｜ ') : '出处缺失 · ' + item.reason,
    ...(item.timing || []),
    ...(item.diff?.rows.map(([name, actual, expected]) => name + '：文书 ' + actual + ' / 出处 ' + expected) || []),
    ...[item.advice, item.note && '人工批注 · ' + item.note, item.ignored && '已忽略，保留预警'].filter(Boolean),
  ];
  const report = ['总体结论 · ' + outcome, ...summaries.map(([name, count]) => name + ' · ' + countText(count)),
    ...sections.flatMap(([name, matches]) => [name, ...items.filter(matches).flatMap(linesFor)]),
    ...impacts.map((item) => '联动影响 · ' + item.id + ' ← ' + item.impact.from + ' · ' + item.impact.reason),
    ...audits.map((entry) => entry.t + ' · ' + entry.actor + ' · ' + entry.msg), when, version];
  const jump = (id) => {
    dispatch({ type: 'NAV', page: 'ws' });
    dispatch({ type: 'SET_FILTER', f: 'all' });
    dispatch({ type: 'SELECT', id });
    requestAnimationFrame(() => document.querySelector('[data-el="' + id + '"]')?.scrollIntoView({ block: 'center' }));
  };
  const download = async (review) => {
    if (!canExport || busy) return;
    setBusy(true);
    try { await exportWord({ title, body: paperRef.current, items, report, review }); toast('已下载 Word 文档'); }
    catch (error) { toast('导出失败 · ' + error.message); }
    finally { setBusy(false); }
  };
  const downloadCases = async () => {
    setBusy(true);
    try {
      const n = await exportCaseReport({ caseName: c.name, docTitle: title, items, lawyer: state.accountName });
      toast(n ? '案例检索报告已下载（' + n + ' 件）' : '本文书暂无 L3 案例引用');
    } catch (error) { toast('导出失败 · ' + error.message); }
    finally { setBusy(false); }
  };

  const workSections = [
    { id: 'fail', name: '一、必须处理', items: items.filter(isRed), hint: '不通过 / 缺源 · 阻断导出' },
    { id: 'pending', name: '二、待核验', items: items.filter((item) => item.verdict === 'pending'), hint: '修改后未重核，或新插入声明' },
    { id: 'warn', name: '三、建议复核', items: items.filter((item) => item.verdict === 'warn' && !item.ignored), hint: '不阻断导出，可忽略并留痕' },
    { id: 'note', name: '四、通过·标注', items: items.filter((item) => item.verdict === 'note'), hint: '已放行，报告保留标注' },
  ];

  return <div className="page active" id="pg-report">
    <div className="topbar">
      <button className="btn-txt" onClick={() => dispatch({ type: 'NAV', page: 'ws' })}>← 返回工作台</button>
      <b>核验报告</b>
      <button className="btn-txt" onClick={() => dispatch({ type: 'ASSISTANT', open: true, tool: 'auto', selection: null })}>✦ 问 AI 助手</button>
    </div>
    <div className="rp-w fade">
      <div className="rp-hero">
        <h1>{title} · 质证联动核验报告</h1>
        <div className="sub">{[c.name, c.court].filter(Boolean).join(' ｜ ')} ｜ 律师 {state.accountName}</div>
      </div>

      <div className={`vb ${firstBlocker ? 'bad' : canExport && !hasWarnings ? 'ready' : 'warn'}`}>
        <i /><span>{outcome}{canExport && hasWarnings ? ' · 有预警可选复核' : ''}</span>
        <small className="vb-meta">{when} ｜ {version}</small>
      </div>

      <section className="report-download" aria-labelledby="report-download-title" aria-busy={busy}>
        <h2 id="report-download-title">下一步动作</h2>
        {!canExport && <div className="report-download-help">
          <p>{firstBlocker ? '还有不通过 / 待核验项。建议先处理第一个待办，再回来导出。' : '文书有核验结果后即可下载。'}</p>
          <button className="btn-txt" onClick={() => firstBlocker ? jump(firstBlocker.id) : dispatch({ type: 'NAV', page: 'ws' })}>
            {firstBlocker ? '定位首个待处理项 →' : '返回工作台 →'}
          </button>
        </div>}
        <div className="report-download-options">
          <article>
            <h3>① 审阅版 Word</h3>
            <p>正文保留原稿，核验提示、出处和人工批注写入 Word 原生批注，适合内部复核。</p>
            <button className="btn btn-pri btn-sm" disabled={!canExport || busy} onClick={() => download(true)}>下载审阅版</button>
          </article>
          <article>
            <h3>② 清洁正文＋核验报告</h3>
            <p>正文去除行内核验标记，核验报告附在同一 Word 末尾，便于归档和留痕。</p>
            <button className="btn btn-gh btn-sm" disabled={!canExport || busy} onClick={() => download(false)}>下载清洁版＋报告</button>
          </article>
          <article>
            <h3>③ 案例检索报告</h3>
            <p>把本文书引用的 L3 案例（可含助手检索补充）打包成可归档的检索报告。</p>
            <button className="btn btn-gh btn-sm" disabled={busy || !caseItems.length && !items.length} onClick={downloadCases}>
              一键导出案例报告{caseItems.length ? '（' + caseItems.length + '）' : ''}
            </button>
          </article>
        </div>
      </section>

      <div className="report-counts">
        {summaries.map(([name, count]) => <div key={name}><b>{name} · {count.all} 条</b><small>{countText(count)}</small></div>)}
      </div>

      <div className="report-todo-rail">
        {workSections.map((section) => (
          <section className="report-section" key={section.id}>
            <button className="report-section-head" onClick={() => setOpenSection(openSection === section.id ? '' : section.id)}
              aria-expanded={openSection === section.id}>
              <b>{section.name}</b>
              <span>{section.items.length ? section.items.length + ' 项 · ' + section.hint : '无'}</span>
              <i aria-hidden="true">{openSection === section.id ? '▾' : '▸'}</i>
            </button>
            {openSection === section.id && (section.items.length ? section.items.map((item) => (
              <button className="iss report-item" key={item.id} onClick={() => jump(item.id)}>
                <span className={`report-tag st-${item.verdict}`}>{statusLabel(item)}</span>
                <div className="iss-b">
                  <b>{item.id} · {item.loc} · {ELEMENTS[item.type]?.[0]}</b>
                  {linesFor(item).map((line, i) => <span key={i}>{i === 0 ? item.quote : line}</span>)}
                </div>
                <span className="iss-go">定位 →</span>
              </button>
            )) : <p className="review-meta">本组无条目。</p>)}
          </section>
        ))}
      </div>

      <section className="report-section">
        <h3>联动影响</h3>
        {impacts.length ? impacts.map((item) =>
          <button className="op" key={item.id} onClick={() => jump(item.id)}>{item.id} ← {item.impact.from} · {item.impact.reason}</button>
        ) : <p className="review-meta">无</p>}
      </section>

      <section className="report-section">
        <h3>案例检索报告 <small>{caseItems.length} 件</small></h3>
        <p className="review-meta">一键导出本文书引用的类案四要素、要旨与文书原文对照。助手检索新增命中会一并打包。</p>
        {caseItems.length ? caseItems.map((item) => (
          <button className="iss report-item" key={item.id} onClick={() => jump(item.id)}>
            <span className={`report-tag st-${item.verdict}`}>{statusLabel(item)}</span>
            <div className="iss-b"><b>{item.sources.find((source) => source.st === 'l3')?.name || item.quote.slice(0, 40)}</b>
              <span>{item.quote}</span>
            </div>
            <span className="iss-go">定位 →</span>
          </button>
        )) : <p className="review-meta">本文书暂无 L3 案例引用。可在 AI 助手使用「案例」检索后生成。</p>}
        <button className="btn btn-gh btn-sm" style={{ marginTop: 8 }} disabled={busy} onClick={downloadCases}>📦 一键导出案例检索报告</button>
      </section>

      <section className="report-section">
        <h3>人工与助手操作记录</h3>
        {audits.length ? <details><summary>共 {audits.length} 条留痕</summary>
          {audits.map((entry, i) => <p key={i}>{entry.t} · {entry.actor} · {entry.msg}</p>)}
        </details> : <p className="review-meta">暂无操作记录</p>}
      </section>

      <section className="report-section">
        <h3>核验时间与库版本</h3>
        <p>{when} ｜ {version}</p>
        <p className="review-meta">AI 仅辅助，最终责任在律师。缺源不编造；引号内逐字一致；判项不反转。</p>
      </section>
    </div>
  </div>;
}
