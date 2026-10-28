import { useRef, useState } from 'react'
import { api } from './api'
import type { KnowledgeCase } from './types'

export function CaseSearchPanel({ onOpen }: { onOpen: (entry: KnowledgeCase) => void }) {
  const [keyword, setKeyword] = useState('')
  const [courtName, setCourt] = useState('')
  const [judgeName, setJudge] = useState('')
  const [courtWeight, setCourtWeight] = useState(2)
  const [judgeWeight, setJudgeWeight] = useState(2)
  const [items, setItems] = useState<KnowledgeCase[]>([])
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const revision = useRef(0)
  const changed = () => { revision.current++; setItems([]); setNotice(''); setBusy(false) }
  return <section className="insight-card">
    <strong>法院、法官加权检索</strong>
    <form className="legal-search-controls" onSubmit={async e => {
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
      <input aria-label="争议或关键词" placeholder="争议、案号或关键词" value={keyword} onChange={e => { changed(); setKeyword(e.target.value) }} />
      <input aria-label="法院" placeholder="法院名称" value={courtName} onChange={e => { changed(); setCourt(e.target.value) }} />
      <input aria-label="法官" placeholder="法官姓名" value={judgeName} onChange={e => { changed(); setJudge(e.target.value) }} />
      <label>法院权重 {courtWeight}<input aria-label="法院权重" type="range" min="0" max="5" value={courtWeight} onChange={e => { changed(); setCourtWeight(+e.target.value) }} /></label>
      <label>法官权重 {judgeWeight}<input aria-label="法官权重" type="range" min="0" max="5" value={judgeWeight} onChange={e => { changed(); setJudgeWeight(+e.target.value) }} /></label>
      <button className="primary-button" disabled={busy || !(keyword.trim() || courtName.trim() || judgeName.trim())}>{busy ? '检索中...' : '检索案例'}</button>
    </form>
    {notice ? <p role="status">{notice}</p> : null}
    <div className="knowledge-reference-list">{items.map(entry => <article className="knowledge-reference-card" key={entry.id}>
      <strong>{entry.title}</strong><span>{entry.courtName} · {entry.caseNumber}</span>
      {entry.judgeNames?.length ? <span>审判人员：{entry.judgeNames.join('、')}</span> : null}
      <p>{entry.holdingSummary}</p>
      <span>{entry.searchMatches?.courtMatched ? '法院匹配 ' : ''}{entry.searchMatches?.judgeMatched ? '法官匹配' : ''}</span>
      <button type="button" className="ghost-button" onClick={() => onOpen(entry)}>查看详情</button>
    </article>)}</div>
  </section>
}
