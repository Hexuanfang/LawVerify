import React, { useEffect, useRef, useState } from 'react';
import { useApp, selCase, selEls, verdictCounts, patchedDocEls } from '../../store/AppStore.jsx';
import { paperRef } from '../../utils/verdict.js';
import Topbar from './Topbar.jsx';
import MaterialsPane from './MaterialsPane.jsx';
import { DocumentBody } from '../../features/documents/templates.jsx';
import Assistant from './Assistant.jsx';
import { blocksExport, paragraphLocation, statusLabel, ELEMENTS } from '../../utils/review.js';
import LinkageCard from './LinkageCard.jsx';

const blockSelector = 'p, li, td, h1, h2, h3';

const TODO_TABS = [
  { id: 'todo', name: '待办', match: (item) => blocksExport(item) },
  { id: 'warn', name: '预警', match: (item) => item.verdict === 'warn' },
  { id: 'note', name: '标注', match: (item) => item.verdict === 'note' },
  { id: 'pass', name: '已通过', match: (item) => item.verdict === 'pass' },
];

export default function WorkspacePage({ toast, hidden }) {
  const { state, dispatch } = useApp();
  const [offer, setOffer] = useState(null);
  const [menu, setMenu] = useState(null);
  const [tab, setTab] = useState('todo');
  const c = selCase(state);
  const tabList = useRef(null);
  const els = selEls(state);
  const docTitle = c.docNames?.[state.doc];
  const emptyDoc = !c.docs.length;
  const current = els.find((item) => item.id === state.sel);
  const located = current && { ...current, loc: paragraphLocation(paperRef.current, current.id) };
  const blocked = els.filter(blocksExport);
  const warnings = els.filter((item) => item.verdict === 'warn' && !item.ignored);
  const counts = verdictCounts(els);
  const dirtyIds = Object.keys(state.dirty).filter((id) => els.some((item) => item.id === id));
  const select = (id) => dispatch({ type: 'SELECT', id });
  const startDraft = (tool) => dispatch({ type: 'ASSISTANT', open: true, tool: tool || 'draft', selection: null });

  useEffect(() => {
    if (hidden) return;
    const list = tabList.current;
    const currentTab = list?.querySelector('[aria-current]');
    if (!currentTab) return;
    const tab = currentTab.getBoundingClientRect();
    const bounds = list.getBoundingClientRect();
    if (tab.left < bounds.left) list.scrollLeft += tab.left - bounds.left;
    if (tab.right > bounds.right) list.scrollLeft += tab.right - bounds.right;
  }, [state.doc, hidden]);

  useEffect(() => {
    if (!state.sel || hidden) return;
    document.querySelector('[data-el="' + state.sel + '"]')?.scrollIntoView({ block: 'nearest' });
  }, [state.sel, state.doc, state.caseId, hidden]);

  useEffect(() => { setOffer(null); setMenu(null); }, [state.caseId, state.doc, hidden, state.assistantOpen, state.editMode]);

  const onSelection = () => {
    if (state.editMode) return;
    const selection = window.getSelection();
    const text = selection?.toString().trim();
    const paper = paperRef.current;
    if (!text || !selection.rangeCount || !paper?.contains(selection.anchorNode) || !paper.contains(selection.focusNode)) {
      setOffer(null);
      return;
    }
    const range = selection.getRangeAt(0);
    const start = range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer : range.startContainer.parentElement;
    const end = range.endContainer.nodeType === Node.ELEMENT_NODE ? range.endContainer : range.endContainer.parentElement;
    const block = start?.closest(blockSelector);
    const mark = start?.closest('[data-el]');
    const endMark = end?.closest('[data-el]');
    const id = mark === endMark ? mark?.dataset.el : undefined;
    const index = [...paper.querySelectorAll(blockSelector)].indexOf(block);
    const viewport = paper.closest('.doc-scroll').getBoundingClientRect();
    const rect = [...range.getClientRects()].find((box) => box.width > 0 && box.height > 0 &&
      box.bottom > viewport.top && box.top < viewport.bottom);
    if (!rect) { setOffer(null); return; }
    setOffer({
      left: Math.max(12, Math.min(window.innerWidth - 135, rect.left)),
      top: rect.top - 37 >= viewport.top ? rect.top - 37 : Math.min(rect.bottom + 6, window.innerHeight - 40),
      selection: { id, text, position: index < 0 ? '选中文本' : '第 ' + (index + 1) + ' 段', canReplace: !!id && text === mark.textContent.trim() },
    });
  };

  useEffect(() => {
    if (!offer) return;
    const dismiss = (event) => {
      if (event.type === 'keydown' && event.key !== 'Escape') return;
      if (event.type === 'pointerdown' && event.target.closest('.ask-selection')) return;
      setOffer(null);
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', dismiss);
    window.addEventListener('resize', dismiss);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', dismiss);
      window.removeEventListener('resize', dismiss);
    };
  }, [offer]);

  const ask = (tool) => {
    const selection = offer?.selection;
    setOffer(null);
    dispatch({ type: 'ASSISTANT', open: true, selection, tool: tool || 'auto' });
  };

  const onContextMenu = (event) => {
    if (state.editMode) return;
    const mark = event.target.closest?.('[data-el]');
    const paper = paperRef.current;
    if (!paper) return;
    event.preventDefault();
    const id = mark?.dataset.el;
    const selectedText = window.getSelection()?.toString().trim() || mark?.textContent.trim() || '';
    setMenu({
      x: Math.min(event.clientX, window.innerWidth - 180),
      y: Math.min(event.clientY, window.innerHeight - 220),
      id, selectedText,
      position: id ? paragraphLocation(paper, id) : '选中文本',
    });
  };

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    document.addEventListener('pointerdown', close);
    document.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('scroll', close, true);
    };
  }, [menu]);

  const menuAct = (action) => {
    const { id, selectedText, position } = menu;
    setMenu(null);
    if (action === 'ask') {
      dispatch({ type: 'ASSISTANT', open: true, tool: 'auto', selection: { id, text: selectedText, position, canReplace: false } });
    } else if (action === 'rewrite') {
      dispatch({ type: 'ASSISTANT', open: true, tool: 'rewrite', selection: { id, text: selectedText, position, canReplace: !!id } });
    } else if (action === 'statute') {
      dispatch({ type: 'ASSISTANT', open: true, tool: 'statute-mcp', selection: id ? { id, text: selectedText, position, canReplace: false } : null });
    } else if (action === 'case') {
      dispatch({ type: 'ASSISTANT', open: true, tool: 'case-mcp', selection: id ? { id, text: selectedText, position, canReplace: false } : null });
    } else if (action === 'reverify') {
      dispatch({ type: 'REVERIFY', scope: 'local', ids: id ? [id] : undefined });
      if (!id) dispatch({ type: 'REVERIFY', scope: 'all' });
    } else if (action === 'edit') {
      if (id) select(id);
      dispatch({ type: 'SET_EDIT_MODE', on: true });
    }
  };

  const visibleTab = TODO_TABS.find((row) => row.id === tab) || TODO_TABS[0];
  const listItems = tab === 'todo'
    ? [...blocked, ...warnings.filter((item) => !blocked.includes(item))]
    : els.filter(visibleTab.match);
  const doneCount = els.length - blocked.length;
  const progress = els.length ? Math.round((doneCount / els.length) * 100) : 0;
  /* 文书标签核验徽标：不点进去也能感知状态 */
  const docBadge = (key) => {
    const items = patchedDocEls(state, key);
    if (!items.length) return null;
    const nBlocked = items.filter(blocksExport).length;
    const nWarn = items.filter((item) => item.verdict === 'warn' && !item.ignored).length;
    if (nBlocked) return { cls: 'bad', n: nBlocked, tip: nBlocked + ' 项待办（不通过 / 待核验）' };
    if (nWarn) return { cls: 'warn', n: nWarn, tip: nWarn + ' 项预警，可选复核' };
    return { cls: 'ok', n: 0, tip: '核验项已处理' };
  };
  const openAssistant = () => dispatch({ type: 'ASSISTANT', open: true, tool: 'auto', selection: state.selection });

  return <div className="page active" id="pg-ws" style={hidden ? { display: 'none' } : undefined}>
    <Topbar />
    <div className={'ws mvp-workspace' + (state.assistantExpanded ? ' ws-assistant-wide' : '')}>
      <MaterialsPane key={c.id} />
      <main className="pane-c">
        <div className="ctool mvp-document-bar">
          {emptyDoc ? <span>暂无文书</span> : <>
            <div className="document-tools">
              <span className="document-count">共 <b>{c.docs.length}</b> 份</span>
              <div className="document-tabs">
                <nav ref={tabList} aria-label="案件文书">
                  {c.docs.map((key) => {
                    const badge = docBadge(key);
                    return <button key={key} type="button" aria-current={key === state.doc ? 'true' : undefined}
                      title={c.docNames[key] + (badge ? ' · ' + badge.tip : '')}
                      onClick={() => { if (key !== state.doc) dispatch({ type: 'SET_DOC', doc: key }); }}>
                      {badge && <i className={'tab-dot ' + badge.cls} aria-hidden="true" />}
                      <span>{c.docNames[key]}</span>
                      {badge?.cls === 'bad' && <b className="tab-n" aria-label={badge.tip}>{badge.n}</b>}
                    </button>;
                  })}
                </nav>
                {c.docs.length > 3 && <div className="document-tab-controls">
                  <button type="button" aria-label="向左浏览文书" onClick={() => tabList.current.scrollBy({ left: -tabList.current.clientWidth * .75, behavior: 'smooth' })}>‹</button>
                  <button type="button" aria-label="向右浏览文书" onClick={() => tabList.current.scrollBy({ left: tabList.current.clientWidth * .75, behavior: 'smooth' })}>›</button>
                </div>}
              </div>
              <div className="document-actions">
                <button className="btn btn-gh btn-sm doc-act" title="打开 AI 助手（可起草、查法条、查案例）" onClick={openAssistant}>✦ AI 助手</button>
              </div>
            </div>
          </>}
        </div>
        {!emptyDoc && <div className="doc-head">
          <b className="doc-head-title" title={docTitle}>{docTitle}</b>
          <small>当前文书</small>
          <div className="doc-head-ops">
            <button
              className={'btn btn-gh btn-sm doc-act' + (state.editMode ? ' editing-on' : '')}
              onClick={() => dispatch({ type: 'SET_EDIT_MODE', on: !state.editMode })}
              title="在线编辑当前文书，改后可局部或全文重核"
            >
              {state.editMode ? '✓ 退出编辑' : '✎ 在线编辑'}
            </button>
            <button className="btn btn-pri btn-sm doc-act" title="对当前文书运行 AI 核验" onClick={() => dispatch({ type: 'START_PROC' })}>AI 核验</button>
          </div>
        </div>}
        {state.editMode && !emptyDoc && <div className="editor-bar" role="toolbar" aria-label="在线编辑">
          <span className="editor-hint">在线编辑中 · 修改声明后该句转「待核验」，可局部或全文重核</span>
          <button className="op pri" disabled={!dirtyIds.length}
            onClick={() => dispatch({ type: 'REVERIFY', scope: 'local', ids: dirtyIds })}>
            局部重核{dirtyIds.length ? '（' + dirtyIds.length + '）' : ''}
          </button>
          <button className="op" onClick={() => dispatch({ type: 'REVERIFY', scope: 'all' })}>全文重核</button>
          <button className="op" onClick={() => dispatch({ type: 'SET_EDIT_MODE', on: false })}>完成编辑</button>
        </div>}
        <div className="doc-scroll" key={'paper/' + c.id + '/' + state.doc} onScroll={() => setOffer(null)}>
          <article className={'doc-paper mvp-paper' + (state.editMode ? ' editing' : '')}
            onMouseUp={onSelection} onKeyUp={onSelection} onContextMenu={onContextMenu}
            ref={(node) => { paperRef.current = node; }}>
            {emptyDoc ? <div className="empty-doc">
              <b>导入文书，开始核验</b>
              <p>选择待核验的文书和相关案件材料，或让 AI 按代理立场起草。</p>
              <button className="btn btn-pri btn-sm" onClick={() => dispatch({ type: 'OPEN_UPLOAD', caseId: c.id })}>导入待核验文书</button>
              <button className="btn-txt document-draft" onClick={() => startDraft('draft')}>＋ AI 起草新文书</button>
            </div> : <DocumentBody project={c} doc={state.doc} title={docTitle} items={els} />}
          </article>
        </div>
        <Assistant key={state.caseId + '/' + state.doc} toast={toast} />
      </main>
      <aside className="pane-r mvp-review" aria-label="核验结果">
        <div className="review-pane-head">
          <b>{located ? '本句核验' : '核验待办'}</b>
          {located && <button className="btn-txt" onClick={() => select(null)}>返回待办</button>}
        </div>
        {located ? <div className="rp"><LinkageCard key={located.id} el={located} toast={toast} dispatch={dispatch} /></div>
          : <div className="review-overview">
            {emptyDoc ? <p>导入或起草文书后，这里按律师核验重点列出待办。</p> : !els.length ? <>
              <h2 className="overview-title">暂无核验结果</h2>
              <p>运行 AI 核验后，这里只列需要处理的声明。</p>
              <button className="btn btn-pri btn-sm" onClick={() => dispatch({ type: 'START_PROC' })}>AI 核验当前文书</button>
            </> : <>
              <div className="todo-progress">
                <div className="todo-progress-head">
                  <span><strong>{blocked.length}</strong> 项待办</span>
                  <small>{doneCount}/{els.length} 已处理 · {progress}%</small>
                </div>
                <div className="todo-track"><i style={{ width: progress + '%', background: blocked.length ? 'var(--st-bad)' : 'var(--st-ok)' }} /></div>
                <p className="todo-caption">
                  {blocked.length
                    ? '先处理不通过和待核验，才能导出 Word。'
                    : '必处理项已清零，可导出 Word。'}
                </p>
              </div>
              <div className="todo-tabs" role="tablist">
                {TODO_TABS.map((row) => {
                  const n = row.id === 'todo' ? blocked.length : els.filter(row.match).length;
                  return <button key={row.id} role="tab" aria-selected={tab === row.id}
                    className={tab === row.id ? 'on' : ''} onClick={() => setTab(row.id)}>
                    {row.name}<b>{n}</b>
                  </button>;
                })}
              </div>
              <div className="todo-list">
                {listItems.length ? listItems.map((item) => (
                  <button key={item.id} className={'todo-card st-' + item.verdict} onClick={() => select(item.id)}>
                    <span className="todo-tag">{statusLabel(item)}</span>
                    <span className="todo-type">{ELEMENTS[item.type]?.[0] || item.type}</span>
                    <span className="todo-loc">{paragraphLocation(paperRef.current, item.id)}</span>
                    <b className="todo-reason">{item.impact?.reason || item.reason || '等待处理'}</b>
                    <small className="todo-quote">{item.quote}</small>
                    {item.verifiedText && <span className="todo-fix">建议改为：{item.verifiedText}</span>}
                    <span className="todo-go">处理 →</span>
                  </button>
                )) : <p className="review-meta">此分组暂无条目。</p>}
              </div>
              {warnings.length > 0 && tab === 'todo' && <details className="overview-warnings">
                <summary>预警 {warnings.length} 项 · 可选复核，不阻断导出</summary>
              </details>}
              <div className="overview-actions">
                <button className="btn btn-pri btn-sm" onClick={() => dispatch({ type: 'NAV', page: 'report' })}>
                  {blocked.length ? '查看核验报告' : '查看报告并导出 Word'}
                </button>
                <button className="btn-txt" onClick={() => startDraft('draft')}>＋ AI 起草</button>
              </div>
            </>}
          </div>}
      </aside>
    </div>
    {offer && <div className="ask-selection" style={{ left: offer.left, top: offer.top }}>
      <button onPointerDown={(event) => event.preventDefault()} onClick={() => ask('auto')}><span aria-hidden="true">✦</span> 问 AI 助手</button>
      <button onPointerDown={(event) => event.preventDefault()} onClick={() => ask('rewrite')}>改写</button>
      <button onPointerDown={(event) => event.preventDefault()} onClick={() => ask('statute')}>查法条</button>
      <button onPointerDown={(event) => event.preventDefault()} onClick={() => ask('case')}>查案例</button>
    </div>}
    {menu && <div className="doc-context" style={{ left: menu.x, top: menu.y }} role="menu">
      <div className="doc-context-label">{menu.position}{menu.id ? ' · ' + ELEMENTS[els.find((item) => item.id === menu.id)?.type]?.[0] : ''}</div>
      <button onClick={() => menuAct('ask')}>✦ 问 AI 助手</button>
      <button onClick={() => menuAct('rewrite')}>🪄 改写选中</button>
      <button onClick={() => menuAct('statute')}>📖 查法条</button>
      <button onClick={() => menuAct('case')}>⚖️ 查案例</button>
      <button onClick={() => menuAct('reverify')}>⟳ 局部重核</button>
      <button onClick={() => menuAct('edit')}>✎ 进入编辑</button>
    </div>}
  </div>;
}
