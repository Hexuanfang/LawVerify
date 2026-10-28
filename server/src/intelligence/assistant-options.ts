import { z } from 'zod'

export const assistantOptionsSchema = z.object({
  model: z.string().trim().min(1).max(200).optional(),
  agent: z.enum(['case', 'evidence', 'strategy']).default('case'),
  skill: z.enum(['timeline', 'evidence_gaps', 'cross_examination', 'risk_review']).optional(),
})
export type AssistantOptions = z.input<typeof assistantOptionsSchema>

const agents = {
  case: '综合理解案件，围绕本次问题给出简洁、可执行的办案建议。',
  evidence: '以证据分析律师的视角，重点分析真实性、合法性、关联性、证明目的、证据链和矛盾。',
  strategy: '以诉讼策略律师的视角，重点分析请求权基础、构成要件、证明责任、抗辩和程序选择。',
}
const skills = {
  timeline: '执行时间线梳理：按时间列明事件、对应证据编号和待核实事项；缺失时间不得推定。',
  evidence_gaps: '执行补证清单：按争议事实、证明责任、已有证据、缺口、建议获取途径逐项整理。',
  cross_examination: '执行质证提纲：按证据编号、证明目的、真实性、合法性、关联性、证明力和质证意见整理；不得编造事实。',
  risk_review: '执行风险审查：区分事实风险、证据风险、实体法风险和程序风险，说明依据及应对建议。',
}
export function assistantInstructions(input: AssistantOptions = {}) {
  const options = assistantOptionsSchema.parse(input)
  return [agents[options.agent], options.skill ? skills[options.skill] : ''].filter(Boolean).join('\n')
}
