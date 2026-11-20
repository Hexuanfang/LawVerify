import React, { createContext, useContext } from 'react';
import { useApp, selEls, elById } from '../../store/AppStore.jsx';

const PreviewTarget = createContext(null);

/* 保留正文结构，点击声明打开核验结果。 */
export function M(props) {
  const preview = useContext(PreviewTarget);
  if (!preview) return <WorkspaceMark {...props} />;
  const text = preview.edits[props.id] ?? props.children;
  const additions = preview.items.filter((item) => item.after === props.id);
  return <>
    {props.id === preview.itemId ? <mark data-preview-hit>{text}</mark> : text}
    {additions.map((item) => <React.Fragment key={item.id}> <M id={item.id}>{item.quote}</M></React.Fragment>)}
  </>;
}

function WorkspaceMark({ id, src = 'l1', st = 'pass', children }) {
  const { state, dispatch } = useApp();
  const timer = React.useRef(null);
  const el = elById(state, id);
  const v = el ? el.verdict : st;
  const hit = state.filter === 'all' || (state.filter === 'fail'
    ? ['fail', 'miss'].includes(v) : v === state.filter);
  const cls = ['mk', `mk-${el?.src || src}`, `st-${v}`, hit ? 'hit' : '', state.sel === id ? 'sel' : '', state.dirty[id] ? 'dirty' : '']
    .filter(Boolean).join(' ');
  const text = state.edits[id] ?? children;
  const additions = selEls(state).filter((item) => item.after === id);
  const commit = (node) => {
    const next = (node?.textContent || '').replace(/\s+/g, ' ').trim();
    const orig = String(text).replace(/\s+/g, ' ').trim();
    if (next && next !== orig) dispatch({ type: 'SET_EDIT', id, text: next });
    else if (!next) node.textContent = text;
  };
  React.useEffect(() => () => clearTimeout(timer.current), []);
  return <>
    {text !== '' && <mark
      className={cls}
      data-el={id}
      data-type={el?.type}
      tabIndex={0}
      contentEditable={state.editMode}
      suppressContentEditableWarning
      spellCheck={false}
      onKeyDown={(e) => { if (!state.editMode && e.key === 'Enter') dispatch({ type: 'SELECT', id }); }}
      onClick={() => { if (!state.editMode && window.getSelection()?.isCollapsed !== false) dispatch({ type: 'SELECT', id }); }}
      onInput={(e) => {
        if (!state.editMode) return;
        const node = e.currentTarget;
        clearTimeout(timer.current);
        timer.current = setTimeout(() => commit(node), 550);
      }}
      onBlur={(e) => {
        if (!state.editMode) return;
        clearTimeout(timer.current);
        commit(e.currentTarget);
      }}
    >{text}</mark>}
    {additions.map((item) => <React.Fragment key={item.id}> <M id={item.id}>{item.quote}</M></React.Fragment>)}
  </>;
}

export function FlexibleDocument({ title, items, blocks }) {
  const existing = new Set((blocks || []).flatMap((block) => block.rows ? block.rows.flat().map((cell) => cell.id) : [block.id]));
  return <><h1>{title}</h1>
    {blocks?.map((block, i) => {
      if (block.rows) return <table className="evid-t" key={i}><tbody>{block.rows.map((row, j) =>
        <tr key={j}>{row.map((cell, k) => <td key={k}>{cell.id ? <M id={cell.id}>{cell.text}</M> : cell.text}</td>)}</tr>
      )}</tbody></table>;
      if (block.id) return <p key={i}><M id={block.id}>{block.text}</M></p>;
      if (/^Heading[2-9]$/i.test(block.style || '')) return <h3 key={i}>{block.text}</h3>;
      return block.text && <h2 key={i}>{block.text}</h2>;
    })}
    {items.filter((item) => !item.after && !existing.has(item.id)).map((item) => <p key={item.id}><M id={item.id}>{item.quote}</M></p>)}
  </>;
}

/* 各文书正文模板：类名与文案与原型一致 */
function renderDocTemplate(caseId, doc, title, items, fileDoc) {
  if (fileDoc || ['zs', 'lsh', 'flyj', 'cx'].includes(doc)) return <FlexibleDocument title={title} items={items} blocks={fileDoc} />;
  if (caseId === 'c1' && doc === 'qs') return C1QS();
  if (caseId === 'c2' && doc === 'qs') return C2QS();
  if (doc === 'db') return C1DB();
  if (doc === 'zj') return C1ZJ();
  if (doc === 'zz') return C1ZZ();
  if (doc === 'dlc') return C1DLC();
  if (doc === 'ss') return C1SS();
  return null;
}

export function DocumentBody({ project, doc, title, items }) {
  return <>
    {renderDocTemplate(project.id, doc, title, items, project.fileDocs?.[doc])}
    {['qs', 'db', 'zj', 'zz', 'dlc', 'ss'].includes(doc) &&
      items.filter((item) => item.aiOrigin && !item.after).map((item) => <p key={item.id}><M id={item.id}>{item.quote}</M></p>)}
  </>;
}

export function ReadOnlyDocument({ project, doc, title, items, edits, itemId }) {
  return <PreviewTarget.Provider value={{ itemId, edits, items }}>
    <DocumentBody project={project} doc={doc} title={title} items={items} />
  </PreviewTarget.Provider>;
}

function C1QS() {
  return (
    <>
      <h1>民事起诉状</h1>
      <p><M id="c1-subj"><strong>原告：</strong>王某，男，住北京市朝阳区。</M></p>
      <p><strong>被告：</strong>李某，男，住北京市海淀区。</p>
      <h2>诉讼请求</h2>
      <p className="indent">一、判令被告偿还借款本金500,000元；</p>
      <p className="indent">二、<M id="c1-q2" src="l1" st="warn">判令被告支付利息（以500,000元为基数，按年利率12%，自2023年3月15日起计算至实际清偿之日）</M>；</p>
      <p className="indent">三、本案诉讼费用由被告承担。</p>
      <h2>事实与理由</h2>
      <p className="indent"><M id="c1-q1" src="l1" st="pass">2023年3月15日，被告以经营周转为由向原告借款500,000元，并出具借条一张，约定借期一年，年利率12%。同日，原告通过招商银行向被告转账500,000元。</M></p>
      <p className="indent">借款到期后，原告多次通过微信催收。<M id="c1-q3" src="l1" st="note">2024年3月20日，被告在微信中回复“钱我认，再宽限两个月”</M>。宽限期届满后，被告仍未偿还剩余借款。</p>
      <p className="indent"><M id="c1-q4" src="l1" st="fail">被告于2023年4月1日向原告支付利息30,000元，此后再未支付任何款项。</M></p>
      <p className="indent"><M id="c1-q5" src="l0" st="miss">被告名下另有房产两套，具备偿还能力。</M></p>
      <p className="indent"><M id="c1-q6" src="l2" st="pass">依据《中华人民共和国民法典》第六百七十五条、第五百七十七条</M>，被告应当偿还本金并支付利息。</p>
      <p className="indent"><M id="c1-q7" src="l3" st="pass">类案参考：（2021）京01民终1234号民事判决认定，出借人通过银行转账交付借款并持有借条的，借贷关系成立。</M></p>
      <p className="indent">综上，请求法院支持原告全部诉讼请求。</p>
      <div className="doc-sig"><p>此致</p><p>北京市朝阳区人民法院</p><p style={{ marginTop: 14 }}>具状人：王某</p><p>2024年6月15日</p></div>
    </>
  );
}

function C2QS() {
  return (
    <>
      <h1>民事起诉状</h1>
      <p><strong>原告：</strong>星辰科技有限公司，住所地杭州市余杭区。</p>
      <p><strong>被告：</strong>远大商贸有限公司，住所地杭州市西湖区。</p>
      <h2>诉讼请求</h2>
      <p className="indent">一、判令被告支付货款376,000元及逾期付款损失；</p>
      <p className="indent">二、本案诉讼费用由被告承担。</p>
      <h2>事实与理由</h2>
      <p className="indent"><M id="c2-q1" src="l1" st="pass">2024年3月10日，原告星辰科技与被告远大商贸签订《钢材购销合同》，约定原告向被告供应Q235B钢材120吨，单价每吨4,800元，货款共计576,000元，收货后30日内付清。</M></p>
      <p className="indent"><M id="c2-q2" src="l1" st="warn">2024年4月12日原告送货，被告法定代表人亲自签收并组织验收，2024年5月10日验收合格。</M></p>
      <p className="indent"><M id="c2-q3" src="l1" st="pass">被告仅支付货款200,000元，尚欠376,000元。依据《中华人民共和国民法典》第五百七十七条、第五百九十五条，请求判令支付欠款及逾期付款损失。</M></p>
      <p className="indent"><M id="c2-q4" src="l1" st="pass">原告于2024年6月15日向被告发出催款函，被告于6月18日签收，至今未付余款。</M></p>
      <div className="doc-sig"><p>此致</p><p>杭州市余杭区人民法院</p><p style={{ marginTop: 14 }}>具状人：星辰科技有限公司</p><p>2024年7月10日</p></div>
    </>
  );
}

function C1DB() {
  return (
    <>
      <h1>民事答辩状</h1>
      <p><strong>答辩人：</strong>李某（本案被告）</p>
      <h2>答辩请求</h2><p className="indent">请求依法驳回原告全部诉讼请求。</p>
      <h2>事实与理由</h2>
      <p className="indent">一、<M id="c1-d1" src="l1" st="fail">原告所述“2023年4月1日支付利息30,000元”与事实不符。答辩人于2023年4月11日支付利息35,000元，此后未再付款。</M></p>
      <p className="indent">二、<M id="c1-d2" src="l1" st="pass">答辩人于2023年4月11日通过招商银行向原告转账35,000元，系按约支付的利息。</M></p>
      <p className="indent">三、<M id="c1-d3" src="l1" st="pass">对原告主张的借款本金500,000元、年利率12%及2023年3月15日转账交付事实，答辩人无异议。</M></p>
      <p className="indent">四、<M id="c1-d4" src="l2" st="pass">依据《中华人民共和国民法典》第六百七十四条</M>，借款人应当按照约定的期限支付利息。</p>
      <p className="indent">五、<M id="c1-d5" src="l0" st="miss">原告曾口头同意免除剩余利息。</M></p>
      <div className="doc-sig"><p>答辩人：李某</p></div>
    </>
  );
}

function C1ZJ() {
  return (
    <>
      <h1>证据清单</h1>
      <p className="indent"><M id="c1-z1" src="l1" st="pass">证据1：借条原件.jpg ｜ 证明目的：借贷合意，本金50万、借期一年、年利率12%。</M></p>
      <p className="indent"><M id="c1-z2" src="l1" st="fail">证据3：微信聊天截图.png ｜ 证明目的：被告构成欺诈，应承担缔约过失责任。</M></p>
      <p className="indent"><M id="c1-z3" src="l0" st="miss">证据4：证人王某书面证言 ｜ 证明目的：在场见证借款交付。</M></p>
      <p className="indent"><M id="c1-z4" src="l1" st="warn">卷内《原告身份证.jpg》《被告户籍信息.pdf》未列入证据清单。</M></p>
    </>
  );
}

function C1ZZ() {
  return (
    <>
      <h1>质证意见</h1>
      <p className="indent"><M id="c1-t1" src="l1" st="pass">对证据1借条、证据2流水：认可真实性，认可2023年3月15日收到50万元。该借条不能排除已付利息35,000元。</M></p>
      <p className="indent"><M id="c1-t2" src="l1" st="warn">对证据3微信截图：不认可真实性，截图可能被篡改。</M></p>
      <p className="indent"><M id="c1-t3" src="l0" st="fail">对证据4王某证人证言：证人与原告系同事，且未出庭，不认可。</M></p>
    </>
  );
}

function C1DLC() {
  return (
    <>
      <h1>代理词</h1>
      <p className="indent">审判长、审判员：受原告王某委托，现发表如下代理意见。</p>
      <p className="indent">关于借贷关系。<M id="c1-l1" src="l1" st="pass">2023年3月15日借条与同日50万元银行转账相互印证，借贷合意与交付均已成立。</M><M id="c1-l2" src="l2" st="pass">依据《中华人民共和国民法典》第六百六十七条</M>，借款合同是借款人向贷款人借款，到期返还借款并支付利息的合同。<M id="c1-l3" src="l3" st="pass">（2021）京01民终1234号民事判决亦认定，出借人持借条原件并出具银行转账凭证的，借贷关系成立。</M></p>
      <p className="indent">关于违约责任。<M id="c1-l4" src="l2" st="fail">依据《中华人民共和国合同法》第一百零七条，当事人一方不履行合同义务的，应当承担违约责任。</M></p>
    </>
  );
}

function C1SS() {
  return (
    <>
      <h1>上诉状</h1>
      <p className="indent"><M id="c1-s1" src="l1" st="note">一审判决第6页“本院认为”以微信截图无法确认真实性为由不予采信，认定有误。</M></p>
      <p className="indent"><M id="c1-s2" src="l1" st="fail">一审认定答辩人分文未付，与事实不符。</M></p>
      <p className="indent"><M id="c1-s3" src="l0" st="miss">一审认定事实错误，适用法律错误，请二审依法纠正。</M></p>
      <p className="indent"><M id="c1-s4" src="l2" st="pass">请求撤销原判，依法改判或发回重审。依据《中华人民共和国民事诉讼法》第一百七十七条。</M></p>
    </>
  );
}
