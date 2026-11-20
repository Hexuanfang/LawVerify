import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { elById, selCase, selEls, useApp } from '../../store/AppStore.jsx';
import { ALL_DOCS } from '../../data/cases.js';
import { CASE_MEMORY, noteRecord } from '../../data/memory.js';
import { ASSISTANT_SKILLS, ASSISTANT_TOOLS } from '../../data/skills.js';
import { callLegalCase, callLegalStatute } from '../../utils/mcp.js';
import { exportCaseReport } from '../../utils/caseReport.js';
import { openSource } from './MaterialsPane.jsx';
import LawLogo from '../../components/LawLogo.jsx';

const MODE_CARDS = [
  { id: 'draft', icon: '✍️', name: '起草文书', desc: '按代理立场出稿', starter: '起草一份起诉状' },
  { id: 'statute-mcp', icon: '📖', name: '查法条', desc: '现行有效与替代', starter: '查民法典第577条' },
  { id: 'case-mcp', icon: '⚖️', name: '查类案', desc: '相似案情检索', starter: '检索民间借贷类案' },
];

function searchSources(state, query) {
  const c = selCase(state);
  const known = Object.values(c.els).flat().flatMap((item) => item.sources);
  const materials = c.mats.filter((m) => !['law', 'case'].includes(m.t)).map((m) => {
    const source = known.find((entry) => entry.name === m.n);
    return { ...m, st: 'l1', name: m.n, loc: source?.loc || '材料目录', excerpt: m.text || source?.excerpt || '' };
  });
  const terms = query.match(/\d{3,}|[\u4e00-\u9fff]{2,}/g) || [];
  const searchText = (str) => str.toLowerCase().replace(/[,，\s]/g, '');
  return materials.map((source) => {
    const content = searchText(source.name + ' ' + source.loc + ' ' + source.excerpt);
    const score = terms.reduce((sum, term) => {
      const word = searchText(term);
      if (content.includes(word)) return sum + 5;
      if (/^\d+$/.test(word)) return sum;
      return sum + Array.from({ length: word.length - 1 }, (_, i) => word.slice(i, i + 2)).filter((part) => content.includes(part)).length;
    }, 0);
    return { ...source, score };
  }).filter((source) => source.score > 0).sort((a, b) => b.score - a.score).slice(0, 5);
}

const docNames = [...ALL_DOCS.map(([, label]) => label), '管辖权异议书', '财产保全申请书', '调查取证申请书'];
const fullDraft = /(?:起草|撰写|写|拟|生成|准备).{0,20}(?:一份|新文书|全文)/;
const lookup = /依据|证据|凭证|找一下|查一下|出处|来源|法条|判例|类案|检索|从哪|哪条|哪份|为什么|支持|核对/;
const rewrite = /改写|重写|润色|改成|修改|精简|简短|准确|措辞|改一下|压缩|正式用语|更正式|更严谨/;
const draftRequest = /起草|撰写|补写|续写|写一|写个|拟一|生成草稿/;
const statuteAsk = /法条|条文|第.{1,8}条|效力|现行|废止|民法典|司法解释|请求权基础/;
const caseAsk = /案例|类案|判例|案号|裁判要旨|指导性案例|公报案例|（\d{4}）/;
const reportAsk = /案例检索报告|导出案例|打包案例|类案报告/;

function identifyIntent(query, selection, previous, tool) {
  // 工具锁存优先
  if (tool === 'statute-mcp') return { mode: 'mcp-statute' };
  if (tool === 'case-mcp') return { mode: 'mcp-case' };
  if (tool === 'case-report') return { mode: 'case-report' };
  if (tool === 'inbox-search') return { mode: 'search' };
  if (tool === 'draft') return { mode: 'draft', docTitle: docNames.find((name) => query.includes(name)), newDoc: !selection };
  if (tool === 'rewrite') {
    if (selection) return { mode: 'edit' };
    return { message: '请先选中要改写的文段，再告诉我希望怎么改。' };
  }

  if (reportAsk.test(query)) return { mode: 'case-report' };
  const docTitle = docNames.find((name) => query.includes(name));
  const drafting = draftRequest.test(query) || /(?:帮我|请|给我|替我)[^，。]{0,6}(?:写|拟)/.test(query);
  if (fullDraft.test(query) || (docTitle && drafting && !/补写|续写|其中的|里的|的(?:事实与理由|一段|一节)/.test(query))) {
    return { mode: 'draft', docTitle, newDoc: true };
  }
  if (statuteAsk.test(query) && !drafting) return { mode: 'mcp-statute' };
  if (caseAsk.test(query) && !drafting) return { mode: 'mcp-case' };
  if (rewrite.test(query)) {
    if (selection) return { mode: 'edit' };
    if (previous?.newDoc) return { mode: 'draft', newDoc: true, docTitle: previous.docTitle.replace(/草稿$/, ''), previousDraft: previous.draft };
    return { message: '请先选中要改写的文段，再告诉我希望怎么改。' };
  }
  if (docTitle && query.trim() === docTitle) return { mode: 'draft', docTitle, newDoc: true };
  if (drafting) return { mode: 'draft', docTitle, newDoc: !selection };
  if (lookup.test(query)) return { mode: 'search' };
  if (previous?.mode === 'search' && /^(?:再|那|还有|继续|也|具体)/.test(query)) return { mode: 'search', previousQuery: previous.query };
  if (previous?.mode?.startsWith('mcp') && /^(?:再|那|还有|继续|也|具体)/.test(query)) {
    return { mode: previous.mode, previousQuery: previous.query };
  }
  return { message: selection
    ? '你希望我找出这段话的依据、改写这段文字，还是补写一段？也可以点上方「法条」或「案例」。'
    : '你想起草文书、查法条 / 案例，还是在卷内找材料？可直接描述，或点上方能力。' };
}

function AutoTextarea({ value, onChange, onKeyDown, inputRef, placeholder, ariaLabel }) {
  const ref = inputRef || useRef(null);
  const resize = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    const max = 152;
    const next = Math.min(el.scrollHeight, max);
    el.style.height = next + 'px';
    el.style.overflowY = el.scrollHeight > max + 2 ? 'auto' : 'hidden';
  };
  useLayoutEffect(resize, [value]);
  useEffect(() => {
    if (!value) resize();
  }, [value]);
  return <textarea
    ref={ref}
    rows={1}
    aria-label={ariaLabel}
    placeholder={placeholder}
    value={value}
    onChange={(event) => { onChange(event.target.value); resize(); }}
    onKeyDown={onKeyDown}
    onInput={resize}
  />;
}

export default function Assistant({ toast }) {
  const { state, dispatch } = useApp();
  const [prompt, setPrompt] = useState('');
  const [history, setHistory] = useState([]);
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const inputRef = useRef(null);
  const scrollRef = useRef(null);

  useEffect(() => {
    if (!state.assistantOpen) return;
    inputRef.current?.focus({ preventScroll: true });
  }, [state.assistantOpen, state.selection]);

  useEffect(() => {
    const list = scrollRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [history.length, state.assistantOpen, busy]);

  useEffect(() => {
    if (!moreOpen) return;
    const close = (event) => {
      if (event.target.closest?.('.assistant-more')) return;
      setMoreOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [moreOpen]);

  const project = selCase(state);
  const memory = CASE_MEMORY[project.id];
  const record = noteRecord(state.memoryNotes, project.id);
  const hasMemory = Boolean(memory || record.stance || record.notes.length);
  const selection = state.selection;
  const current = selection?.id ? elById(state, selection.id) : null;
  const selectedText = selection?.text || current?.quote || '';
  const tool = state.assistantTool;
  const expanded = state.assistantExpanded;

  const setTool = (next) => dispatch({ type: 'ASSISTANT_TOOL', tool: next });
  const close = () => dispatch({ type: 'ASSISTANT', open: false });
  const toggleExpand = () => dispatch({ type: 'ASSISTANT_EXPAND' });

  const submit = async (event) => {
    event.preventDefault();
    const query = prompt.trim();
    if (busy) return;
    if (!query && tool !== 'case-report') return;
    const intent = identifyIntent(query || '生成本文案例检索报告', selection, history.at(-1), tool);
    const id = globalThis.crypto?.randomUUID?.() || String(Date.now());
    setPrompt('');
    if (intent.message) {
      setHistory((old) => [...old, { id, query, message: intent.message }]);
      return;
    }
    if (intent.mode === 'mcp-statute') {
      setHistory((old) => [...old, { id, query, mode: 'mcp-statute', status: 'calling' }]);
      setBusy(true);
      const res = await callLegalStatute({ query });
      setBusy(false);
      setHistory((old) => old.map((turn) => turn.id === id ? { ...turn, status: 'done', mcp: res } : turn));
      dispatch({ type: 'ASSISTANT_AUDIT', id: current?.id, message: '助手调用 legal_statute · ' + query });
      return;
    }
    if (intent.mode === 'mcp-case') {
      setHistory((old) => [...old, { id, query, mode: 'mcp-case', status: 'calling' }]);
      setBusy(true);
      const caseNumber = query.match(/（\d{4}）[^，。；\s]+号/)?.[0] || '';
      const res = await callLegalCase({ query, case_number: caseNumber });
      setBusy(false);
      setHistory((old) => old.map((turn) => turn.id === id ? { ...turn, status: 'done', mcp: res } : turn));
      dispatch({ type: 'ASSISTANT_AUDIT', id: current?.id, message: '助手调用 legal_case · ' + query });
      return;
    }
    if (intent.mode === 'case-report') {
      setHistory((old) => [...old, { id, query, mode: 'case-report', status: 'calling' }]);
      setBusy(true);
      try {
        const els = selEls(state);
        const count = await exportCaseReport({
          caseName: project.name,
          docTitle: project.docNames?.[state.doc],
          items: els,
          lawyer: state.accountName,
        });
        setHistory((old) => old.map((turn) => turn.id === id
          ? { ...turn, status: 'done', message: `已生成案例检索报告（${count} 件），请查看浏览器下载。` } : turn));
        toast('案例检索报告已下载');
      } catch (error) {
        setHistory((old) => old.map((turn) => turn.id === id ? { ...turn, message: '生成失败 · ' + error.message } : turn));
      }
      setBusy(false);
      return;
    }

    const { mode, newDoc, previousDraft } = intent;
    const original = newDoc ? '' : selectedText;
    const target = newDoc ? null : current;
    const focus = memory?.disputeFocuses.find((line) => query.includes('争点') || query.includes('争议') ||
      line.split(/[、，及能否]/).some((phrase) => phrase.length >= 2 && query.includes(phrase)));
    const context = {
      summary: memory?.summary,
      focus,
      stance: record.stance,
      notes: record.notes.map((entry) => entry.text),
      usedStance: Boolean(record.stance) && (mode === 'draft'),
    };
    const sources = searchSources(state, [query, intent.previousQuery, original, focus, context.stance].filter(Boolean).join(' '));
    const docTitle = (intent.docTitle || '文书') + '草稿';
    const exampleFacts = newDoc ? selEls({ ...state, doc: project.docs.includes('qs') ? 'qs' : state.doc })
      .filter((item) => ['E-SUBJ', 'E-FACT'].includes(item.type) && ['pass', 'note'].includes(item.verdict)).slice(0, 3) : [];
    const polish = (text) => text.replaceAll('没', '未').replaceAll('我们觉得', '我方认为').replaceAll('他说', '其陈述').trim();
    const verifiedText = selection?.canReplace && target?.verifiedText;
    let draft = '';
    if (mode === 'edit') draft = verifiedText || polish(original);
    if (mode === 'draft') {
      if (previousDraft) draft = polish(previousDraft);
      else if (newDoc) {
        const stanceLine = record.stance ? '【代理立场】' + record.stance + '\n' : '';
        draft = stanceLine + ['【拟写事项】' + query, ...exampleFacts.map((item) => item.quote), '【待补充】请求、适用依据与材料出处须逐项核对。'].join('\n');
      } else draft = '就本案而言，' + original.replace(/[。]$/, '') + '。相关法律依据与证明范围尚待核对。';
    }
    const entry = {
      id, query, mode, sources, original, draft, context, docTitle, newDoc, verifiedText,
      position: selection?.position, canReplace: !newDoc && selection?.canReplace, exampleFacts,
      anchor: target?.id, anchorQuote: target?.quote.trim(), type: target?.type || 'E-FACT',
    };
    if (mode !== 'search') dispatch({ type: 'ASSISTANT_AUDIT', id: target?.id, message: '助手生成草稿 · 待采纳' });
    setHistory((old) => [...old, entry]);
    setEditing(null);
  };

  const finish = (entry) => {
    setHistory((old) => old.map((turn) => turn.id === entry.id ? { ...turn, finished: true } : turn));
    setEditing(null);
  };
  const patch = (entry, source) => {
    const item = elById(state, entry.anchor);
    if (!item || !source.excerpt) return;
    dispatch({ type: 'OP', id: item.id, action: 'ai', auditMsg: '助手关联候选出处 · ' + source.name,
      patch: { src: source.st, sources: [source, ...item.sources.filter((old) => old.name !== source.name)], verdict: 'pending', conf: null, issue: null, diff: null, checks: {}, reason: '关联了候选依据，等待核验原文与适用性。' } });
    dispatch({ type: 'SELECT', id: item.id });
  };
  const applyMcp = (entry, result, operation) => {
    const quote = [result.title, result.gist || result.text].filter(Boolean).join('。');
    const source = {
      st: entry.mode === 'mcp-statute' ? 'l2' : 'l3',
      name: result.title || result.case_number || result.law_name,
      loc: [result.article_number, result.court, result.judgment_date].filter(Boolean).join(' · ') || '检索命中',
      excerpt: result.gist || result.text || '',
      match: [],
      manual: false,
      mcp: result.source || entry.mode,
    };
    if (operation === 'insert') {
      const type = entry.mode === 'mcp-statute' ? 'E-LAW' : 'E-CASE';
      dispatch({ type: 'ADD_STATEMENT', after: current?.id, item: { id: 'MCP-' + Date.now(), type, quote, sources: [source], src: source.st, verdict: 'pending', conf: null, reason: '检索结果，待律师核对原文。' }, auditMsg: '助手检索引用 · ' + source.name });
    } else if (operation === 'patch' && current) {
      dispatch({ type: 'OP', id: current.id, action: 'ai', auditMsg: '助手 MCP 关联 · ' + source.name,
        patch: { src: source.st, sources: [source, ...current.sources], verdict: 'pending', conf: null, issue: null, diff: null, checks: {}, reason: '关联检索候选依据，等待核验原文。' } });
      dispatch({ type: 'SELECT', id: current.id });
    }
  };

  const apply = (entry, operation, source) => {
    const item = elById(state, entry.anchor);
    const quote = (source ? source.name + ' · ' + source.loc + (source.excerpt ? '。' + source.excerpt : '') : entry.draft).trim();
    if (!quote) return toast('草稿不能为空');
    const aiOrigin = entry.mode === 'edit' ? 'AI 协助修改，待核验' : 'AI 生成，待核验';
    if (entry.newDoc && !source) {
      dispatch({ type: 'CREATE_DRAFT', title: entry.docTitle, items: quote.split(/\r?\n/).filter((line) => line.trim()).map((line) => {
        const item = entry.exampleFacts.find((fact) => fact.quote === line);
        const sources = item?.sources || [];
        return { quote: line, type: item?.type || 'E-FACT', src: sources[0]?.st || 'l0', sources, audit: [], aiOrigin,
          reason: '草稿内容待律师核验。' };
      }) });
      finish(entry);
      return;
    }
    const sources = source ? [source] : entry.sources;
    const changes = { aiOrigin, sources, src: sources[0]?.st || 'l0', verdict: 'pending', issue: null, diff: null, conf: null, checks: {},
      reason: '候选依据待逐项核对，当前内容尚未通过核验。' };
    if (operation === 'replace') {
      if (!item || !entry.canReplace || item.quote.trim() !== entry.anchorQuote) return toast('原文已变化，请重新选中后改写');
      dispatch({ type: 'OP', id: item.id, action: 'ai', quote, patch: changes, auditMsg: '助手修改 · 接受并替换声明' });
    } else {
      const type = source ? { l1: 'E-FACT', l2: 'E-LAW', l3: 'E-CASE' }[source.st] : entry.type;
      dispatch({ type: 'ADD_STATEMENT', after: item?.id, item: { id: 'AI-' + Date.now(), type, quote, ...changes }, auditMsg: '助手草稿 · 插入待核验声明' });
    }
    if (!source) finish(entry);
  };

  if (!state.assistantOpen) return null;

  const lockedTool = ASSISTANT_TOOLS.find((item) => item.id === tool);
  const moreSkills = ASSISTANT_SKILLS.filter((skill) =>
    !MODE_CARDS.some((card) => card.id === skill.id));
  const useSkill = (skill) => {
    setMoreOpen(false);
    if (skill.tool === 'legal_statute') setTool('statute-mcp');
    else if (skill.id === 'case-report') setTool('case-report');
    else if (skill.tool === 'legal_case') setTool('case-mcp');
    else if (['draft', 'rewrite', 'inbox-search'].includes(skill.id)) setTool(skill.id);
    else setTool('auto');
    setPrompt(skill.starters[0]);
    inputRef.current?.focus();
  };
  const toggleMode = (id) => {
    if (tool === id) {
      setTool('auto');
      return;
    }
    setTool(id);
    if (!prompt.trim()) setPrompt(MODE_CARDS.find((card) => card.id === id)?.starter || '');
    inputRef.current?.focus();
  };

  const modeName = lockedTool?.name || '自动';

  return <section
    className={'assistant-panel' + (expanded ? ' assistant-wide' : '') + (busy ? ' is-busy' : '')}
    data-tool={tool}
    aria-label="AI 质证助手"
  >
    <header className="assistant-head">
      <div className="assistant-brand">
        <LawLogo style={{ width: 34, height: 34, borderRadius: 10, flexShrink: 0 }} />
        <div className="assistant-id">
          <b>AI 助手</b>
        </div>
      </div>
      <div className="assistant-head-ops">
        <button className="icon-op" onClick={toggleExpand} aria-pressed={expanded} title={expanded ? '还原宽度' : '加宽'}>
          {expanded ? '⇤' : '⤢'}
        </button>
        <button className="icon-op" onClick={close} title="收起 · Esc">✕</button>
      </div>
    </header>

    <div className="assistant-modes" role="toolbar" aria-label="助手能力">
      {MODE_CARDS.map((card) => (
        <button key={card.id} className={'mode-card' + (tool === card.id ? ' on' : '')}
          title={card.desc} aria-pressed={tool === card.id} onClick={() => toggleMode(card.id)}>
          <span className="mc-ico" aria-hidden="true">{card.icon}</span>
          <b>{card.name}</b>
          <small>{card.desc}</small>
        </button>
      ))}
      <div className="assistant-more">
        <button className={'icon-op' + (moreOpen ? ' on' : '')} aria-haspopup="menu" aria-expanded={moreOpen}
          title="更多技能包" onClick={() => setMoreOpen((value) => !value)}>⋯</button>
        {moreOpen && <div className="assistant-more-pop" role="menu" aria-label="更多技能包">
          {moreSkills.map((skill) => (
            <button key={skill.id} role="menuitem" title={skill.desc} onClick={() => useSkill(skill)}>
              <span aria-hidden="true">{skill.icon}</span>{skill.name}
              <small>{skill.group}</small>
            </button>
          ))}
        </div>}
      </div>
    </div>

    <div className="assistant-scroll" ref={scrollRef} role="log" aria-label="对话记录">
      {!history.length && <div className="assistant-hello">
        <h3>{selection ? '这段文字，想怎么处理？' : '需要我做什么？'}</h3>
        <p>{selection ? '选中文段已附在输入框上方；点「更多」可改写润色，或直接描述。' : '点上方能力锁定模式，再点一次取消；也可以直接说。'}</p>
        {record.stance && <p className="assistant-stance-hint">当前立场 · {record.stance.slice(0, 72)}{record.stance.length > 72 ? '…' : ''}</p>}
      </div>}
      {history.map((entry) => <div className="assistant-turn" key={entry.id}>
        <p className="assistant-message">{entry.query}</p>
        <div className="assistant-response">
          <b className="assistant-response-title" title={entry.position && !entry.newDoc ? entry.position : undefined}>
            {({
              search: '卷内材料',
              edit: '改写建议',
              draft: entry.newDoc ? entry.docTitle : '补写建议',
              'mcp-statute': '法条检索',
              'mcp-case': '案例检索',
              'case-report': '案例检索报告',
            })[entry.mode] || 'AI 助手'}
          </b>
          {entry.status === 'calling' && <p className="assistant-calling"><span className="spin" aria-hidden="true" /> 正在调用 {entry.mode === 'mcp-case' ? '案例库' : entry.mode === 'mcp-statute' ? '法条库' : '生成器'}…</p>}
          {entry.message && <p>{entry.message}</p>}
          {entry.context && (entry.context.summary || entry.context.focus || entry.context.stance || (entry.context.notes?.length > 0)) && <details className="assistant-memory-context" open={entry.context.usedStance}>
            <summary>参考的案件记忆</summary>
            {entry.context.stance && <p>代理立场 · {entry.context.stance}</p>}
            {entry.context.summary && <p>案情摘要 · {entry.context.summary}</p>}
            {entry.context.focus && <p>相关争点 · {entry.context.focus}</p>}
            {(entry.context.notes || []).map((line, index) => <p key={index}>律师笔记 · {line}</p>)}
          </details>}
          {entry.mcp && <McpResult entry={entry} state={state} dispatch={dispatch} onApply={applyMcp} openSource={openSource} />}
          {entry.mode === 'edit' && <div className="assistant-diff"><div><small>原文</small><del>{entry.original}</del></div><div><small>建议修改文</small><strong>{entry.draft}</strong></div></div>}
          {entry.mode === 'draft' && <p className="draft-preview">{entry.draft}</p>}
          {entry.mode === 'edit' && <p className="review-meta">修改理由 · {entry.verifiedText ? '按示例出处修正声明。' : '调整用词，事实与依据需重新核验。'}</p>}
          {entry.mode === 'search' && /法条|判例|类案/.test(entry.query) && <p className="review-meta">已自动路由到法条 / 案例检索；如需强制直连，请点上方能力。</p>}
          {entry.mode === 'search' && !entry.sources?.length && <p>卷内未找到匹配材料。可切换「法条」或「案例」。</p>}
          {entry.mode !== 'search' && !!entry.sources?.length && <details className="assistant-memory-context">
            <summary>候选依据（{entry.sources.length}）</summary>
            {entry.sources.map((source) => <button className="btn-txt" key={source.name + source.loc} onClick={() => openSource(dispatch, source)}>{source.name} · {source.loc}</button>)}
          </details>}
          {entry.mode === 'search' && (entry.sources || []).map((source) => <div className="assistant-result" key={source.name + source.loc}>
            <b><span className={`src-dot ${source.st}`} /> {source.name}</b><small>{source.loc}</small>
            <p>{source.excerpt || '暂无原文摘录'}</p>
            <button className="op" onClick={() => openSource(dispatch, source)}>打开原文</button>
            {project.docs.includes(state.doc) && <>
              <button className="op" onClick={() => apply(entry, 'insert', source)}>引用到正文</button>
              <button className="op" disabled={!entry.anchor || !source.excerpt} onClick={() => patch(entry, source)}>关联当前声明</button>
            </>}
          </div>)}
          {entry.mode && ['edit', 'draft'].includes(entry.mode) && !entry.finished && <>
            {editing === entry.id && <textarea aria-label="编辑草稿" value={entry.draft}
              onChange={(event) => setHistory(history.map((x) => x.id === entry.id ? { ...x, draft: event.target.value } : x))} />}
            <div className="ops">
              {(entry.newDoc || !entry.canReplace || entry.mode !== 'edit') && <button className="op pri" onClick={() => apply(entry, 'insert')}>{entry.newDoc ? '创建草稿文书' : entry.anchor ? '插入到声明后' : '插入到文末'}</button>}
              {entry.canReplace && <button className="op pri" onClick={() => apply(entry, 'replace')}>{entry.mode === 'edit' ? '接受修改' : '替换当前声明'}</button>}
              <button className="op" onClick={() => setEditing(editing === entry.id ? null : entry.id)}>手动编辑</button>
              <button className="op" onClick={() => {
                dispatch({ type: 'ASSISTANT_AUDIT', id: entry.anchor, message: entry.mode === 'edit' ? '拒绝助手修改建议' : '放弃助手草稿' });
                finish(entry);
              }}>{entry.mode === 'edit' ? '拒绝修改' : '放弃草稿'}</button>
            </div>
          </>}
        </div>
      </div>)}
    </div>

    <form className="assistant-composer" onSubmit={submit}>
      {selectedText && <div className="assistant-selection">
        <span className="att-ico" aria-hidden="true">📎</span>
        <small>{selection.position || '选中文段'}</small>
        <span className="att-text" title={selectedText}>{selectedText}</span>
        <button className="att-x" type="button" aria-label="移除选中文段" onClick={() => dispatch({ type: 'ASSISTANT', open: true })}>×</button>
      </div>}
      <AutoTextarea
        inputRef={inputRef}
        ariaLabel="向 AI 助手提问"
        placeholder={tool === 'statute-mcp' ? '描述要查的法条、效力或请求权基础…'
          : tool === 'case-mcp' ? '描述案情、案号或要检索的类案…'
          : tool === 'draft' ? '描述要起草的文书与要点…'
          : tool === 'case-report' ? '回车即生成本文书关联案例的检索报告'
          : selection ? '描述你想怎么处理这段文字…'
          : '描述你想起草、查找或核验的内容…'}
        value={prompt}
        onChange={setPrompt}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return;
          event.preventDefault();
          if (prompt.trim() || tool === 'case-report') event.currentTarget.form.requestSubmit();
        }}
      />
      <div className="assistant-composer-footer">
        <small className="composer-hint">
          <b>{tool === 'auto' ? '自动路由' : modeName}</b>
          <kbd>Enter</kbd> 发送
          <kbd>Shift Enter</kbd> 换行
        </small>
        <button className="send-fab" disabled={(!prompt.trim() && tool !== 'case-report') || busy} aria-label={busy ? '处理中' : '发送'}>
          {busy ? <span className="spin" aria-hidden="true" /> : '↑'}
        </button>
      </div>
    </form>
  </section>;
}

function McpResult({ entry, state, dispatch, onApply, openSource }) {
  const res = entry.mcp;
  if (!res) return null;
  const toolLabel = res.tool === 'legal_statute' ? '法条库' : '案例库';
  if (!res.results?.length) {
    return <div className="assistant-result">
      <b>{toolLabel} · 未命中</b>
      <p>演示库未收录。生产环境将实时检索权威库；缺源不编造，不用相似出处补位。</p>
      <small className="review-meta">{res.note}</small>
    </div>;
  }
  return <div className="assistant-mcp-list">
    <p className="review-meta">{toolLabel} · {res.action} · {res.latency}ms · {res.results.length} 条</p>
    {res.results.map((result) => <div className="assistant-result" key={result.id || result.title}>
      <b>{result.title || result.case_number}</b>
      <small>{[result.law_name, result.article_number, result.validity, result.court, result.judgment_date, result.level].filter(Boolean).join(' · ')}</small>
      <p>{result.gist || result.text}</p>
      <div className="ops">
        <button className="op" onClick={() => openSource(dispatch, { st: entry.mode === 'mcp-statute' ? 'l2' : 'l3', name: result.title, loc: result.article_number || result.court || '', excerpt: result.gist || result.text })}>预览</button>
        <button className="op" onClick={() => onApply(entry, result, 'insert')}>引用到正文</button>
        <button className="op" onClick={() => onApply(entry, result, 'patch')}>关联当前声明</button>
      </div>
    </div>)}
  </div>;
}
