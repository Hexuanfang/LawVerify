import React from 'react';
import { useApp, selCase } from '../../store/AppStore.jsx';
import LawLogo from '../../components/LawLogo.jsx';
import SearchSelect from '../../components/SearchSelect.jsx';

/* 从案件名解析当事人：王某诉李某 民间借贷纠纷 → 原告 王某 / 被告 李某 */
function partiesOf(name) {
  const at = name.indexOf('诉');
  if (at <= 0) return null;
  const plaintiff = name.slice(0, at).trim();
  const defendant = name.slice(at + 1).trim().split(/\s+/)[0] || '';
  if (!plaintiff || !defendant) return null;
  return { plaintiff, defendant };
}

/* 顶栏：品牌 + 当前案件（含当事人/法院）+ 案件记忆。文书操作在文书区。 */
export default function Topbar() {
  const { state, dispatch } = useApp();
  const c = selCase(state);
  const parsed = partiesOf(c.name || '');
  const parties = (c.plaintiff || c.defendant || parsed)
    ? {
        plaintiff: c.plaintiff || parsed?.plaintiff || '',
        defendant: c.defendant || parsed?.defendant || '',
        ourSide: c.ourSide,
      }
    : null;
  const our = parties?.ourSide;
  const ourLabel = our === 'defendant' ? '被告' : '原告';

  return <div className="topbar mvp-topbar">
    <button className="brand mvp-home" aria-label="返回案件首页" onClick={() => dispatch({ type: 'NAV', page: 'home' })}>
      <span className="seal"><LawLogo /></span>
      <span className="brand-name">LawVerify</span>
    </button>
    <span className="top-sep" aria-hidden="true" />
    <div className="topbar-case">
      <small>当前案件</small>
      <SearchSelect
        label="切换案件"
        value={c.id}
        options={state.projects.map((project) => ({
          value: project.id,
          label: project.name,
          keywords: [project.no, project.court, project.cause, project.name].join(' '),
        }))}
        onChange={(id) => dispatch({ type: 'ENTER_CASE', id })}
      />
    </div>
    <small className="topbar-parties" title={[parties && '原告·' + parties.plaintiff, parties && '被告·' + parties.defendant, c.court].filter(Boolean).join(' | ')}>
      {parties && <>
        <span className={'party' + (our === 'plaintiff' ? ' our' : '')} title={our === 'plaintiff' ? '当前律师代理原告' : undefined}>
          原告·{parties.plaintiff}{our === 'plaintiff' && <i className="our-tag">我方</i>}
        </span>
        <span className="party-sep" aria-hidden="true">|</span>
        <span className={'party' + (our === 'defendant' ? ' our' : '')} title={our === 'defendant' ? '当前律师代理被告' : undefined}>
          被告·{parties.defendant}{our === 'defendant' && <i className="our-tag">我方</i>}
        </span>
      </>}
      {parties && c.court && <span className="topbar-sep-dot" aria-hidden="true">｜</span>}
      {c.court}
    </small>
    <button className="btn btn-pri btn-sm topbar-memory" aria-label="打开案件记忆" onClick={() => dispatch({ type: 'NAV', page: 'memory' })}>
      <span aria-hidden="true">🧠</span> 案件记忆
    </button>
  </div>;
}
