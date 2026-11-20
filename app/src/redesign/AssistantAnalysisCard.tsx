import type { AnalysisOutput } from '../../../server/src/assistant/analysis'

const fieldLabels: Record<string, string> = {
  authenticity: '真实性', legality: '合法性', relevance: '关联性', probative: '证明力', reinforce: '补强建议',
  breaks: '论证断链', formula: '算式', inputs: '输入', result: '结果', risks: '风险', actions: '补证动作',
  ourIssues: '我方争点', theirIssues: '对方争点', shared: '共同争点',
}

export function AssistantAnalysisCard({ card }: { card: AnalysisOutput }) {
  return <article className="workspace-ai-result">
    {card.status === 'pending' && <p role="status">资料不足或存在待核事项。</p>}
    {'events' in card ? <ul>{card.events.map((event, index) => <li key={index}>
      <b>{event.date ?? '日期待核'}</b>　{event.event}<small> · {event.material} · {event.loc}</small>
    </li>)}</ul> : Object.entries(fieldLabels).map(([field, label]) => {
      const values = (card as unknown as Record<string, string[]>)[field]
      return Array.isArray(values) && <section key={field}>
        <h3>{label}</h3>
        {values.length ? <ul>{values.map((value, index) => <li key={index}>{value}</li>)}</ul> : <p>暂无记录。</p>}
      </section>
    })}
  </article>
}
