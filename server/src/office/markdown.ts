import type { CertificateParagraph } from '../domain.js'

function escapeHtml(text: string) {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function tableCells(line: string) {
  return line.trim().replace(/^\||(?<!\\)\|$/gu, '').split(/(?<!\\)\|/u).map(cell => cell.trim().replaceAll('\\|', '|'))
}

function markdownTable(text: string, separator?: string) {
  const rows = text.split('\n').map(row => row.split('\t'))
  const asLine = (cells: string[]) => `| ${cells.map(cell => cell.replaceAll('|', '\\|')).join(' | ')} |`
  return [asLine(rows[0]), separator ?? asLine(rows[0].map(() => '---')), ...rows.slice(1).map(asLine)].join('\n')
}

export function markdownBlocks(source: string) {
  const blocks: Array<{ text: string; richText: string; start: number; end: number;
    table?: { separator: string; leading: string; trailing: string } }> = []
  const lines = source.split('\n')
  const heading = (line: string) => /^ {0,3}(#{1,6})[ \t]+(?=\S)/u.exec(line)
  const fence = (line: string) => /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line)
  const table = (index: number) => {
    const separator = lines[index + 1]
    if (!lines[index]?.includes('|') || !separator?.includes('|')) return false
    const columns = tableCells(separator)
    return columns.every(cell => /^:?-{3,}:?$/u.test(cell)) && tableCells(lines[index]).length === columns.length
  }
  const offsets: number[] = [0]
  for (const line of lines) offsets.push(offsets[offsets.length - 1] + line.length + 1)
  for (let index = 0; index < lines.length;) {
    if (!lines[index].trim()) { index++; continue }
    const first = index++
    const title = heading(lines[first])
    const marker = fence(lines[first])?.[1]
    let tag = title ? `h${title[1].length}` : 'p'
    if (marker) {
      tag = 'pre'
      while (index < lines.length) {
        const closing = fence(lines[index++])
        if (closing && closing[1][0] === marker[0] && closing[1].length >= marker.length && !closing[2].trim()) break
      }
    } else if (table(first)) {
      const header = tableCells(lines[first])
      const rows = [header]
      index++
      while (index < lines.length && lines[index].includes('|') && !heading(lines[index]) && !fence(lines[index])) {
        const cells = tableCells(lines[index++])
        rows.push(header.map((_, column) => cells[column] ?? ''))
      }
      const cells = rows.map(row => row.join('\t')).join('\n')
      const text = cells.trim()
      if (text) {
        const body = rows.map((row, rowIndex) => {
          const cell = rowIndex ? 'td' : 'th'
          return `<tr>${row.map(value => `<${cell}><p>${escapeHtml(value)}</p></${cell}>`).join('')}</tr>`
        }).join('')
        const leading = cells.length - cells.trimStart().length
        blocks.push({ text, richText: `<table><tbody>${body}</tbody></table>`, start: offsets[first],
          end: offsets[index] - 1, table: { separator: lines[first + 1], leading: cells.slice(0, leading),
            trailing: cells.slice(leading + text.length) } })
        continue
      }
    } else if (!title) {
      while (index < lines.length && lines[index].trim() && !heading(lines[index]) && !fence(lines[index]) && !table(index)) index++
    }
    const start = offsets[first] + (title?.[0].length ?? (lines[first].length - lines[first].trimStart().length))
    const raw = source.slice(start, offsets[index] - 1)
    const end = start + (title ? raw.replace(/[ \t]+#+[ \t]*$/u, '') : raw).trimEnd().length
    const text = source.slice(start, end)
    const html = escapeHtml(text)
    const contents = tag === 'pre' ? `<code>${html}</code>` : html.replaceAll('\n', '<br>')
    blocks.push({ text, richText: `<${tag}>${contents}</${tag}>`, start, end })
  }
  return blocks
}

export function patchMarkdown(source: string, before: CertificateParagraph[], after: CertificateParagraph[]) {
  const newline = source.includes('\r\n') ? '\r\n' : '\n'
  const normalized = source.replace(/\r\n?/gu, '\n')
  const blocks = markdownBlocks(normalized)
  if (blocks.length !== before.length || before.length !== after.length
    || before.some((item, index) => item.id !== after[index].id || item.text !== blocks[index].text)) {
    const fallback = after.map(item => {
      const heading = /^<h([1-6])(?:\s|>)/iu.exec(item.richText ?? '')
      if (heading) return `${'#'.repeat(Number(heading[1]))} ${item.text}`
      return /^<table(?:\s|>)/iu.test(item.richText ?? '') ? markdownTable(item.text) : item.text
    }).join('\n\n')
    return newline === '\n' ? fallback : fallback.replaceAll('\n', newline)
  }
  let offset = 0
  const result = blocks.map(({ start, end, text, table }, index) => {
    const edited = after[index].text
    const replacement = edited === text ? normalized.slice(start, end)
      : table ? markdownTable(table.leading + edited + table.trailing, table.separator) : edited
    const value = normalized.slice(offset, start) + replacement
    offset = end
    return value
  }).join('') + normalized.slice(offset)
  return newline === '\n' ? result : result.replaceAll('\n', newline)
}
