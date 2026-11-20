import SearchSelect from './SearchSelect.jsx';
import React, { useEffect, useRef, useState } from 'react';
import JSZip from 'jszip';
import { useApp } from '../store/AppStore.jsx';
import { ALL_DOCS } from '../data/cases.js';
import { pdfFileUrl } from '../utils/pdfFile.js';

const wordNs = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const fileId = () => globalThis.crypto?.randomUUID?.() || Date.now() + '-' + Math.random().toString(36).slice(2);
const textType = (file) => /\.(txt|md|csv)$/i.test(file.name);

async function paragraphs(file) {
  if (textType(file)) return (await file.text()).split(/\r?\n/).map((line) => ({ text: line }));
  const zip = await JSZip.loadAsync(file);
  const raw = await zip.file('word/document.xml')?.async('string');
  if (!raw) throw new Error('未找到 Word 正文');
  const xml = new DOMParser().parseFromString(raw, 'application/xml');
  const body = xml.getElementsByTagNameNS(wordNs, 'body')[0];
  if (!body) throw new Error('无法读取 Word 正文');
  const find = (node, name) => [...node.getElementsByTagNameNS(wordNs, name)];
  const value = (node) => find(node, 't').map((entry) => entry.textContent).join('');
  return [...body.children].flatMap((node) => {
    if (node.localName === 'p') return [{ text: value(node), style: find(node, 'pStyle')[0]?.getAttributeNS(wordNs, 'val') }];
    if (node.localName === 'tbl') return [{ rows: find(node, 'tr').map((row) =>
      [...row.children].filter((cell) => cell.localName === 'tc').map((cell) => value(cell))) }];
    return [];
  });
}

const businessTypes = [
  ['合同协议', /合同|协议|技术标准/], ['资金往来', /流水|转账|回单|付款/],
  ['沟通记录', /微信|聊天|邮件|函件|催款/], ['身份主体', /营业执照|身份证|户籍|授权/],
  ['前审文书', /判决|裁定|起诉状|答辩状/],
];

function statement(text, docType) {
  let type = docType === 'zj' ? 'E-EVID' : docType === 'zz' ? 'E-CROSS' : 'E-FACT';
  if (/[（(]\d{4}[）)].{2,24}号/.test(text)) type = 'E-CASE';
  else if (/《[^》]+》\s*第[^，。； ]+条/.test(text)) type = 'E-LAW';
  else if (/^[原被]告[:：]/.test(text)) type = 'E-SUBJ';
  else if (/请求|判令/.test(text)) type = 'E-CLAIM';
  return { id: 'upload-' + fileId(), type, src: 'l0', verdict: 'pending', conf: null, sources: [], audit: [], quote: text, reason: '导入的声明等待核验与关联出处。' };
}

function UploadForm({ toast }) {
  const { state, dispatch } = useApp();
  const { upload } = state;
  const [files, setFiles] = useState([]);
  const [file, setFile] = useState(null);
  const [type, setType] = useState('qs');
  const [subtype, setSubtype] = useState('管辖权异议书');
  const [busy, setBusy] = useState(false);
  const cancelled = useRef(false);
  useEffect(() => {
    cancelled.current = false;
    return () => { cancelled.current = true; };
  }, []);
  const project = state.projects.find((c) => c.id === upload.caseId);
  const newCase = !!upload.draft;
  const draftOnly = upload.mode === 'draft';
  const ready = newCase ? files.length > 0 && (draftOnly || !!file) : files.length > 0 || !!file;
  const close = () => dispatch({ type: 'CLOSE_UPLOAD' });
  if (!project && !newCase) return null;
  const choose = (event, doc) => {
    event.preventDefault();
    const selected = [...(event.dataTransfer?.files || event.target.files || [])];
    if (doc) setFile(selected[0] || null);
    else setFiles(selected);
  };
  const save = async () => {
    if (!ready || busy) return;
    setBusy(true);
    try {
      let doc;
      if (file) {
        if (!textType(file) && !/\.docx$/i.test(file.name)) throw new Error('核验文书支持 DOCX 和纯文本');
        const items = [];
        const add = (text) => {
          if (!text.trim()) return null;
          const item = statement(text, type);
          items.push(item);
          return item.id;
        };
        const blocks = (await paragraphs(file)).map((block) => block.rows
          ? { rows: block.rows.map((row) => row.map((text) => ({ text, id: add(text) }))) }
          : { ...block, id: /^(Title|Heading[1-9])$/i.test(block.style || '') ? null : add(block.text) });
        if (!items.length) throw new Error('文书没有可核验的文本');
        const name = file.name.replace(/\.[^.]+$/, '');
        doc = { key: type + '-' + fileId(), type, name: (type === 'cx' ? subtype : Object.fromEntries(ALL_DOCS)[type]) + ' · ' + name, items, blocks };
      }
      const parsed = await Promise.all(files.map(async (entry) => {
        const t = entry.type === 'application/pdf' || /\.pdf$/i.test(entry.name) ? 'pdf' : entry.type.startsWith('image/') ? 'img' : 'doc';
        const text = textType(entry) ? await entry.text() : /\.docx$/i.test(entry.name) ? (await paragraphs(entry)).map((block) => block.text || block.rows.map((row) => row.join(' ｜ ')).join('\n')).join('\n') : '';
        return { entry, t, text };
      }));
      if (cancelled.current) return;
      const materials = parsed.map(({ entry, t, text }) => (
        { id: 'm-' + fileId(), g: businessTypes.find(([, pattern]) => pattern.test(entry.name))?.[0] || '其他材料', n: entry.name, t, text,
          sub: text ? '文本层可检索' : '本地原件', url: t === 'pdf' ? pdfFileUrl(entry) : URL.createObjectURL(entry), submit: true,
          ...( /电子合同/.test(entry.name) ? { signature: '数字签名待核验' } : {}) }
      ));
      if (newCase) dispatch({ type: 'CREATE_CASE', materials, doc, draft: upload.draft });
      else {
        dispatch({ type: 'UPLOAD_FILES', caseId: project.id, materials, doc });
        toast(doc ? '文书已导入，声明进入待核验' : '原材料已导入');
      }
    } catch (error) { if (!cancelled.current) toast('导入失败 · ' + error.message); }
    finally { setBusy(false); }
  };
  return <div className="upov show">
    <div className={'up-box' + (draftOnly ? ' draft-upload' : '')} role="dialog" aria-modal="true" aria-labelledby="upload-title">
      <div className="up-h"><b id="upload-title">{newCase ? (draftOnly ? 'AI 起草新文书' : 'AI 核验文书') : '导入到「' + project.name + '」'}</b>
        <button className="btn-txt" onClick={close}>{newCase ? '返回上一步' : '关闭'}</button>
      </div>
      {newCase && <p className="upload-guide">{draftOnly
        ? '上传合同、流水、沟通记录等案件原材料，作为起草参考。'
        : '上传案件原材料和一份待核验文书，系统将用材料核对文书中的声明。'}</p>}
      <div className="up-grid">
        <div className="drop" onDragOver={(e) => e.preventDefault()} onDrop={(e) => choose(e, false)}>
          <div className="drop-h"><span className="drop-tag mat">案件原材料{newCase ? ' · 必传' : ' L1'}</span><span>{files.length} 份</span></div>
          <label className="dz"><b>拖拽或选择原材料</b><input type="file" multiple aria-label="选择原材料" onChange={(e) => choose(e, false)} /></label>
          {files.map((entry, i) => <div className="chip" key={i}>{entry.name}</div>)}
        </div>
        {!draftOnly && <div className="drop" onDragOver={(e) => e.preventDefault()} onDrop={(e) => choose(e, true)}>
          <div className="drop-h"><span className="drop-tag doc">待核验文书{newCase && ' · 必传'}</span><span>DOCX / TXT</span></div>
          <label className="dz"><b>拖拽或选择文书</b><input type="file" accept=".docx,.txt,.md" aria-label="选择待核验文书" onChange={(e) => choose(e, true)} /></label>
          <SearchSelect label="文书类型" value={type} onChange={setType}
            options={ALL_DOCS.map(([value, label]) => ({ value, label }))} />
          {type === 'cx' && <SearchSelect label="程序文书类型" value={subtype} onChange={setSubtype}
            options={['管辖权异议书', '财产保全申请书', '调查取证申请书'].map((label) => ({ value: label, label }))} />}
          {file && <div className="chip">{file.name}</div>}
        </div>}
      </div>
      <div className="fm-ft"><button className="btn btn-pri" disabled={busy || !ready} onClick={save}>
        {busy ? '导入中' : newCase ? (draftOnly ? '创建并进入起草' : '创建并开始核验') : '导入到工作台'}
      </button></div>
    </div>
  </div>;
}

export default function UploadModal({ toast }) {
  const { state } = useApp();
  return state.upload.open ? <UploadForm toast={toast} /> : null;
}
