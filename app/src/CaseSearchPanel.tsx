import { useRef, useState, type CSSProperties } from 'react'
import { api } from './api'
import type { KnowledgeCase } from './types'
import './case-search.css'

function weightProgress(value: number) {
  return `${Math.round((value / 5) * 100)}%`
}

export function CaseSearchPanel({ initialKeyword, onOpen }: { initialKeyword?: string; onOpen: (entry: KnowledgeCase) => void }) {
  const [keyword, setKeyword] = useState(initialKeyword?.trim() ?? '')
  const [courtName, setCourt] = useState('')
  const [judgeName, setJudge] = useState('')
  const [courtWeight, setCourtWeight] = useState(2)
  const [judgeWeight, setJudgeWeight] = useState(2)
  const [items, setItems] = useState<KnowledgeCase[]>([])
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const revision = useRef(0)
  const changed = () => { revision.current++; setItems([]); setNotice(''); setBusy(false) }
  const canSearch = Boolean(keyword.trim() || courtName.trim() || judgeName.trim())

  return <section className="insight-card case-search-panel">
    <div className="preview-section-head">
      <strong>外部案例检索</strong>
      <span>按法院、法官加权检索</span>
    </div>
    <p className="insight-card-hint">检索元典、威科、北大法宝等外部案例库；内置类案请在知识库中检索。</p>
    <form className="case-search-form" onSubmit={async e => {
      e.preventDefault()
      const current = ++revision.current
      setBusy(true); setNotice('')
      try {
        const result = await api.searchWeightedCases({ keyword, courtName, judgeName, courtWeight, judgeWeight })
        if (current !== revision.current) return
        setItems(result.items)
        setNotice(result.failedProviders ? '部分案例来源暂不可用，已显示可用结果。'
          : !result.configuredProviders ? '未配置外部案例来源，当前检索本地案例。'
          : result.items.length ? '' : '未找到匹配案例。')
      } catch (error) { if (current === revision.current) setNotice(error instanceof Error ? error.message : '检索失败。') }
      finally { if (current === revision.current) setBusy(false) }
    }}>
      <div className="case-search-fields">
        <label className="case-search-field case-search-field-keyword">
          <span className="case-search-label">争议或关键词</span>
          <span className="case-search-input-wrap">
            <svg className="case-search-input-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <circle cx="7.2" cy="7.2" r="4.4" stroke="currentColor" strokeWidth="1.5" />
              <path d="M10.6 10.6 13.6 13.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            <input aria-label="争议或关键词" placeholder="争议、案号或关键词" value={keyword} onChange={e => { changed(); setKeyword(e.target.value) }} />
          </span>
        </label>
        <label className="case-search-field">
          <span className="case-search-label">法院</span>
          <input aria-label="法院" placeholder="法院名称" value={courtName} onChange={e => { changed(); setCourt(e.target.value) }} />
        </label>
        <label className="case-search-field">
          <span className="case-search-label">法官</span>
          <input aria-label="法官" placeholder="法官姓名" value={judgeName} onChange={e => { changed(); setJudge(e.target.value) }} />
        </label>
      </div>

      <div className="case-search-weights">
        <div className="case-search-weights-head">
          <strong>权重设置</strong>
          <span>权重越高，匹配项在结果排序中越靠前</span>
        </div>
        <div className="case-search-weight">
          <div className="case-search-weight-row">
            <label htmlFor="case-search-court-weight">法院权重</label>
            <span className="case-search-weight-value">{courtWeight}</span>
          </div>
          <input
            id="case-search-court-weight"
            className="case-search-range"
            style={{ '--range-progress': weightProgress(courtWeight) } as CSSProperties}
            type="range"
            min="0"
            max="5"
            step="1"
            value={courtWeight}
            aria-label="法院权重"
            onChange={e => { changed(); setCourtWeight(+e.target.value) }}
          />
          <div className="case-search-scale"><span>不参与</span><span>最高优先</span></div>
        </div>
        <div className="case-search-weight">
          <div className="case-search-weight-row">
            <label htmlFor="case-search-judge-weight">法官权重</label>
            <span className="case-search-weight-value">{judgeWeight}</span>
          </div>
          <input
            id="case-search-judge-weight"
            className="case-search-range"
            style={{ '--range-progress': weightProgress(judgeWeight) } as CSSProperties}
            type="range"
            min="0"
            max="5"
            step="1"
            value={judgeWeight}
            aria-label="法官权重"
            onChange={e => { changed(); setJudgeWeight(+e.target.value) }}
          />
          <div className="case-search-scale"><span>不参与</span><span>最高优先</span></div>
        </div>
      </div>

      <div className="case-search-actions">
        <span className="case-search-tip">关键词、法院、法官至少填写一项</span>
        <button className="primary-button" disabled={busy || !canSearch}>{busy ? '检索中...' : '检索案例'}</button>
      </div>
    </form>
    {notice ? <p className="case-search-notice" role="status">{notice}</p> : null}
    <div className="knowledge-reference-list">
      {items.map(entry => <article className="knowledge-reference-card case-search-result" key={entry.id}>
        <div className="case-search-result-head">
          <strong>{entry.title}</strong>
          <div className="case-search-tags">
            {entry.searchMatches?.courtMatched ? <span className="case-search-tag">法院匹配</span> : null}
            {entry.searchMatches?.judgeMatched ? <span className="case-search-tag">法官匹配</span> : null}
          </div>
        </div>
        <span className="case-search-result-meta">{entry.courtName} · {entry.caseNumber}</span>
        {entry.judgeNames?.length ? <span className="case-search-result-meta">审判人员：{entry.judgeNames.join('、')}</span> : null}
        <p>{entry.holdingSummary}</p>
        <div className="case-search-result-actions">
          <button type="button" className="ghost-button" onClick={() => onOpen(entry)}>查看详情</button>
        </div>
      </article>)}
    </div>
  </section>
}
