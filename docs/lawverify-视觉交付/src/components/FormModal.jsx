import React, { useState } from 'react';
import { selCase, useApp } from '../store/AppStore.jsx';

const extras = [
  ['cause', '案由', '例如，买卖合同纠纷'],
  ['court', '受诉法院', ''],
  ['no', '案号', ''],
];

function CaseForm({ project, toast, hidden }) {
  const { dispatch } = useApp();
  const [values, setValues] = useState(project || {});
  const [mode, setMode] = useState('verify');
  const close = () => dispatch({ type: 'CLOSE_FORM' });
  const field = (key) => ({
    value: values[key] || '',
    onChange: (event) => setValues({ ...values, [key]: event.target.value }),
  });

  /* 案件名称含「诉」时，自动补全原告/被告（不覆盖已填内容） */
  const onName = (event) => {
    const name = event.target.value;
    const next = { ...values, name };
    if (!values.plaintiff && !values.defendant) {
      const at = name.indexOf('诉');
      if (at > 0) {
        const plaintiff = name.slice(0, at).trim();
        const defendant = name.slice(at + 1).trim().split(/\s+/)[0] || '';
        if (plaintiff) next.plaintiff = plaintiff;
        if (defendant) next.defendant = defendant;
      }
    }
    setValues(next);
  };

  const ourSide = values.ourSide === 'defendant' ? 'defendant' : 'plaintiff';
  const pickSide = (side) => setValues({ ...values, ourSide: side });

  const partiesBlock = (
    <section className="case-form-parties" aria-label="当事人与我方">
      <div className="party-head">
        <b>当事人</b>
        <small>顶栏将标注「我方」</small>
      </div>
      <div className="party-line">
        <label className="fld">
          <span>原告</span>
          <input placeholder="姓名或单位" {...field('plaintiff')} />
        </label>
        <label className="fld">
          <span>被告</span>
          <input placeholder="姓名或单位" {...field('defendant')} />
        </label>
      </div>
      <div className="side-inline">
        <span>我方</span>
        <div className="seg" role="radiogroup" aria-label="选择我方当事人">
          <label className={ourSide === 'plaintiff' ? 'on' : ''}>
            <input type="radio" name="ourSide" value="plaintiff"
              checked={ourSide === 'plaintiff'} onChange={() => pickSide('plaintiff')} />
            原告{values.plaintiff ? ' · ' + values.plaintiff : ''}
          </label>
          <label className={ourSide === 'defendant' ? 'on' : ''}>
            <input type="radio" name="ourSide" value="defendant"
              checked={ourSide === 'defendant'} onChange={() => pickSide('defendant')} />
            被告{values.defendant ? ' · ' + values.defendant : ''}
          </label>
        </div>
      </div>
    </section>
  );

  return <div className="fm show" style={hidden ? { display: 'none' } : undefined}
    onClick={(event) => { if (event.target === event.currentTarget) close(); }}>
    <form className="fm-box case-form case-form-compact" role="dialog" aria-modal="true" aria-labelledby="case-form-title" onSubmit={(event) => {
      event.preventDefault();
      const keys = ['name', 'plaintiff', 'defendant', 'cause', 'court', 'no', 'ourSide'];
      const fields = Object.fromEntries(keys.map((key) => [key, (values[key] || '').trim()]));
      fields.ourSide = ourSide;
      if (!fields.name) return toast('请填写案件名称');
      if (project) dispatch({ type: 'SAVE_FORM', values: fields });
      else dispatch({ type: 'PREPARE_CASE_UPLOAD', mode, draft: { values: fields, stance: values.stance?.trim(), note: values.note?.trim() } });
    }}>
      <div className="fm-h">
        <b id="case-form-title">{project ? '编辑案件信息' : '新建案件'}</b>
        <button type="button" className="btn-txt" onClick={close}>关闭</button>
      </div>
      <div className="case-form-body">
        <label className="fld">
          <span>案件名称 <small>必填</small></span>
          <input autoFocus required placeholder="例如，王某诉李某 民间借贷纠纷" value={values.name || ''} onChange={onName} />
        </label>

        {!project && <div className="case-task-row" role="radiogroup" aria-label="选择任务">
          <label className={mode === 'verify' ? 'on' : ''}>
            <input type="radio" name="case-task" value="verify" checked={mode === 'verify'} onChange={() => setMode('verify')} />
            <span className="task-copy"><b>AI 核验文书</b><small>原材料 + 待核验文书</small></span>
          </label>
          <label className={mode === 'draft' ? 'on' : ''}>
            <input type="radio" name="case-task" value="draft" checked={mode === 'draft'} onChange={() => setMode('draft')} />
            <span className="task-copy"><b>AI 起草新文书</b><small>上传案件原材料</small></span>
          </label>
        </div>}

        {project
          ? <div className="case-form-split">
              {partiesBlock}
              <section className="case-form-extras" aria-label="更多信息">
                <div className="party-head"><b>更多信息</b><small>选填</small></div>
                <div className="party-line">
                  <label className="fld">
                    <span>案由</span>
                    <input placeholder="买卖合同纠纷" {...field('cause')} />
                  </label>
                  <label className="fld">
                    <span>受诉法院</span>
                    <input placeholder="如：北京市朝阳区人民法院" {...field('court')} />
                  </label>
                </div>
                <label className="fld">
                  <span>案号</span>
                  <input placeholder="如：（2024）京0105民初1234号" {...field('no')} />
                </label>
              </section>
            </div>
          : partiesBlock}

        {!project && <details className="case-form-details">
          <summary>案件记忆与更多信息 <small>代理立场 / 笔记 / 案由 / 法院 / 案号，选填</small></summary>
          <div className="case-form-fold">
            <div className="fold-grid">
              <label className="fld">
                <span>代理立场</span>
                <textarea rows={2} placeholder="代理哪一方、办案目标" {...field('stance')} />
              </label>
              <label className="fld">
                <span>律师笔记</span>
                <textarea rows={2} placeholder="待办、补证线索或写作要求" {...field('note')} />
              </label>
            </div>
            <div className="fold-grid three">
              {extras.map(([key, label, placeholder]) => <label className="fld" key={key}>
                <span>{label}</span>
                <input placeholder={placeholder} {...field(key)} />
              </label>)}
            </div>
            <p className="fold-hint">案件记忆创建后可在「案件记忆」页继续补充，供 AI 起草时参考。</p>
          </div>
        </details>}
      </div>
      <div className="fm-ft">
        <button type="button" className="btn-gh btn btn-sm" onClick={close}>取消</button>
        <button className="btn btn-pri btn-sm">{project ? '保存案件信息' : '下一步：上传文件'}</button>
      </div>
    </form>
  </div>;
}

export default function FormModal({ toast }) {
  const { state } = useApp();
  return state.form.open ? <CaseForm project={state.form.edit ? selCase(state) : null} toast={toast} hidden={!!state.upload.draft} /> : null;
}
