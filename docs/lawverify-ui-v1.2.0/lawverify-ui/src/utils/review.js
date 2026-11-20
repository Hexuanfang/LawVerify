export const ELEMENTS = {
  'E-SUBJ': ['主体身份', 'A'], 'E-CLAIM': ['诉讼请求', 'B'],
  'E-FACT': ['事实陈述', 'A'], 'E-CALC': ['数额计算', 'AB'],
  'E-EVID': ['证据项', 'A'], 'E-PURP': ['证明目的', 'A'],
  'E-LAW': ['法条引用', 'B'], 'E-CASE': ['案例引用', 'C'],
  'E-FOCUS': ['争议焦点', 'ABC'], 'E-PROC': ['程序事项', 'B'],
  'E-CROSS': ['质证回应', 'AB'], 'E-ERR': ['前审指错', 'AB'],
};

export const STANDARDS = {
  A: ['溯源性', '一致性', '完整性', '边界性', '自洽性'],
  B: ['真实性', '有效性', '准确性', '适配性', '层级性', '遗漏'],
  C: ['真实性', '可回查性', '准确性', '相关性', '效力层级', '时效性', '去重'],
};

export const isRed = (item) => item.verdict === 'fail' || item.verdict === 'miss';
export const isMissing = (item) => item.verdict === 'miss' || item.issue === '缺源';
export const blocksExport = (item) => isRed(item) || item.verdict === 'pending';

export function statusLabel(item) {
  if (isRed(item)) return '不通过·' + (item.issue || (item.verdict === 'miss' ? '缺源' : '矛盾'));
  return { pass: '通过', note: '通过·标注', warn: '预警', pending: '待核验' }[item.verdict];
}

export function paragraphLocation(paper, id) {
  const selector = 'p, li, td, h1, h2, h3';
  const mark = paper?.querySelector('[data-el="' + id + '"]');
  const block = mark?.closest(selector);
  return block ? '第 ' + ([...paper.querySelectorAll(selector)].indexOf(block) + 1) + ' 段' : '正文';
}

export function checksFor(item) {
  const groups = ELEMENTS[item.type]?.[1] || 'A';
  return [...groups].flatMap((group) => STANDARDS[group].map((name, i) => {
    const code = group + (i + 1);
    return { code, name, status: item.checks?.[code] || '未核实' };
  }));
}

export function evaluateEdit(item, text) {
  const clean = text.replace(/[\s,，。；]/g, '');
  const supported = item.verifiedText?.replace(/[\s,，。；]/g, '');
  if (supported && clean === supported && !item.sources.some((source) => source.manual)) {
    return {
      verdict: 'pass', issue: null, diff: null, advice: '', conf: null,
      reason: '修改后的声明与演示出处逐项一致。',
      checks: { ...item.checks, [item.issue === '失效' ? 'B2' : 'A2']: '通过' },
      sources: item.verifiedSources || item.sources.map((source) => ({
        ...source, match: source.match?.filter(([, level]) => level !== 'bad'),
      })),
    };
  }
  if (item.id === 'c1-q4') {
    const date = text.match(/(\d{4})[年.\-/](\d{1,2})[月.\-/](\d{1,2})/);
    const amount = text.match(/([\d,]+)\s*元/);
    const normalized = date && [date[1], date[2].padStart(2, '0'), date[3].padStart(2, '0')].join('-');
    const rows = [];
    if (normalized && normalized !== '2023-04-11') rows.push(['日期', normalized, '2023-04-11']);
    if (amount && amount[1].replaceAll(',', '') !== '35000') rows.push(['金额', amount[0], '35,000 元']);
    if (rows.length) return { verdict: 'fail', issue: '矛盾', conf: null, reason: '日期或金额与演示流水不一致。', checks: { A1: '通过', A2: '不通过' }, diff: { head: ['要素', '文书', '原材料'], rows } };
  }
  return {
    verdict: 'pending', issue: null, conf: null, diff: null, checks: {},
    reason: '这段内容已变更，等待重新核对原文和依据。',
  };
}
