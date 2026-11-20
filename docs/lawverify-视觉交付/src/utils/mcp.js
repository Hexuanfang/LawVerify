// 演示用 MCP 适配层：独立 HTML 未接真实服务。
// 生产环境按 PRD《AI 助手与 MCP 接入》替换为真实 legal_statute / legal_case。
import { LAW_LIB, CASE_LIB } from '../data/lib.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hit = (text, terms) => terms.filter(Boolean).some((term) => text.includes(term));

function toCn(num) {
  const d = '零一二三四五六七八九';
  if (num <= 10) return ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'][num];
  if (num < 20) return '十' + d[num % 10];
  if (num < 100) return d[Math.floor(num / 10)] + '十' + (num % 10 ? d[num % 10] : '');
  if (num < 1000) return d[Math.floor(num / 100)] + '百' + (num % 100 >= 10 ? toCn(num % 100) : (num % 100 ? '零' + d[num % 100] : ''));
  return String(num);
}

function scoreText(hay, query) {
  const a = String(hay).toLowerCase().replace(/\s/g, '');
  const q = String(query).toLowerCase().replace(/\s/g, '');
  if (!q) return 0;
  if (a.includes(q)) return 10 + q.length;
  let score = 0;
  for (let i = 0; i < q.length - 1; i++) {
    if (a.includes(q.slice(i, i + 2))) score += 1;
  }
  const nums = String(query).match(/\d{1,4}/g) || [];
  for (const n of nums) {
    const cn = toCn(Number(n));
    if (cn && a.includes(cn)) score += 4;
    if (a.includes(n)) score += 3;
  }
  return score;
}

function statuteRecord(law) {
  return {
    id: law.id,
    law_name: law.name,
    article_number: law.art,
    title: law.name + ' ' + law.art,
    validity: law.st,
    effective_date: law.date,
    publish_no: law.no,
    gist: law.gist,
    text: law.text || law.gist,
    url: 'https://flk.npc.gov.cn', // 演示锚点，生产取国家法律法规数据库真实 url
    source: 'legal_statute@demo',
  };
}

function caseRecord(item) {
  return {
    id: item.id,
    case_number: item.no,
    title: item.name,
    court: item.court,
    judgment_date: item.date,
    level: item.lv,
    gist: item.gist,
    doc_type: '判决书',
    url: 'https://wenshu.court.gov.cn', // 演示锚点，生产取裁判文书网/三库真实 url
    source: 'legal_case@demo',
  };
}

/**
 * 模拟 legal_statute：semantic / article_detail
 * 真实接入时 action/参数与 AutoClaw legal_statute 保持一致。
 */
export async function callLegalStatute({ query = '', law_name = '', article_number = '' } = {}) {
  await sleep(420);
  const terms = [law_name, article_number, ...String(query).split(/\s+/)].filter(Boolean);
  const scored = LAW_LIB.map((law) => {
    const hay = [law.name, law.art, law.gist, law.text || '', law.st].join(' ');
    const score = Math.max(
      scoreText(hay, query),
      terms.reduce((sum, term) => sum + (hay.includes(term) ? (term.length >= 4 ? 3 : 1) : 0), 0),
    );
    return { law, score };
  }).filter((row) => row.score > 0).sort((a, b) => b.score - a.score);
  return {
    ok: true,
    tool: 'legal_statute',
    action: query && !law_name ? 'semantic' : 'article_detail',
    query,
    latency: 420,
    results: scored.slice(0, 5).map(({ law }) => statuteRecord(law)),
    empty: scored.length === 0,
    note: '演示库仅含本文书已引条目；生产环境接国家法律法规数据库权威锚。',
  };
}

/**
 * 模拟 legal_case：semantic / keyword / detail
 */
export async function callLegalCase({ query = '', case_number = '', authoritative = false } = {}) {
  await sleep(520);
  const terms = [case_number, ...String(query).split(/\s+/)].filter(Boolean);
  const scored = CASE_LIB.map((item) => {
    const hay = [item.no, item.name, item.court, item.gist, item.lv].join(' ');
    const score = Math.max(
      scoreText(hay, query),
      terms.reduce((sum, term) => sum + (hay.includes(term) ? (term.length >= 4 ? 3 : 1) : 0), 0),
    );
    return { item, score };
  }).filter((row) => row.score > 0).sort((a, b) => b.score - a.score);
  return {
    ok: true,
    tool: 'legal_case',
    action: case_number ? 'detail' : 'semantic',
    query,
    authoritative,
    latency: 520,
    results: scored.slice(0, 5).map(({ item }) => caseRecord(item)),
    empty: scored.length === 0,
    note: '演示库仅含示例案例；生产环境三源并行（元典/威科/北大法宝），案号归一化后取全文。',
  };
}

export function mcpUnavailable(tool) {
  return {
    ok: false,
    tool,
    results: [],
    empty: true,
    note: '独立 HTML 未接入 MCP 服务。生产环境由 legal_statute / legal_case 提供实时检索。',
  };
}

export const MCP_META = {
  legal_statute: {
    name: 'legal_statute',
    label: '法条 MCP',
    icon: '📖',
    desc: '查询中国法律法规与法条；引用前核对原文与效力。',
    actions: ['semantic', 'search_article', 'search_regulation', 'article_detail', 'regulation_detail'],
  },
  legal_case: {
    name: 'legal_case',
    label: '案例 MCP',
    icon: '⚖️',
    desc: '查询中国司法裁判案例；引用判项前必须 detail 核对全文。',
    actions: ['semantic', 'keyword', 'detail'],
  },
};
