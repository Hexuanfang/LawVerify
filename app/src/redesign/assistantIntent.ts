import type { AnalysisSkillId } from '../../../server/src/assistant/analysis'
import type { RetrievalSkillId } from '../../../server/src/assistant/retrieval'

type AssistantSkillId = AnalysisSkillId | RetrievalSkillId | 'draft' | 'rewrite' | 'case-report'
type AssistantTurn = { skill: AssistantSkillId; query: string }

const lawCitation = /^(《[^》]+》|(?:中华人民共和国)?(?:民法典|合同法|民事诉讼法|劳动合同法|公司法|民法通则|民法总则))\s*第\s*[\d０-９零〇一二三四五六七八九十百千万两]+\s*条/u
const articleNumber = /^第\s*[\d０-９零〇一二三四五六七八九十百千万两]+\s*条/u
const caseNumber = /^[（(〔【]\s*\d{4}\s*[）)〕】][^。；，,\n]{1,40}?号/u
const searchVerb = /^(?:查询|检索|搜索|查阅|查找|看看|找找|看一下|[查找](?:一下)?)\s*/u
const draftDocument = /^(?:撰写|写|拟写?|生成|补写)(?=.{0,50}(?:起诉状|答辩状|证据清单|质证意见|代理词|上诉状|再审申请书|律师函|法律意见书|申请书|文书))(?:一份|个)?/u

const commands: ReadonlyArray<readonly [AssistantSkillId, RegExp]> = [
  ['case-report', /^(?:(?:生成|预览|导出)?案例(?:检索)?报告|导出案例|打包案例)/u],
  ['draft', /^(?:起草|补写|续写)/u],
  ['draft', draftDocument],
  ['statute-mcp', /^(?:(?:查询|检索|搜索|查(?:阅|找|一下)?)\s*(?:法条|法规|条文)|(?:法条|法规|条文)(?=[：:\s]|$))/u],
  ['case-mcp', /^(?:(?:查询|检索|搜索|查(?:找|一下)?)\s*(?:类案|案例|判例|案号)|(?:案号|类案|案例|判例)(?=[：:\s]|$))/u],
  ['rewrite', /^(?:改写|重写|润色|精简)(?:选区|选段|这段)?/u],
  ['rewrite', /^把(?:这段|这句|选中内容).{0,30}(?:更严谨|更精简|更简洁)/u],
  ['evidence', /^(?:核对|核验|分析|评估)?证据三性/u],
  ['chain', /^(?:检查论证链|论证链检查|检查断链)/u],
  ['calc', /^(?:金额复算|复算|计算利息)/u],
  ['risk', /^(?:风险与补强|识别风险|检查风险|梳理风险)/u],
  ['focus', /^(?:梳理|归纳|总结)?(?:本案)?争议焦点/u],
  ['timeline', /^(?:(?:梳理|整理)(?:本案)?时间线|时间线梳理)/u],
  ['inbox-search', /^(?:卷内(?:检索|查找)|在卷内(?:检索|查找)|查卷内|查找材料)/u],
]

export function isRetrievalTurn(skill: AssistantSkillId): skill is RetrievalSkillId {
  return skill === 'statute-mcp' || skill === 'case-mcp' || skill === 'inbox-search'
}

function statuteQuery(query: string) {
  return query.replace(/第\s*[\d０-９零〇一二三四五六七八九十百千万两]+\s*条/gu, article => article.replace(/\s/gu, ''))
}

export function assistantIntent(text: string, previous?: AssistantTurn): (AssistantTurn & { continuation?: true }) | undefined {
  const instruction = text.trim().replace(/^(?:请\s*)?(?:帮我\s*)?/u, '')
  const followUp = /^(?:那(?:么|就)?\s*(?:再)?|还有|另外再?|再(?!审))\s*[，,：:]?\s*/u.exec(instruction)
  const command = instruction.slice(followUp?.[0].length ?? 0)
  // “再精简一点”修订刚生成的草稿，明确指定选区的改写指令仍优先。
  if (followUp && (previous?.skill === 'draft' || previous?.skill === 'rewrite')
    && /^(?:精简|简洁|简短|润色|严谨)(?:一?点|些)?[。！!？?]*$/u.test(command)) {
    return { skill: previous.skill, query: text.trim(), continuation: true }
  }
  for (const [skill, rule] of commands) {
    const match = rule.exec(command)
    if (!match) continue
    const query = command.slice(match[0].length).replace(/^[\s：:]+/u, '').trim()
    return { skill, query: skill === 'statute-mcp' ? statuteQuery(query) : query }
  }

  const subject = command.replace(searchVerb, '').trim()
  if (lawCitation.test(subject) || /^(?:请求权基础|废止法条|现行法条)/u.test(subject)) return { skill: 'statute-mcp', query: statuteQuery(subject) }
  if (caseNumber.test(subject) || /^(?:类似|相关|有哪些|有没有)(?:类案|案例|判例)/u.test(subject)
    || (subject !== command && /(?:类案|案例|判例)/u.test(subject))) return { skill: 'case-mcp', query: subject }
  if (subject !== command && /(?:依据|凭证|出处|合同|流水|记录|材料)/u.test(subject)) {
    return { skill: 'inbox-search', query: subject.replace(/^本案(?:的)?/u, '') }
  }

  if (!followUp || !previous) {
    if (articleNumber.test(subject)) return { skill: 'statute-mcp', query: statuteQuery(subject) }
    return
  }

  if (!isRetrievalTurn(previous.skill)) return { skill: previous.skill, query: text.trim(), continuation: true }
  const detail = subject.replace(/[吗呢么]?[？?。！!]+$|[吗呢么]$/u, '').trim()
  if (!detail || /^(?:别的|其他的|更多(?:的)?|类似的|看(?:看|一看))$/u.test(detail)) return { skill: previous.skill, query: '' }
  const lawName = previous.skill === 'statute-mcp' && articleNumber.test(detail) ? lawCitation.exec(previous.query)?.[1] : undefined
  const caseTopic = previous.skill === 'case-mcp' && /的$/u.test(detail) && !caseNumber.test(previous.query)
    && previous.query.length + detail.length < 400 ? previous.query + ' ' : ''
  const query = `${lawName ?? caseTopic}${detail}`
  return { skill: previous.skill, query: previous.skill === 'statute-mcp' ? statuteQuery(query) : query }
}
