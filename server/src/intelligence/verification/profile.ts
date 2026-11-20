import resource from './doc-element-profile.json' with { type: 'json' }
import type { CheckCode, DocKey, ElementType } from './protocol.js'

export const docKeys = ['qs', 'db', 'zj', 'zz', 'dlc', 'ss', 'zs', 'lsh', 'flyj', 'proc'] as const satisfies readonly DocKey[]
export const elementTypes = ['E-SUBJ', 'E-CLAIM', 'E-FACT', 'E-CALC', 'E-EVID', 'E-PURP', 'E-LAW', 'E-CASE', 'E-FOCUS', 'E-PROC', 'E-CROSS', 'E-ERR'] as const satisfies readonly ElementType[]
const checks = ['A1', 'A2', 'A3', 'A4', 'A5', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7'] as const satisfies readonly CheckCode[]
type ElementRule = { level: 'required' | 'optional' | 'off'; checks: CheckCode[]; hint: string }
type Profile = {
  version: string
  profiles: Record<DocKey, { name: string; elements: Record<ElementType, ElementRule>; identityElements: ElementType[]; minExpect: Partial<Record<ElementType, number>> }>
  elementTypes: Record<ElementType, string>
  dimensionChecks: Record<CheckCode, string>
  docKeyAlias: Record<DocKey | 'cx', DocKey>
}

const sameKeys = (record: object, keys: readonly string[]) => Object.keys(record).length === keys.length && keys.every(key => Object.hasOwn(record, key))

export function validateProfile(value: unknown): asserts value is Profile {
  const config = value as Profile
  if (!config || !config.version || !sameKeys(config.profiles, docKeys) || !sameKeys(config.elementTypes, elementTypes) || !sameKeys(config.dimensionChecks, checks)
    || config.docKeyAlias.cx !== 'proc' || docKeys.some(key => config.docKeyAlias[key] !== key)) throw new Error('文书 profile 维度或别名错误。')
  for (const key of docKeys) {
    const doc = config.profiles[key]
    if (!doc.name || !sameKeys(doc.elements, elementTypes)) throw new Error(`文书 ${key} 元素配置错误。`)
    const required = elementTypes.filter(type => doc.elements[type].level === 'required')
    if (new Set(doc.identityElements).size !== required.length || doc.identityElements.length !== required.length || !required.every(type => doc.identityElements.includes(type))
      || !Object.entries(doc.minExpect).every(([type, count]) => required.includes(type as ElementType) && Number.isInteger(count) && count > 0)) {
      throw new Error(`文书 ${key} 身份及必拆配置错误。`)
    }
    for (const type of elementTypes) {
      const rule = doc.elements[type]
      if (!['required', 'optional', 'off'].includes(rule.level) || !rule.checks.every(code => checks.includes(code)) || (rule.level === 'off' && rule.checks.length)) {
        throw new Error(`文书 ${key} ${type} 检查配置错误（含 off 约束）。`)
      }
    }
  }
}

const publication: unknown = resource
validateProfile(publication)
export const profile = publication

export function normalizeDocKey(value: unknown): DocKey | undefined {
  if (value === 'cx') return 'proc'
  return docKeys.find(key => key === value)
}

export function verificationChecks(docKey: DocKey | undefined, type: ElementType): CheckCode[] {
  const rule = docKey ? profile.profiles[docKey].elements[type] : undefined
  if (rule?.level === 'off') return []
  const prefix = type === 'E-LAW' ? 'B' : type === 'E-CASE' ? 'C' : undefined
  const automatic = prefix ? checks.filter(code => code.startsWith(prefix)) : []
  return [...new Set([...automatic, ...(rule?.checks ?? [])])]
}
