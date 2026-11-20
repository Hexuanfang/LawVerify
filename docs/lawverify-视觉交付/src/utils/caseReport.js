import { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from 'docx';
import { SRCN } from '../store/AppStore.jsx';

const p = (text, options = {}) => new Paragraph({ text, ...options });
const h = (text, level) => new Paragraph({ text, heading: level });

/**
 * 案例检索报告：把当前文书引用的 L3 案例（可含 MCP 补充）打包为可归档 Word。
 * items: 当前文书核验元素；extra: 助手本次 MCP 命中但未入正文的案例。
 */
export async function exportCaseReport({ caseName, docTitle, items, extra = [], lawyer = '' }) {
  const cited = [];
  const seen = new Set();
  const push = (row) => {
    const key = row.case_number || row.title;
    if (!key || seen.has(key)) return;
    seen.add(key);
    cited.push(row);
  };
  items.filter((item) => item.src === 'l3' || item.type === 'E-CASE' || item.sources.some((source) => source.st === 'l3'))
    .forEach((item) => {
      const source = item.sources.find((source) => source.st === 'l3') || {};
      push({
        case_number: source.name || item.quote.match(/（\d{4}）[^，。；\s]+号/)?.[0] || '',
        title: source.name || '卷内引用案例',
        court: source.loc?.split('·')?.[0]?.trim() || '',
        judgment_date: '',
        gist: source.excerpt || item.quote,
        level: source.match?.some(([, level]) => level === 'ok') ? '卷内命中' : '待核对',
        from: item.id,
        quote: item.quote,
        status: item.verdict,
        loc: source.loc || '',
      });
    });
  extra.forEach(push);

  const children = [
    h('案例检索报告', HeadingLevel.TITLE),
    p('LawVerify · 文书 AI 智能证据联动 ｜ 原型 v1.2 · 示例引用'),
    p(''),
    h('一、检索任务', HeadingLevel.HEADING_1),
    p(`案件：${caseName || '—'}`),
    p(`文书：${docTitle || '—'}`),
    p(`代理律师：${lawyer || '—'}`),
    p(`生成时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`),
    p('检索口径：文书内 E-CASE / L3 出处 + 助手本次 legal_case 命中；缺源不编造，三库查无只列待核。'),
    p(''),
    h('二、检索结果概览', HeadingLevel.HEADING_1),
    p(`共收录案例 ${cited.length} 件。其中卷内已联动 ${items.filter((item) => item.src === 'l3').length} 条声明，MCP 补充 ${extra.length} 件。`),
    p(''),
    h('三、案例清单', HeadingLevel.HEADING_1),
  ];

  if (!cited.length) {
    children.push(p('本文书暂无可回查的 L3 案例引用。可在 AI 助手使用「案例 MCP」检索后一键生成。'));
  } else {
    const table = new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [
        new TableRow({
          children: ['序号', '案号', '案件名称', '法院', '效力/命中', '文书状态'].map((text) =>
            new TableCell({ children: [new Paragraph({ text, children: [new TextRun({ text, bold: true })] })] })),
        }),
        ...cited.map((row, i) => new TableRow({
          children: [String(i + 1), row.case_number, row.title, row.court, row.level, SRCN[row.status] || row.status]
            .map((text) => new TableCell({ children: [new Paragraph({ text: String(text || '—') })] })),
        })),
      ],
    });
    children.push(table);
    children.push(p(''));
    children.push(h('四、逐案摘录', HeadingLevel.HEADING_1));
    cited.forEach((row, i) => {
      children.push(h(`${i + 1}. ${row.title}${row.case_number ? '（' + row.case_number + '）' : ''}`, HeadingLevel.HEADING_2));
      children.push(p(`审理法院：${row.court || '—'}　裁判日期：${row.judgment_date || '—'}　效力层级：${row.level || '—'}`));
      children.push(p(`文书定位：${row.loc || row.from || '—'}`));
      children.push(p('裁判要旨 / 卷内摘录：'));
      children.push(p(row.gist || row.quote || '—'));
      if (row.quote && row.quote !== row.gist) children.push(p('文书原文：' + row.quote));
      children.push(p(''));
    });
  }

  children.push(h('五、核验声明', HeadingLevel.HEADING_1));
  children.push(p('本报告由 LawVerify 汇编，案例原文以官方裁判文书库为准。演示环境未接入实时三源检索，命中结果来自示例库。'));
  children.push(p('AI 仅辅助，最终责任在律师。缺源不编造：未命中不展示猜的出处。'));
  children.push(p('库版本：原型示例库 2026-11-06 快照。'));

  const output = new Document({
    title: '案例检索报告-' + (docTitle || caseName || '文书'),
    sections: [{ children }],
  });
  const url = URL.createObjectURL(await Packer.toBlob(output));
  const link = document.createElement('a');
  link.href = url;
  link.download = '案例检索报告-' + String(docTitle || caseName || '文书').replace(/[\\/:*?"<>|]/g, '_') + '.docx';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return cited.length;
}
