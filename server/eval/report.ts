import type { MetricResult } from './metrics.js'

export interface LiveMetric {
  key: string
  label: string
  value: number
  detail: string
}

export interface EvalReportInput {
  generatedAt: string
  mode: 'offline' | 'live'
  corpus: string
  samples: number
  materials: number
  claims: number
  metrics: MetricResult[]
  live?: LiveMetric[]
  baseline?: Record<string, number>
  thresholds: Record<string, number>
  datasetIssues: string[]
  durationMs: number
}

function formatPercent(value: number) {
  return `${(value * 100).toFixed(1)}%`
}

function formatDelta(value: number) {
  if (!Number.isFinite(value)) {
    return '-'
  }
  const sign = value > 0 ? '+' : ''
  return `${sign}${(value * 100).toFixed(1)}pt`
}

export function renderEvalReport(input: EvalReportInput) {
  const lines: string[] = []

  lines.push('# LawVerify 评测报告')
  lines.push('')
  lines.push(`- 生成时间：${input.generatedAt}`)
  lines.push(`- 运行模式：${input.mode === 'live' ? '离线 + 真实模型（live）' : '离线回放（offline）'}`)
  lines.push(`- 语料来源：\`corpus=${input.corpus}\`${input.corpus === 'synthetic' ? '（合成语料，指标仅用于回归比较，不代表真实案件效果）' : ''}`)
  lines.push(`- 样本 / 材料 / 主张句：${input.samples} / ${input.materials} / ${input.claims}`)
  lines.push(`- 耗时：${(input.durationMs / 1000).toFixed(1)}s`)
  lines.push('')

  if (input.datasetIssues.length) {
    lines.push('> [!WARNING]')
    lines.push('> 语料自检未通过，以下样本的标注与段落正文对不上，指标结果不可信：')
    for (const issue of input.datasetIssues.slice(0, 20)) {
      lines.push(`> - ${issue}`)
    }
    lines.push('')
  }

  lines.push('## 指标')
  lines.push('')
  lines.push('| 指标 | 本次 | 阈值 | 结论 | 基线 | 差值 | 样本 |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- |')
  for (const metric of input.metrics) {
    const threshold = input.thresholds[metric.key]
    const thresholdText = threshold === undefined ? '-' : formatPercent(threshold)
    const conclusion = threshold === undefined
      ? '-'
      : metric.key.endsWith('_rate_max')
        ? (metric.value <= threshold ? '达标' : '不达标')
        : (metric.value >= threshold ? '达标' : '不达标')
    const baseline = input.baseline?.[metric.key]
    const delta = baseline === undefined ? undefined : metric.value - baseline
    lines.push([
      metric.label,
      formatPercent(metric.value),
      thresholdText,
      conclusion,
      baseline === undefined ? '-' : formatPercent(baseline),
      delta === undefined ? '-' : formatDelta(delta),
      `${metric.correct}/${metric.total}`,
    ].join(' | '))
  }
  lines.push('')

  lines.push('## 指标说明')
  lines.push('')
  for (const metric of input.metrics) {
    lines.push(`### ${metric.label}`)
    lines.push('')
    lines.push(`- 当前值：${formatPercent(metric.value)}（${metric.correct}/${metric.total}）`)
    if (metric.notes) {
      lines.push(`- 说明：${metric.notes}`)
    }
    if (metric.failures.length) {
      lines.push('- 未通过样本：')
      for (const failure of metric.failures.slice(0, 30)) {
        lines.push(`  - \`${failure.id}\` ${failure.reason}`)
      }
      if (metric.failures.length > 30) {
        lines.push(`  - 其余 ${metric.failures.length - 30} 条见 JSON 明细`)
      }
    } else {
      lines.push('- 未通过样本：无')
    }
    lines.push('')
  }

  if (input.live?.length) {
    lines.push('## 真实模型端到端（M6）')
    lines.push('')
    lines.push('| 指标 | 本次 | 说明 |')
    lines.push('| --- | --- | --- |')
    for (const metric of input.live) {
      lines.push(`| ${metric.label} | ${formatPercent(metric.value)} | ${metric.detail} |`)
    }
    lines.push('')
  }

  lines.push('## 口径边界')
  lines.push('')
  lines.push('- 离线模式不调用任何模型接口，不产生费用，两次运行的数值完全一致。')
  lines.push('- 合成语料只用于回归比较；对外披露效果时应切换为真实语料（`datasets/real-v1.jsonl`）。')
  lines.push('- 阈值默认只告警不阻断；需要阻断时使用 `--strict`。')
  lines.push('')

  return lines.join('\n')
}
