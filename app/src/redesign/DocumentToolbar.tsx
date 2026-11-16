import type { Editor } from '@tiptap/react'
import { useEditorState } from '@tiptap/react'
import { AlignCenter, AlignJustify, AlignLeft, AlignRight, Bold, IndentDecrease, IndentIncrease, Italic, List, ListOrdered, Redo2, Underline, Undo2 } from 'lucide-react'
import { Button } from './components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './components/ui/select'
import { changeIndent } from './documentExtensions'

export function DocumentToolbar({ editor, disabled }: { editor: Editor; disabled: boolean }) {
  const active = useEditorState({ editor, selector: ({ editor: current }) => ({
    bold: current.isActive('bold'), italic: current.isActive('italic'), underline: current.isActive('underline'),
    bulletList: current.isActive('bulletList'), orderedList: current.isActive('orderedList'),
    heading: current.isActive('heading', { level: 1 }) ? '1' : current.isActive('heading', { level: 2 }) ? '2' : current.isActive('heading', { level: 3 }) ? '3' : 'body',
    align: ['left', 'center', 'right', 'justify'].find(value => current.isActive({ textAlign: value })) || 'left',
    undo: current.can().undo(), redo: current.can().redo(),
  }) })
  const tools = [
    { label: '撤销', icon: Undo2, action: () => editor.chain().focus().undo().run(), disabled: !active.undo },
    { label: '重做', icon: Redo2, action: () => editor.chain().focus().redo().run(), disabled: !active.redo },
    { label: '加粗', icon: Bold, action: () => editor.chain().focus().toggleBold().run(), active: active.bold },
    { label: '斜体', icon: Italic, action: () => editor.chain().focus().toggleItalic().run(), active: active.italic },
    { label: '下划线', icon: Underline, action: () => editor.chain().focus().toggleUnderline().run(), active: active.underline },
    { label: '无序列表', icon: List, action: () => editor.chain().focus().toggleBulletList().run(), active: active.bulletList },
    { label: '编号列表', icon: ListOrdered, action: () => editor.chain().focus().toggleOrderedList().run(), active: active.orderedList },
    ...([['left', '左对齐', AlignLeft], ['center', '居中', AlignCenter], ['right', '右对齐', AlignRight], ['justify', '两端对齐', AlignJustify]] as const)
      .map(([value, label, icon]) => ({ label, icon, action: () => editor.chain().focus().setTextAlign(value).run(), active: active.align === value })),
    { label: '减少缩进', icon: IndentDecrease, action: () => changeIndent(editor, -1) },
    { label: '增加缩进', icon: IndentIncrease, action: () => changeIndent(editor, 1) },
  ]
  return <div className="document-editor-toolbar" role="toolbar" aria-label="文书格式工具栏">
    <Select value={active.heading} disabled={disabled} onValueChange={value => {
      if (value === 'body') editor.chain().focus().setParagraph().run()
      else editor.chain().focus().toggleHeading({ level: Number(value) as 1 | 2 | 3 }).run()
    }}>
      <SelectTrigger aria-label="段落样式"><SelectValue /></SelectTrigger>
      <SelectContent><SelectItem value="body">正文</SelectItem><SelectItem value="1">标题一</SelectItem><SelectItem value="2">标题二</SelectItem><SelectItem value="3">标题三</SelectItem></SelectContent>
    </Select>
    {tools.map(tool => <Button key={tool.label} variant="ghost" size="icon" title={tool.label} aria-label={tool.label}
      aria-pressed={'active' in tool ? Boolean(tool.active) : undefined} disabled={disabled || ('disabled' in tool && tool.disabled)}
      onMouseDown={event => event.preventDefault()} onClick={tool.action}><tool.icon size={16} /></Button>)}
  </div>
}
