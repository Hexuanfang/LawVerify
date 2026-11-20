import React from 'react';
import { LAW_LIB, CASE_LIB } from '../data/lib.js';
import { selCase, selEls, useApp } from '../store/AppStore.jsx';
import { ReadOnlyDocument } from '../features/documents/templates.jsx';
import { pdfFileUrl } from '../utils/pdfFile.js';

/* 预览抽屉正文：五种变体，与原型逐一对应 */
function Bank({ source }) {
  const payment = source?.loc?.includes('04-11');
  return (
    <div className="pv-stage">
      <div className="pv-paper">
        <div className="bank-h"><b>招商银行 · 交易流水单</b><span>户名：王某 ｜ 2023.03.01 - 2024.06.01</span></div>
        <table className="bank-t"><tbody>
          <tr><th>交易日期</th><th>摘要</th><th>支出</th><th>收入</th></tr>
          <tr className={!payment ? 'hit' : ''}><td>2023-03-15</td><td>借款</td><td>500,000.00</td><td>—</td></tr>
          <tr className={payment ? 'hit' : ''}><td>2023-04-11</td><td>利息</td><td>—</td><td>35,000.00</td></tr>
          <tr><td>2023-09-15</td><td>理财赎回</td><td>—</td><td>50,000.00</td></tr>
        </tbody></table>
      </div>
      <div className="cap"><i />命中：2023-03-15 转出 500,000 元（借款交付）</div>
      <div className="cap" style={{ borderTop: 'none' }}><i style={{ background: 'var(--st-bad)' }} />注意：4 月 11 日收入 35,000 元利息 —— 与文书“4 月 1 日 3 万”矛盾</div>
    </div>
  );
}

function Jietiao() {
  return (
    <div className="pv-stage">
      <div className="pv-paper">
        <div className="jt">
          <h3>借 条</h3>
          <p>今借到王某人民币<span className="hl">伍拾万元整</span>（¥500,000），<span className="hl">借期一年</span>，<span className="hl">年利率12%</span>，到期还本付息。</p>
          <p>借款人承诺按约归还，如有逾期愿承担相应责任。</p>
          <p style={{ textAlign: 'right', marginTop: 16 }}>借款人：李××　2023年3月15日</p>
        </div>
      </div>
      <div className="cap"><i />金额、期限、利率三处要素与文书一致</div>
    </div>
  );
}

function Wechat() {
  return (
    <div className="pv-stage">
      <div className="pv-paper">
        <div className="wc">
          <div className="wt">2024年3月20日 21:47</div>
          <div className="wm"><div className="wa" style={{ background: '#4B5563' }}>王</div><div className="wb">老李，借你的 50 万到期了，该还了。</div></div>
          <div className="wm r"><div className="wa" style={{ background: '#0D9488' }}>李</div><div className="wb"><span className="wc-hl">钱我认，再宽限两个月</span>，这段时间确实周转不开。</div></div>
          <div className="wm"><div className="wa" style={{ background: '#4B5563' }}>王</div><div className="wb">行，最晚 5 月 20 号。</div></div>
        </div>
      </div>
      <div className="cap"><i />命中消息已高亮 · 标注：截图未经公证</div>
    </div>
  );
}

function Law({ source, laws }) {
  const entries = laws.filter((law) => source.name.includes(law.name));
  const selected = entries.filter((law) => source.loc?.includes(law.art) || (law.id === 'L08' && source.loc?.includes('107')));
  const list = selected.length ? selected : source.loc ? [] : entries;
  return <div className="pv-stage"><div className="pv-paper statute">
    <h3>{source.name}</h3>
    {list.map((law) => <section key={law.id}>
      <h4>{law.art}</h4><p>{law.st} · {law.date} 施行 · {law.no}</p>
      <p className="hl">{law.text || law.gist}</p>
    </section>)}
    {source.excerpt && <blockquote>{source.excerpt}</blockquote>}
    {!list.length && !source.excerpt && <p>暂无可显示的条文。</p>}
  </div></div>;
}

function CasePv({ source, cases }) {
  if (!source.name.includes('京01民终1234号')) {
    const entry = cases.find((value) => source.name.includes(value.no));
    return <div className="pv-stage"><div className="pv-paper">
      <h3>{entry?.name || source.name}</h3>
      {entry && <p>{entry.no} · {entry.court} · {entry.date} · {entry.lv}</p>}
      <p>{source.excerpt || entry?.gist || '暂无原文摘录'}</p>
    </div></div>;
  }
  return (
    <div className="pv-stage">
      <div className="pv-paper">
        <div className="casepv">
          <div className="st-t">王某诉李某民间借贷纠纷</div>
          <div className="st-n">民事判决书</div>
          <div className="four">
            <div><b>案号</b><span>（2021）京01民终1234号</span></div>
            <div><b>审理法院</b><span>北京市第一中级人民法院</span></div>
            <div><b>裁判日期</b><span>2021-08-12</span></div>
            <div><b>效力层级</b><span>普通案例 · 参考</span></div>
          </div>
          <div className="csq">
            本院认为：出借人提交<mark>借条原件</mark>并出具<mark>银行转账凭证</mark>，被上诉人对签名真实性无异议，双方借贷关系<mark>成立</mark>。上诉人主张已部分偿还，但未提交相应凭证，本院不予采信。
          </div>
          <div className="pt"><div><span style={{ color: 'var(--c-l3)' }}>严格命中</span><span>案由相同 + 争点相同 + 关键事实匹配</span></div></div>
        </div>
      </div>
    </div>
  );
}

function Preview({ source, onAttachPdf }) {
  const [zoom, setZoom] = React.useState(100);
  const [fileError, setFileError] = React.useState('');
  const hitPage = Number(source.loc?.match(/第\s*(\d+)\s*页/)?.[1]);
  const [page, setPage] = React.useState(hitPage || 1);
  const image = source.t === 'img' || /\.(jpe?g|png)$/i.test(source.name);
  const pdf = source.t === 'pdf' || /\.pdf$/i.test(source.name);
  const knownText = source.excerpt || source.text;
  return <div className="pv-stage">
    {source.signature && <div className="cap">{source.signature}</div>}
    {image && source.url && <div className="preview-controls">
      <button className="op" disabled={zoom <= 50} onClick={() => setZoom(zoom - 25)}>缩小</button>
      <span>{zoom}%</span><button className="op" disabled={zoom >= 250} onClick={() => setZoom(zoom + 25)}>放大</button>
    </div>}
    {pdf && source.url && <div className="preview-controls">
      <label>页码 <input type="number" min="1" value={page} onChange={(e) => setPage(Math.max(1, Number(e.target.value) || 1))} /></label>
      {hitPage > 0 && <button className="op" onClick={() => setPage(hitPage)}>跳到命中页</button>}
      <a className="btn-txt" href={source.url} download={source.name}>下载 PDF</a>
    </div>}
    {image && source.url && <div className="preview-image"><img src={source.url} alt={source.name} style={{ width: zoom + '%' }} /></div>}
    {pdf && source.url && <iframe key={page} className="material-pdf" src={source.url + '#page=' + page} title={source.name} />}
    {pdf && !source.url && <div className="pv-paper pdf-missing">
      <b>这份材料尚未附上 PDF 原件</b>
      {onAttachPdf && <>
        <p>选择原件后，就能在这里查看 PDF 页面。</p>
        <label className="pdf-attach">选择 PDF 原件
          <input type="file" accept=".pdf,application/pdf" aria-label="选择 PDF 原件" onChange={(event) => {
            const file = event.target.files[0];
            if (!file) return;
            if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) {
              setFileError('请选择 PDF 文件。');
              event.target.value = '';
              return;
            }
            setFileError('');
            onAttachPdf(file);
          }} />
        </label>
        {fileError && <p role="alert">{fileError}</p>}
      </>}
    </div>}
    {(!pdf || knownText) && <div className="pv-paper material-copy">
      <b>{source.loc || source.name}</b>
      <p>{knownText ? <mark>{knownText}</mark> : '暂无可检索的文本层。'}</p>
    </div>}
  </div>;
}

function DocumentPreview({ doc, itemId, title }) {
  const { state } = useApp();
  const project = selCase(state);
  const items = selEls({ ...state, doc });
  const paper = React.useRef(null);
  React.useLayoutEffect(() => {
    const container = paper.current?.closest('.dwb');
    const hit = paper.current?.querySelector('[data-preview-hit]');
    if (container && hit) {
      container.scrollTop += hit.getBoundingClientRect().top - container.getBoundingClientRect().top - 24;
    }
  }, [doc, itemId]);

  return <article className="doc-paper mvp-paper preview-document" ref={paper}>
    <ReadOnlyDocument project={project} doc={doc} title={title} items={items} edits={state.edits} itemId={itemId} />
  </article>;
}

const OCR = {
  bank: '20230315 王某→李某 <b>500,000.00</b> 借款<br>20230411 李某→王某 <b>35,000.00</b> 利息',
  jt: '今借到王某人民币 <b>伍拾万元整</b>（¥500,000），借期<b>一年</b>，年利率<b>12%</b>。借款人：李某 2023.3.15',
  wc: '李某：“<b>钱我认，再宽限两个月</b>，这段时间确实周转不开。”（2024-03-20 21:47）',
  law: '第五百七十七条 当事人一方不履行合同义务或者履行合同义务不符合约定的，应当承担继续履行、采取补救措施或者赔偿损失等违约责任。',
  case: '（2021）京01民终1234号 …… 借条原件+银行转账凭证……借贷关系成立。',
};

export default function Drawer() {
  const { state, dispatch } = useApp();
  const { drawer } = state;
  if (!drawer.open) return null;

  const reference = drawer.source || { name: drawer.name, st: 'l1' };
  const material = drawer.source?.st === 'l1' && selCase(state).mats.find((item) =>
    reference.id ? item.id === reference.id : item.n === reference.name);
  const source = material ? { ...material, ...reference, url: material.url || reference.url } : reference;
  const variants = {
    bank: <Bank source={source} />, jt: <Jietiao />, wc: <Wechat />,
    law: <Law source={source} laws={LAW_LIB} />, case: <CasePv source={source} cases={CASE_LIB} />,
    document: <DocumentPreview doc={drawer.doc} itemId={drawer.itemId} title={drawer.name} />,
  };
  const body = variants[drawer.variant] || <Preview key={source.name + source.loc} source={source}
    onAttachPdf={material && ((file) => dispatch({ type: 'ATTACH_PDF', id: material.id, url: pdfFileUrl(file) }))} />;
  const ocr = ['bank', 'jt', 'wc'].includes(drawer.variant) ? OCR[drawer.variant] : null;

  return (
    <>
      <div className="ovl show" onClick={() => dispatch({ type: 'CLOSE_DRAWER' })} />
      <div className="dwr show" role="dialog" aria-label={drawer.name}>
        <div className="dwh">
          <div>
            <div className="dwt">{drawer.name}</div>
            <div className="dws">{drawer.sub}</div>
          </div>
          <button className="dw-x" aria-label="关闭预览" onClick={() => dispatch({ type: 'CLOSE_DRAWER' })}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>
        <div className="dwb">{body}</div>
        <div className="ocr" style={{ display: ocr ? 'block' : 'none' }}>
          <div className="ocr-l">OCR / 原文摘录 · 命中高亮</div>
          <div className="ocr-x" dangerouslySetInnerHTML={{ __html: ocr || '—' }} />
        </div>
      </div>
    </>
  );
}
