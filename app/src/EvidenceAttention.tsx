import type { Evidence, EvidenceInsight } from './types'
import { getAttentionGroups, getAttentionTerms, splitAttentionText } from './evidence-attention'

export function AttentionText({ text, terms }: { text: string; terms: string[] }) {
  return splitAttentionText(text, terms).map((part, index) =>
    part.highlighted ? <mark className="evidence-key-mark" key={index}>{part.text}</mark> : part.text,
  )
}

export function EvidenceAttention({ evidence, insight, processing }: {
  evidence: Evidence
  insight?: EvidenceInsight
  processing: boolean
}) {
  const failed = evidence.summaryStatus === 'failed' || insight?.status === 'failed'
  const ready = !processing && !failed && evidence.summaryStatus === 'ready'
    && insight?.status === 'ready' && insight.evidenceId === evidence.id
  const terms = getAttentionTerms(ready ? insight : undefined)
  const groups = ready ? getAttentionGroups(insight) : []
  const summary = ready ? insight.summary
    : !processing && !failed && evidence.summaryStatus === 'ready' ? evidence.summaryText : ''

  return (
    <section className="evidence-attention" aria-label="律师关注" aria-busy={processing}>
      <div className="evidence-attention-head">
        <strong>律师关注</strong>
        <span>{processing ? '正在梳理材料…' : failed ? '材料理解未完成' : summary ? '材料要点' : '待理解'}</span>
      </div>
      {processing ? (
        <div className="evidence-attention-status" role="status">
          <span className="evidence-attention-pulse" aria-hidden="true" />
          正在提取关键事实、证明目的与争议风险…
        </div>
      ) : failed ? (
        <p className="evidence-attention-status">暂未能完成材料理解，请点击上方按钮重试。</p>
      ) : summary ? (
        <>
          <p className="evidence-attention-summary"><AttentionText text={summary} terms={terms} /></p>
          {groups.map((group) => (
            <div className={`evidence-attention-group ${group.tone}`} key={group.label}>
              <strong>{group.label}</strong>
              <ul>{group.items.map((item) => (
                <li key={item}><AttentionText text={item} terms={terms} /></li>
              ))}</ul>
            </div>
          ))}
          {ready && (insight.amounts.length > 0 || insight.timelineEvents.length > 0 || insight.entities.length > 0) ? (
            <details className="evidence-attention-details">
              <summary>人物、金额与时间</summary>
              {[
                ['相关主体', insight.entities],
                ['关键金额', insight.amounts],
                ['时间节点', insight.timelineEvents],
              ].map(([label, items]) => Array.isArray(items) && items.length ? (
                <div className="evidence-attention-group fact" key={String(label)}>
                  <strong>{label}</strong>
                  <ul>{items.map((item) => <li key={item}><AttentionText text={item} terms={terms} /></li>)}</ul>
                </div>
              ) : null)}
            </details>
          ) : null}
          {ready && insight.keyExcerpts?.length ? (
            <div className="evidence-attention-excerpts">
              <strong>关键原文摘录</strong>
              {insight.keyExcerpts.map((item, index) => (
                <div className="evidence-attention-excerpt" key={`${item.quote}-${index}`}>
                  {item.pageNumber ? <span>第 {item.pageNumber} 页</span> : null}
                  <blockquote><mark className="evidence-key-mark">{item.quote}</mark></blockquote>
                  <p>{item.significance}</p>
                </div>
              ))}
            </div>
          ) : null}
          <p className="evidence-attention-note">理解要点供核验参考，以原件及完整材料为准。</p>
        </>
      ) : (
        <p className="evidence-attention-status">理解材料后，在此显示证明目的、关键事实与待核验事项。</p>
      )}
    </section>
  )
}
