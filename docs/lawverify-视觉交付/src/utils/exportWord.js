import {
  CommentRangeEnd, CommentRangeStart, CommentReference, Document, HeadingLevel,
  Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType,
} from 'docx';
import { blocksExport, statusLabel } from './review.js';

const p = (text, options = {}) => new Paragraph({ text, ...options });

export async function exportWord({ title, body, items, report, review }) {
  if (items.some(blocksExport) || !body?.textContent.trim()) throw new Error('存在未完成的核验或缺少正文');
  const byId = new Map(items.map((item) => [item.id, item]));
  const comments = [];
  const childrenOf = (element) => [...element.childNodes].flatMap((node) => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ? [new TextRun(node.textContent)] : [];
    if (node.nodeType !== Node.ELEMENT_NODE) return [];
    if (node.matches('br')) return [new TextRun({ break: 1 })];
    const item = byId.get(node.dataset.el);
    const content = node.matches('strong, b') ? [new TextRun({ text: node.textContent, bold: true })] : childrenOf(node);
    if (!item || !review || (item.verdict === 'pass' && !item.note)) return content;
    const id = comments.length;
    const sources = item.sources.map((source) => source.name + ' · ' + source.loc).join('、');
    comments.push({ id, author: 'LawVerify', children: [p([statusLabel(item), item.reason, sources, item.note].filter(Boolean).join('｜'))] });
    return [new CommentRangeStart(id), ...content, new CommentRangeEnd(id), new TextRun({ children: [new CommentReference(id)] })];
  });
  const blocksOf = (element) => [...element.children].flatMap((node) => {
    if (node.matches('table')) {
      return [new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [...node.rows].map((row) =>
        new TableRow({ children: [...row.cells].map((cell) => new TableCell({ children: [new Paragraph({ children: childrenOf(cell) })] })) })) })];
    }
    if (node.matches('h1, h2, h3, p, li')) {
      const heading = { H1: HeadingLevel.TITLE, H2: HeadingLevel.HEADING_1, H3: HeadingLevel.HEADING_2 }[node.tagName];
      return [new Paragraph({ children: childrenOf(node), heading })];
    }
    return blocksOf(node);
  });
  const children = blocksOf(body);
  if (!review) {
    children.push(p('质证联动核验报告', { heading: HeadingLevel.HEADING_1, pageBreakBefore: true }));
    children.push(...report.map((line) => p(line)));
  }
  const output = new Document({ title, comments: { children: comments }, sections: [{ children }] });
  const url = URL.createObjectURL(await Packer.toBlob(output));
  const link = document.createElement('a');
  link.href = url;
  link.download = (review ? '审阅版-' : '清洁版与核验报告-') + title.replace(/[\\/:*?"<>|]/g, '_') + '.docx';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
