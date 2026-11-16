import { Extension, Node, mergeAttributes, type Editor } from '@tiptap/core'
import { Plugin } from '@tiptap/pm/state'
import StarterKit from '@tiptap/starter-kit'
import TextAlign from '@tiptap/extension-text-align'

const blockTypes = ['paragraph', 'heading', 'blockquote', 'bulletList', 'orderedList', 'table', 'image', 'horizontalRule', 'codeBlock']

const documentAttributes = Extension.create({
  name: 'lawverifyDocumentAttributes',
  addGlobalAttributes() {
    return [{ types: [...blockTypes, 'tableRow', 'tableCell', 'tableHeader', 'listItem'], attributes: {
      documentId: {
        default: null,
        parseHTML: element => element.getAttribute('data-lawverify-id'),
        renderHTML: attributes => attributes.documentId ? { 'data-lawverify-id': attributes.documentId } : {},
      },
      style: {
        default: null,
        parseHTML: element => {
          const clone = element.cloneNode(false) as HTMLElement
          if (['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'].includes(clone.tagName)) clone.style.removeProperty('text-align')
          if (clone.hasAttribute('data-indent')) clone.style.removeProperty('margin-left')
          return clone.getAttribute('style') || null
        },
        renderHTML: attributes => attributes.style ? { style: attributes.style } : {},
      },
      indent: {
        default: 0,
        parseHTML: element => Number(element.getAttribute('data-indent')) || 0,
        renderHTML: attributes => attributes.indent ? { 'data-indent': attributes.indent, style: `margin-left:${attributes.indent * 2}em` } : {},
      },
    } }]
  },
  addProseMirrorPlugins() {
    return [new Plugin({
      appendTransaction(transactions, _old, state) {
        if (!transactions.some(transaction => transaction.docChanged)) return null
        const seen = new Set<string>()
        const transaction = state.tr
        state.doc.forEach((node, offset) => {
          let id = node.attrs.documentId as string | null
          if (!id || seen.has(id)) {
            id = crypto.randomUUID()
            transaction.setNodeMarkup(offset, undefined, { ...node.attrs, documentId: id })
          }
          seen.add(id)
        })
        return transaction.docChanged ? transaction : null
      },
    })]
  },
})

// 复用现有依赖保留导入的表格、合并单元格及图片。
const tableNodes = [
  Node.create({ name: 'table', group: 'block', content: 'tableRow+', isolating: true,
    parseHTML: () => [{ tag: 'table' }], renderHTML: ({ HTMLAttributes }) => ['table', HTMLAttributes, ['tbody', 0]] }),
  Node.create({ name: 'tableRow', content: '(tableCell|tableHeader)+',
    parseHTML: () => [{ tag: 'tr' }], renderHTML: ({ HTMLAttributes }) => ['tr', HTMLAttributes, 0] }),
  ...['tableCell', 'tableHeader'].map((name, index) => Node.create({ name, content: 'block+', isolating: true,
    addAttributes: () => ({ colspan: { default: 1 }, rowspan: { default: 1 } }),
    parseHTML: () => [{ tag: index ? 'th' : 'td' }], renderHTML: ({ HTMLAttributes }) => [index ? 'th' : 'td', HTMLAttributes, 0] })),
  Node.create({ name: 'image', group: 'block', atom: true,
    addAttributes: () => ({ src: { default: '' }, alt: { default: '' }, width: { default: null }, height: { default: null } }),
    parseHTML: () => [{ tag: 'img[src]' }], renderHTML: ({ HTMLAttributes }) => ['img', mergeAttributes(HTMLAttributes)] }),
]

export function documentExtensions() {
  return [StarterKit, TextAlign.configure({ types: ['heading', 'paragraph'] }), documentAttributes, ...tableNodes]
}

export function changeIndent(editor: Editor, direction: 1 | -1) {
  if (editor.isActive('listItem')) {
    return direction > 0 ? editor.chain().focus().sinkListItem('listItem').run() : editor.chain().focus().liftListItem('listItem').run()
  }
  editor.chain().focus().command(({ tr, state }) => {
    state.doc.nodesBetween(state.selection.from, state.selection.to, (node, position) => {
      if (node.type.name === 'paragraph' || node.type.name === 'heading') {
        tr.setNodeMarkup(position, undefined, { ...node.attrs, indent: Math.max(0, Math.min(8, (node.attrs.indent || 0) + direction)) })
      }
    })
    return true
  }).run()
}
