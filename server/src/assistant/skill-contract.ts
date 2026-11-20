import type { StatuteValidity } from '../intelligence/verification/protocol.js'
import resource from './skills.prod.json' with { type: 'json' }

const analysisFields = new Set(['authenticity', 'legality', 'relevance', 'probative', 'reinforce', 'breaks', 'formula', 'inputs', 'result', 'risks', 'actions', 'ourIssues', 'theirIssues', 'shared'])
const statuteValidities: ReadonlySet<StatuteValidity> = new Set(['VALID', 'AMENDED', 'PARTIAL', 'REPEALED', 'EXPIRED', 'PENDING', 'UNCERTAIN'])
const confirmedSkills = new Set(['inbox-search', 'statute-mcp', 'case-mcp', 'draft', 'rewrite', 'case-report'])

export type AssistantSkillId = 'inbox-search' | 'statute-mcp' | 'case-mcp' | 'draft' | 'rewrite' | 'evidence' | 'chain' | 'calc' | 'risk' | 'focus' | 'timeline' | 'case-report'
type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T
export type AssistantSkill = DeepReadonly<Omit<(typeof resource.skills)[number], 'id'> & { id: AssistantSkillId }>

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value as DeepReadonly<T>
}

if (resource.guardGlobal.forbidFabricate !== true || resource.guardGlobal.needLawyerConfirmWritePath !== true
  || resource.guardGlobal.aiOriginPending !== true || resource.skills.some(skill => skill.guard.forbidFabricate !== true
    || skill.guard.needLawyerConfirm !== confirmedSkills.has(skill.id))) {
  throw new Error('生产技能安全配置无效')
}

export const assistantSkillContract = deepFreeze(resource)
export const assistantSkills = assistantSkillContract.skills as readonly AssistantSkill[]
const byId = new Map<string, AssistantSkill>(assistantSkills.map(skill => [skill.id, skill]))

export function getAssistantSkill(id: string): AssistantSkill | undefined {
  return byId.get(id)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function hasText(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim())
}

function isOffset(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isDraftLocation(value: unknown) {
  return hasText(value) || (isObject(value) && hasText(value.paragraphId) && isOffset(value.paragraphIndex)
    && isOffset(value.start) && isOffset(value.end) && value.end > value.start)
}

function validateField(value: unknown, field: string) {
  if (['items', 'list', 'excerpts', 'sources'].includes(field)) return Array.isArray(value)
  if (analysisFields.has(field)) return Array.isArray(value) && value.every(hasText)
  if (field === 'events') return Array.isArray(value) && value.every(event => isObject(event) && hasText(event.event)
    && hasText(event.material) && hasText(event.loc) && (event.date === null ? event.status === 'pending'
      : typeof event.date === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(event.date) && event.status === 'recorded'))
  if (field === 'task' || field === 'overview') return hasText(value) || (isObject(value) && Object.keys(value).length > 0)
  return hasText(value)
}

export function validateSkillOutput(id: string, output: unknown): void {
  const skill = getAssistantSkill(id)
  if (!skill) throw new Error(`未注册的助手技能 ${id}`)
  const invalid = (field: string): never => { throw new Error(`助手技能 ${id} 输出字段 ${field} 无效`) }
  if (!isObject(output) || output.type !== skill.output.type) return invalid('type')
  for (const field of skill.output.require) {
    if (!Object.hasOwn(output, field) || !validateField(output[field], field)) invalid(field)
  }
  for (const [field, values] of Object.entries(skill.outputEnums ?? {}) as [string, readonly string[]][]) {
    if (typeof output[field] !== 'string' || !values.includes(output[field])) invalid(field)
  }
  if (id === 'statute-mcp' && !statuteValidities.has(output.validity as StatuteValidity)) invalid('validity')
  if (skill.output.itemRequire && Array.isArray(output.items)) {
    for (const [index, item] of output.items.entries()) {
      if (!isObject(item)) return invalid(`items[${index}]`)
      for (const field of skill.output.itemRequire) {
        const valid = field === 'loc' ? isDraftLocation(item[field]) : validateField(item[field], field)
        if (!Object.hasOwn(item, field) || !valid) invalid(`items[${index}].${field}`)
      }
    }
  }
}
