import React from 'react';
import { selEls, useApp } from '../store/AppStore.jsx';
import { blocksExport } from '../utils/review.js';
import LawLogo from '../components/LawLogo.jsx';
import { CASES } from '../data/cases.js';

const sampleCaseIds = new Set(CASES.map((project) => project.id));

export default function HomePage() {
  const { state, dispatch } = useApp();
  const projects = state.projects.filter((project) => !sampleCaseIds.has(project.id));
  const samples = state.projects.filter((project) => sampleCaseIds.has(project.id));

  return <div className="page active" id="pg-home">
    <main className="home">
      <div className="home-in mvp-home-page">
        <div className="home-masthead">
          <div className="brand">
            <span className="seal"><LawLogo /></span>
            <span className="brand-name">LawVerify</span>
          </div>
          <span>律师工作台</span>
        </div>

        <header className="home-intro">
          <div className="home-intro-copy">
            <h1>文书核验与起草</h1>
            <p>逐句核验证据联动 · 按代理立场起草 · 案件记忆贯穿全程。</p>
            <button className="btn btn-pri" onClick={() => dispatch({ type: 'OPEN_FORM' })}>＋ 新建案件</button>
          </div>
          <section className="home-steps" aria-labelledby="home-steps-title">
            <h2 id="home-steps-title">如何开始</h2>
            <ol>
              <li>
                <h3>新建案件，选任务</h3>
                <p>填案件名称，选「AI 核验文书」或「AI 起草新文书」。</p>
              </li>
              <li>
                <h3>备齐卷内材料</h3>
                <p><b>AI 核验</b>　案件原材料 + 待核验文书</p>
                <p><b>AI 起草</b>　案件原材料 + 代理立场</p>
              </li>
              <li>
                <h3>工作台处理，导出 Word</h3>
                <p>待办优先核对证据联动；AI 助手查法条、查案例、按立场起草。律师确认后导出带批注 Word，案件记忆跨文书复用。</p>
              </li>
            </ol>
          </section>
        </header>

        <section aria-labelledby="home-case-title">
          <div className="home-case-heading">
            <h2 id="home-case-title">我的案件</h2>
            <span>{projects.length} 件</span>
          </div>
          {projects.length ? <CaseList projects={projects} state={state} dispatch={dispatch} />
            : <p className="home-case-empty">暂无案件。点击「新建案件」开始。</p>}
        </section>
        <section className="home-sample-cases" aria-labelledby="home-sample-title">
          <div className="home-case-heading">
            <h2 id="home-sample-title">示例案件</h2>
            <span>内置演示数据</span>
          </div>
          <CaseList projects={samples} state={state} dispatch={dispatch} sample />
        </section>
      </div>
    </main>
  </div>;
}

function CaseList({ projects, state, dispatch, sample = false }) {
  return <ul className="mvp-case-list">
    {projects.map((project) => {
      const todo = project.docs.flatMap((doc) => selEls({ ...state, caseId: project.id, doc })).filter(blocksExport).length;
      const materialCount = project.mats.filter((material) => !['law', 'case'].includes(material.t)).length;

      return <li key={project.id}>
        <div className="case-card" onClick={() => dispatch({ type: 'ENTER_CASE', id: project.id })}>
          <span className="home-case-icon" aria-hidden="true" />
          <span className="home-case-info">
            <span className="home-case-title">
              <button type="button" className="case-name" title={project.name}
                onClick={(event) => { event.stopPropagation(); dispatch({ type: 'ENTER_CASE', id: project.id }); }}>
                {project.name}
              </button>
              {!sample && <button type="button" className="case-edit" title="编辑案件基本信息"
                aria-label={`编辑案件：${project.name}`}
                onClick={(event) => {
                  event.stopPropagation();
                  dispatch({ type: 'OPEN_FORM', edit: true, caseId: project.id });
                }}>
                <span aria-hidden="true">✎</span> 编辑
              </button>}
            </span>
            <small>{materialCount} 份材料 · {project.docs.length} 份文书</small>
          </span>
          {todo > 0 && <span className="home-case-pending">{todo} 项待处理</span>}
          <span className="case-open" aria-hidden="true"><span>{sample ? '体验示例' : '进入工作台'}</span> <span>↗</span></span>
        </div>
      </li>;
    })}
  </ul>;
}
