import profile from '../../../server/src/intelligence/verification/doc-element-profile.json'
import type { DocKey } from '../types'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './components/ui/select'

const types = Object.entries(profile.profiles)

export function DocumentTypeSelect({ value, onChange, label, disabled }: {
  value?: DocKey
  onChange: (value: DocKey | undefined) => void
  label: string
  disabled?: boolean
}) {
  return <Select value={value ?? 'unclassified'} onValueChange={key => onChange(types.find(([id]) => id === key)?.[0] as DocKey | undefined)} disabled={disabled}>
    <SelectTrigger aria-label={label}><SelectValue /></SelectTrigger>
    <SelectContent>
      <SelectItem value="unclassified">通用核验 · 待分类</SelectItem>
      {types.map(([key, { name }]) => <SelectItem key={key} value={key}>{name}</SelectItem>)}
    </SelectContent>
  </Select>
}
