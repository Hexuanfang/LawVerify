import React, { createContext, useContext, useReducer, useCallback } from 'react';
import { evaluateEdit, isRed } from '../utils/review.js';
import { ALL_DOCS, CASES } from '../data/cases';
import { loadCaseNotes, saveCaseNotes } from '../data/memory.js';

/* ---------- 展示常量 ---------- */
export const STN = { pass: '绿·通过', warn: '黄·预警', fail: '红·不通过', miss: '红·缺源', note: '通过·标注', pending: '待核验' };
export const STC = {
  pass: 'var(--st-ok)', warn: 'var(--st-warn)', fail: 'var(--st-bad)',
  miss: 'var(--st-bad)', note: 'var(--st-note)', pending: '#718570',
};
export const SRCN = { l1: '案件原材料', l2: '法条', l3: '案例', l0: '未联动' };
export const TODO_TONE = {
  fail: { label: '必须处理', weight: 0 },
  miss: { label: '必须处理', weight: 0 },
  pending: { label: '待核验', weight: 1 },
  warn: { label: '建议复核', weight: 2 },
  note: { label: '通过·标注', weight: 3 },
  pass: { label: '已通过', weight: 4 },
};

const now = () => new Date().toLocaleString('zh-CN', { hour12: false });
const audit = (state, message) => ({ t: now(), actor: state.accountName, msg: message });

/* ---------- 选择器 ---------- */
function applyUser(s, e) {
  const u = s.userOps[e.id];
  if (!u) return e;
  const out = { ...e, ...(u.patch || {}) };
  out.user = u.action;
  out.confirmed = u.confirmed;
  out.ignored = u.ignored;
  out.note = (u.note ?? e.note) || '';
  out.audit = [...(e.audit || []), ...(u.audit || [])];
  if (u.quote !== undefined) out.quote = u.quote;
  return out;
}
export function selCase(s) {
  return s.projects.find((c) => c.id === s.caseId) || s.projects[0];
}
export function selEls(s) {
  const c = selCase(s);
  const items = (c.els?.[s.doc] || []).map((e) => applyUser(s, e)).filter((e) => !e.deleted);
  const byId = new Map(items.map((item) => [item.id, item]));
  return items.map((item) => {
    const from = item.dependsOn && byId.get(item.dependsOn.id);
    if (!item.dependsOn || (from && !isRed(from) && from.verdict !== 'pending')) return item;
    const { id, code, reason, warn, label } = item.dependsOn;
    const verdict = warn && !isRed(item) && item.verdict !== 'pending' ? 'warn' : 'fail';
    return { ...item, verdict, issue: verdict === 'fail' ? '错配' : null, impact: { from: id, reason, label, detached: !from }, checks: { ...item.checks, [code]: verdict === 'warn' ? '预警' : '不通过' } };
  });
}
export function elById(s, id) {
  return selEls(s).find((e) => e.id === id);
}
/* 不含 dependsOn 级联的补丁视图：用于文书标签徽标与左栏关联依据 */
export function patchedDocEls(s, doc) {
  const c = selCase(s);
  return (c.els?.[doc] || []).map((e) => {
    const u = s.userOps[e.id];
    if (!u) return e;
    const out = { ...e, ...(u.patch || {}) };
    out.user = u.action;
    out.confirmed = u.confirmed;
    out.ignored = u.ignored;
    out.note = (u.note ?? e.note) || '';
    if (u.quote !== undefined) out.quote = u.quote;
    return out;
  }).filter((e) => !e.deleted);
}
export function verdictCounts(els) {
  const c = { all: els.length, pass: 0, warn: 0, fail: 0, note: 0, pending: 0 };
  els.forEach((e) => {
    c[isRed(e) ? 'fail' : e.verdict]++;
  });
  return c;
}

/* ---------- 初始状态 ---------- */
const initial = {
  accountName: '沈律师',
  accountEmail: 'shenlawyer@lawverify.cn',
  accountFirm: '',
  accountCredits: 2860,
  auditLog: [],
  memoryNotes: {},
  memorySaved: null,
  assistantOpen: false,
  assistantTool: 'auto',
  assistantExpanded: false,
  editMode: false,
  dirty: {},   // elId -> true 已编辑待重核
  selection: null,
  panelExpanded: false,
  checkedAt: {},
  page: 'home', // home | proc | ws | report | lib
  caseId: null,
  doc: 'qs',
  filter: 'all',
  sel: null,
  coach: true,
  caseMenuOpen: false,
  leftOpen: true,
  rightOpen: true,
  userOps: {},
  edits: {},   // elId -> 修改后的声明文本（正文高亮同步）
  projects: CASES,
  upload: { open: false, caseId: null },
  form: { open: false },
  drawer: { open: false, variant: null, name: '', sub: '' },
  tip: { on: false, elId: null, rect: null },
  toast: { msg: '', key: 0 },
  proc: { step: -1, pct: 0, metas: {}, done: false },
};

/* ---------- Reducer ---------- */
function memoryProject({ id, name, court, no, cause, parties, date, plaintiff, defendant, ourSide }) {
  return { id, name, court, no, cause, parties, date, plaintiff, defendant, ourSide };
}

function restoreInitial(base) {
  const memoryNotes = loadCaseNotes();
  const exampleIds = new Set(base.projects.map((project) => project.id));
  const savedProjects = Object.values(memoryNotes).flatMap((record) => {
    const project = record?.project;
    return project?.id && !exampleIds.has(project.id) ? [{ ...project, mats: [], els: {}, docs: [], docNames: Object.fromEntries(ALL_DOCS) }] : [];
  });
  let accountName = base.accountName;
  let accountFirm = base.accountFirm || '';
  try {
    accountName = window.localStorage.getItem('lawverify.account-name') || accountName;
    accountFirm = window.localStorage.getItem('lawverify.account-firm') ?? accountFirm;
  } catch {}
  const examples = base.projects.map((project) => ({ ...project, ...memoryNotes[project.id]?.project }));
  return { ...base, accountName, accountFirm, memoryNotes, projects: [...examples, ...savedProjects] };
}

function reducer(s, a) {
  switch (a.type) {
    case 'SAVE_MEMORY': {
      if (a.caseId !== s.caseId) return s;
      return { ...s, memoryNotes: { ...s.memoryNotes, [a.caseId]: { ...a.record, project: memoryProject(selCase(s)) } } };
    }
    case 'MEMORY_STORAGE_STATUS':
      return s.memorySaved === a.saved ? s : { ...s, memorySaved: a.saved };
    case 'SET_ACCOUNT_NAME':
      return { ...s, accountName: a.name };
    case 'SET_ACCOUNT_FIRM':
      return { ...s, accountFirm: a.firm };
    case 'ASSISTANT':
      return {
        ...s,
        assistantOpen: a.open,
        assistantTool: a.tool || (a.open ? s.assistantTool : 'auto'),
        assistantExpanded: a.expanded != null ? a.expanded : s.assistantExpanded,
        selection: a.open ? (a.selection ?? null) : null,
      };
    case 'ASSISTANT_TOOL':
      return { ...s, assistantTool: a.tool };
    case 'ASSISTANT_EXPAND':
      return { ...s, assistantExpanded: !s.assistantExpanded, rightOpen: !s.assistantExpanded ? false : s.rightOpen };
    case 'SET_EDIT_MODE':
      return { ...s, editMode: !!a.on, sel: a.on ? null : s.sel };
    case 'MARK_DIRTY':
      return { ...s, dirty: { ...s.dirty, [a.id]: true } };
    case 'REVERIFY': {
      const ids = a.ids || (a.scope === 'all'
        ? selEls(s).map((item) => item.id)
        : [a.id].filter(Boolean));
      if (!ids.length) return s;
      const ops = { ...s.userOps };
      const dirty = { ...s.dirty };
      const touched = [];
      ids.forEach((id) => {
        const item = elById(s, id);
        if (!item) return;
        const text = s.edits[id] ?? item.quote;
        const result = evaluateEdit(item, text);
        // 全文重核不漂移已人工确认项
        if (a.scope === 'all' && item.confirmed && !s.dirty[id] && item.verdict !== 'pending') return;
        ops[id] = {
          ...(ops[id] || {}),
          action: ops[id]?.action || 'reverify',
          patch: { ...(ops[id]?.patch || {}), ...result },
          audit: [...(ops[id]?.audit || []), audit(s, (a.scope === 'all' ? '全文重核' : '局部重核') + ' · ' + (result.verdict === 'pending' ? '待核验' : STN[result.verdict] || result.verdict))],
        };
        delete dirty[id];
        touched.push(id);
      });
      if (!touched.length) return s;
      return {
        ...s, userOps: ops, dirty,
        auditLog: [...s.auditLog, ...touched.map((id) => ({ ...audit(s, (a.scope === 'all' ? '全文重核' : '局部重核') + ' · ' + id), caseId: s.caseId, doc: s.doc, id }))],
        checkedAt: a.scope === 'all' ? { ...s.checkedAt, [s.caseId + '/' + s.doc]: now() } : s.checkedAt,
      };
    }
    case 'EXPAND_PANEL':
      return { ...s, panelExpanded: !s.panelExpanded, rightOpen: true };
    case 'NAV':
      return { ...s, page: a.page };

    case 'TOAST':
      return { ...s, toast: { msg: a.msg, key: s.toast.key + 1 } };

    case 'ENTER_CASE': {
      const c = s.projects.find((x) => x.id === a.id) || s.projects[0];
      const doc = (a.doc && c.docs && c.docs.includes(a.doc)) ? a.doc : (c.docs && c.docs[0]) || 'qs';
      return { ...s, caseId: c.id, doc, filter: 'all', sel: null, caseMenuOpen: false, page: 'ws', selection: null, assistantOpen: false, panelExpanded: false, editMode: false, dirty: {} };
    }
    case 'SET_DOC':
      return { ...s, doc: a.doc, sel: null, filter: 'all', selection: null, assistantOpen: false, editMode: false, dirty: {} };
    case 'SET_FILTER':
      return { ...s, filter: a.f };
    case 'SELECT':
      return { ...s, sel: a.id, rightOpen: true, selection: a.keepAssistantSelection ? s.selection : null };
    case 'SET_EDIT':
      return {
        ...s,
        edits: { ...s.edits, [a.id]: a.text },
        dirty: { ...s.dirty, [a.id]: true },
        userOps: {
          ...s.userOps,
          [a.id]: {
            ...(s.userOps[a.id] || {}),
            patch: { ...(s.userOps[a.id]?.patch || {}), verdict: 'pending', conf: null, issue: null, diff: null, checks: {}, reason: '正文已修改，等待重核。' },
          },
        },
      };
    case 'CASE_MENU':
      return { ...s, caseMenuOpen: !s.caseMenuOpen };
    case 'COACH_OFF':
      return { ...s, coach: false };
    case 'TOGGLE_PANE':
      return a.side === 'l' ? { ...s, leftOpen: !s.leftOpen } : { ...s, rightOpen: !s.rightOpen, panelExpanded: false };

    /* 人工闭环操作 */
    case 'OP': {
      const item = elById(s, a.id);
      if (!item) return s;
      if (a.action === 'confirm' && (isRed(item) || item.verdict === 'pending')) return s;
      if (a.action === 'verify' && (item.verdict !== 'pending' || !item.sources.some((source) => source.excerpt?.trim() && source.loc?.trim() && source.loc !== '材料目录'))) return s;
      if (a.action === 'ignore' && item.verdict !== 'warn') return s;
      const u = s.userOps[a.id] || {};
      const entry = audit(s, a.auditMsg);
      const nu = { ...u, ...(a.closeFlags || {}), action: a.action, audit: [...(u.audit || []), entry] };
      nu.confirmed = ['confirm', 'verify'].includes(a.action) || (u.confirmed && ['note', 'flag'].includes(a.action));
      nu.ignored = a.action === 'ignore' || (u.ignored && ['note', 'flag', 'confirm'].includes(a.action));
      nu.patch = { ...u.patch, ...a.patch };
      if (a.quote !== undefined) nu.quote = a.quote;
      if (a.note !== undefined) nu.note = a.note;
      const edits = a.quote === undefined ? s.edits : { ...s.edits, [a.id]: a.quote };
      return { ...s, edits, userOps: { ...s.userOps, [a.id]: nu }, auditLog: [...s.auditLog, { ...entry, caseId: s.caseId, doc: s.doc, id: item.id }] };
    }
    case 'ASSISTANT_AUDIT': {
      const entry = audit(s, a.message);
      return { ...s, auditLog: [...s.auditLog, { ...entry, caseId: s.caseId, doc: s.doc, id: a.id }] };
    }
    case 'CREATE_DRAFT': {
      if (!a.items.length) return s;
      const c = selCase(s);
      const doc = 'draft-' + Date.now();
      const items = a.items.map((item, i) => ({
        ...item, id: doc + '-' + (i + 1), verdict: 'pending', conf: null,
      }));
      const project = { ...c, docs: [...c.docs, doc], docNames: { ...c.docNames, [doc]: a.title },
        els: { ...c.els, [doc]: items }, fileDocs: { ...c.fileDocs, [doc]: [] } };
      return { ...s, projects: s.projects.map((p) => p.id === c.id ? project : p),
        caseId: c.id, doc, sel: items[0].id, assistantOpen: false, selection: null,
        auditLog: [...s.auditLog, { ...audit(s, '助手生成文书草稿 · 待核验'), caseId: c.id, doc }] };
    }
    case 'ADD_STATEMENT': {
      const c = selCase(s);
      const anchor = a.after && elById(s, a.after);
      const item = { audit: [audit(s, a.auditMsg)], ...a.item, after: anchor?.after || anchor?.id || null, verdict: 'pending', conf: null };
      const els = { ...c.els, [s.doc]: [...(c.els?.[s.doc] || []), item] };
      const entry = audit(s, a.auditMsg);
      return { ...s, projects: s.projects.map((p) => p.id === c.id ? { ...p, els } : p), sel: item.id, selection: null, filter: 'all', rightOpen: true,
        auditLog: [...s.auditLog, { ...entry, caseId: s.caseId, doc: s.doc, id: item.id }] };
    }
    /* 上传 → 核验 */
    case 'OPEN_UPLOAD':
      return { ...s, upload: { open: true, caseId: a.caseId || s.caseId || s.projects[0].id } };
    case 'PREPARE_CASE_UPLOAD':
      return { ...s, upload: { open: true, mode: a.mode, draft: a.draft } };
    case 'CLOSE_UPLOAD':
      return { ...s, upload: { open: false } };
    case 'UPLOAD_FILES': {
      const c = s.projects.find((p) => p.id === a.caseId);
      if (!c) return s;
      const doc = a.doc?.key || (c.id === s.caseId ? s.doc : c.docs[0]) || 'qs';
      const projects = s.projects.map((p) => p.id !== c.id ? p : {
        ...p, mats: [...p.mats, ...a.materials],
        ...(a.doc ? { docs: [...p.docs, doc], docNames: { ...p.docNames, [doc]: a.doc.name }, els: { ...p.els, [doc]: a.doc.items }, fileDocs: { ...p.fileDocs, [doc]: a.doc.blocks } } : {}),
      });
      return { ...s, projects, caseId: c.id, doc, page: 'ws', sel: null, filter: 'all', selection: null, assistantOpen: false, upload: { open: false } };
    }
    case 'START_PROC':
      return {
        ...s, page: 'proc', sel: null, filter: 'all',
        caseId: a.caseId || s.caseId,
        proc: { step: -1, pct: 0, metas: {}, done: false },
      };
    case 'PROC_TICK':
      return { ...s, proc: { ...s.proc, step: a.step, pct: a.pct, metas: { ...s.proc.metas, ...(a.meta || {}) } } };
    case 'PROC_DONE': {
      const ops = { ...s.userOps };
      for (const item of selEls(s)) {
        if (item.verdict !== 'pending' || !item.verifiedText) continue;
        const result = evaluateEdit(item, item.quote);
        ops[item.id] = { ...ops[item.id], patch: { ...ops[item.id]?.patch, ...result } };
      }
      return { ...s, page: 'ws', userOps: ops, checkedAt: { ...s.checkedAt, [s.caseId + '/' + s.doc]: now() }, proc: { ...s.proc, done: true } };
    }

    /* 预览抽屉 */
    case 'ATTACH_PDF': {
      const c = selCase(s);
      return { ...s, projects: s.projects.map((project) => project.id !== c.id ? project : {
        ...project, mats: project.mats.map((material) => material.id !== a.id ? material : { ...material, url: a.url }),
      }) };
    }
    case 'OPEN_DRAWER':
      return { ...s, drawer: { open: true, variant: a.variant, name: a.name, sub: a.sub, source: a.source, doc: a.doc, itemId: a.itemId } };
    case 'CLOSE_DRAWER':
      return { ...s, drawer: { ...s.drawer, open: false } };

    /* 悬浮提示 */
    case 'TIP_SHOW':
      return { ...s, tip: { on: true, elId: a.id, rect: a.rect } };
    case 'TIP_MOVE':
      return s.tip.on ? { ...s, tip: { ...s.tip, rect: a.rect } } : s;
    case 'TIP_HIDE':
      return s.tip.on ? { ...s, tip: { ...s.tip, on: false } } : s;

    case 'OPEN_FORM':
      return { ...s, form: { open: true, edit: a.edit } };
    case 'CLOSE_FORM':
      return { ...s, form: { open: false } };
    case 'SAVE_FORM': {
      if (!s.form.open || !s.form.edit || !a.values.name) return s;
      const project = { ...selCase(s), ...a.values };
      return {
          ...s, form: { open: false },
          projects: s.projects.map((entry) => entry.id === project.id ? project : entry),
          memoryNotes: { ...s.memoryNotes, [project.id]: { ...s.memoryNotes[project.id], project: memoryProject(project) } },
      };
    }
    case 'CREATE_CASE': {
      const { draft, mode } = s.upload;
      if (!draft || draft !== a.draft || !a.materials.length || (mode === 'verify' && !a.doc)) return s;
      const doc = a.doc;
      const nc = {
        ...draft.values, id: 'c' + Date.now(), date: new Date().toLocaleDateString('sv-SE'),
        mats: a.materials, els: {}, docs: [],
        docNames: Object.fromEntries(ALL_DOCS),
      };
      if (doc) {
        nc.docs = [doc.key];
        nc.docNames[doc.key] = doc.name;
        nc.els[doc.key] = doc.items;
        nc.fileDocs = { [doc.key]: doc.blocks };
      }
      const at = now();
      const record = {
        project: memoryProject(nc),
        stance: draft.stance || '',
        notes: draft.note ? [{ id: nc.id, text: draft.note, at }] : [],
        ...(draft.stance || draft.note ? { updatedAt: at } : {}),
      };
      return {
        ...s, form: { open: false }, upload: { open: false },
        projects: [nc, ...s.projects], memoryNotes: { ...s.memoryNotes, [nc.id]: record },
        caseId: nc.id, doc: doc?.key || 'qs', page: doc ? 'proc' : 'ws', sel: null, filter: 'all',
        proc: { step: -1, pct: 0, metas: {}, done: false },
        selection: null, assistantOpen: mode === 'draft', panelExpanded: false,
      };
    }
    default:
      return s;
  }
}

/* ---------- Provider & Hooks ---------- */
const Ctx = createContext(null);

export function StoreProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initial, restoreInitial);
  React.useEffect(() => {
    dispatch({ type: 'MEMORY_STORAGE_STATUS', saved: saveCaseNotes(state.memoryNotes) });
  }, [state.memoryNotes]);
  React.useEffect(() => {
    try { window.localStorage.setItem('lawverify.account-name', state.accountName); } catch {}
  }, [state.accountName]);
  React.useEffect(() => {
    try { window.localStorage.setItem('lawverify.account-firm', state.accountFirm); } catch {}
  }, [state.accountFirm]);
  const value = React.useMemo(() => ({ state, dispatch }), [state]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp() {
  return useContext(Ctx);
}

export function useToast() {
  const { dispatch } = useApp();
  return useCallback((msg) => dispatch({ type: 'TOAST', msg }), [dispatch]);
}
