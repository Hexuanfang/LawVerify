import { useEffect, useState } from 'react'
import type { SuperDoc, ToolbarCommandId } from 'superdoc'
import { AlignCenter, AlignJustify, AlignLeft, AlignRight, Bold, IndentDecrease, IndentIncrease, Italic, List, ListOrdered, Redo2, Underline, Undo2 } from 'lucide-react'
import { Button } from './components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './components/ui/select'

const styles = [
  ['Normal', '正文'], ['Heading1', '标题一'], ['Heading2', '标题二'], ['Heading3', '标题三'],
] as const

const formats = [
  { id: 'undo', label: '撤销', icon: Undo2 }, { id: 'redo', label: '重做', icon: Redo2 },
  { id: 'bold', label: '加粗', icon: Bold }, { id: 'italic', label: '斜体', icon: Italic },
  { id: 'underline', label: '下划线', icon: Underline },
  { id: 'bullet-list', label: '无序列表', icon: List }, { id: 'numbered-list', label: '编号列表', icon: ListOrdered },
  { id: 'text-align', value: 'left', label: '左对齐', icon: AlignLeft },
  { id: 'text-align', value: 'center', label: '居中', icon: AlignCenter },
  { id: 'text-align', value: 'right', label: '右对齐', icon: AlignRight },
  { id: 'text-align', value: 'justify', label: '两端对齐', icon: AlignJustify },
  { id: 'indent-decrease', label: '减少缩进', icon: IndentDecrease },
  { id: 'indent-increase', label: '增加缩进', icon: IndentIncrease },
] as const

export function DocumentToolbar({ editor, disabled }: { editor: SuperDoc; disabled: boolean }) {
  const toolbar = editor.ui.toolbar
  const [snapshot, setSnapshot] = useState(() => toolbar.getSnapshot())
  useEffect(() => toolbar.observe(setSnapshot), [toolbar])
  const linkedStyle = snapshot.commands['linked-style']
  const value = linkedStyle?.value
  const style = value && typeof value === 'object' && 'styleId' in value ? value.styleId : value
  const runCommand = async (command: ToolbarCommandId, value?: string) => {
    await toolbar.executeAsync(command, value)
    editor.activeEditor?.focus?.()
  }
  return <div className="document-editor-toolbar" role="toolbar" aria-label="文书格式工具栏">
    <Select value={styles.find(([id]) => id === style)?.[0] ?? ''} disabled={disabled || !linkedStyle?.enabled}
      onValueChange={value => { void runCommand('linked-style', value) }}>
      <SelectTrigger aria-label="段落样式"><SelectValue placeholder="段落样式" /></SelectTrigger>
      <SelectContent>{styles.map(([id, label]) => <SelectItem key={id} value={id}>{label}</SelectItem>)}</SelectContent>
    </Select>
    {formats.map(tool => {
      const state = snapshot.commands[tool.id]
      const value = 'value' in tool ? tool.value : undefined
      return <Button key={tool.label} variant="ghost" size="icon" title={tool.label} aria-label={tool.label}
        aria-pressed={value ? state?.value === value : state?.active}
        disabled={disabled || !state?.enabled} onMouseDown={event => event.preventDefault()}
        onClick={() => { void runCommand(tool.id, value) }}><tool.icon size={16} /></Button>
    })}
  </div>
}
