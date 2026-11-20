import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { extractDeclarations } from '../../src/intelligence/verification/extract.ts';
import * as evidenceVerification from '../../src/intelligence/verification/evidence.ts';

function verify(docKey, paragraphs, evidences = [], evidenceFragments = [], evidenceInsights = []) {
  const document = { id: 'doc', caseId: 'case', docKey, paragraphs: paragraphs.map((value, index) => ({ id: `p${index}`, ...value })) };
  return evidenceVerification.verifyEvidenceDeclarations(document, extractDeclarations(document).declarations, { evidences, evidenceFragments, evidenceInsights });
}

const evidence = (name, ocrText) => ({ id: 'ev', caseId: 'case', name, fileName: name, ocrText });
const readSeed = async file => JSON.parse(await readFile(new URL(`./fixtures/seed/${file}.json`, import.meta.url), 'utf8'));

test('旧句级链接的索引与原句不一致时，不把前一句的付款出处挂给后一句', () => {
  const first = '被告于2023年4月11日支付利息35,000元。';
  const second = '原告于2023年4月12日发送催告。';
  const link = { evidenceId: 'ev', locator: '付款凭证', quote: first, sentenceIndex: 1, sentenceText: first, relation: 'support' };
  const found = verify('qs', [{ text: first + second, link }], [evidence('付款凭证', first)]).find(item => item.quote === second);
  assert.equal(found.verdict, 'miss');
  assert.deepEqual(found.sources, []);
});

test('后续未付款或其他主体付款，不构成此前未再付款声明的反证', () => {
  const first = '被告自2023年4月1日后未再付款。';
  for (const later of ['被告于2023年4月11日没有支付利息。', '原告于2023年4月11日支付利息35,000元。']) {
    const found = verify('qs', [{ text: first }, { text: later }]).find(item => item.quote === first);
    assert.ok(found);
    assert.notEqual(found.checks.A5?.outcome, 'fail');
  }
});

test('无原文、同名异期资料不得伪造联动；已定位的金额冲突保留差异', () => {
  const text = '被告于2023年4月1日支付利息30,000元。';
  const correct = '被告于2023年4月11日支付利息35,000元。';
  const links = [{ evidenceId: 'ev', quote: correct, locator: '实际行', relation: 'contradict' }];
  const [missing] = verify('qs', [{ text, links }], [evidence('流水', '被告于2023年3月支付35,000元。')]);
  assert.equal(missing.verdict, 'miss');
  assert.deepEqual(missing.sources, []);
  const [conflict] = verify('qs', [{ text, links }], [evidence('流水', correct)]);
  assert.equal(conflict.verdict, 'fail');
  assert.equal(conflict.checks.A2.outcome, 'fail');
  assert.deepEqual(conflict.differences.map(item => item.field), ['日期', '金额']);
});

test('证据清单缺源、证明目的越界、未定位前审指错和前审反转分流', () => {
  const list = verify('zj', [{ text: '微信截图\t证明对方构成欺诈。\n公证书\t证明催告。' }], [evidence('微信截图', '钱我认，再宽限两个月。')]);
  assert.equal(list.find(item => item.quote.includes('欺诈')).checks.A4.outcome, 'fail');
  assert.equal(list.find(item => item.quote === '公证书').verdict, 'miss');
  assert.equal(verify('ss', [{ text: '一审认定事实错误。' }])[0].verdict, 'miss');
  const judgment = '被告已支付35,000元利息。';
  const entry = { text: '一审认定被告分文未付。', links: [{ evidenceId: 'ev', quote: judgment, locator: '本院查明' }] };
  assert.deepEqual(verify('ss', [entry], [evidence('一审判决书', judgment)], [{ evidenceId: 'ev', locator: '第1页', text: judgment }])[0].sources, []);
  const [reversed] = verify('ss', [entry], [evidence('一审判决书', judgment)], [{ evidenceId: 'ev', locator: '本院查明', text: judgment }]);
  assert.equal(reversed.checks.A2.outcome, 'fail');
});

test('先识别前后自相矛盾；材料支持的利息才生成完整算式', () => {
  const results = verify('qs', [{ text: '被告自2023年4月1日后未再支付。' }, { text: '被告于2023年4月11日支付利息35,000元。' }]);
  assert.ok(results.some(item => item.checks.A5?.outcome === 'fail'));
  const formula = '利息按10000元×10%×365天÷365计算。';
  const link = { evidenceId: 'ev', quote: formula, locator: '利息条款', relation: 'support' };
  const calculation = verify('qs', [{ text: formula, links: [link] }], [evidence('借条', formula)]).find(item => item.type === 'E-CALC');
  assert.deepEqual(calculation.calculation, { kind: 'simple-interest', principal: 10000, rate: 0.1, days: 365, annualDays: 365, amount: 1000,
    sources: calculation.sources });
  assert.equal(verify('qs', [{ text: formula, links: [link] }], [evidence('借条', '本金10000元')]).find(item => item.type === 'E-CALC').verdict, 'warn');
});

test('公式支持但正文计息结果错误时阻断，并显示复算差异', () => {
  const formula = '利息按10000元×10%×365天÷365计算';
  const source = `${formula}，合计1000元。`;
  const links = [{ evidenceId: 'ev', quote: source, locator: '结算记录', relation: 'support' }];
  const result = verify('qs', [{ text: `${formula}，合计900元。`, links, verified: true }], [evidence('流水', source)]).find(item => item.type === 'E-CALC');
  assert.equal(result.verdict, 'fail');
  assert.equal(result.checks.A2.outcome, 'fail');
  assert.equal(result.calculation.amount, 1000);
  assert.deepEqual(result.differences, [{ field: '计息结果', document: '900元', source: '1000元' }]);
});

test('不能把标注为反证的材料当作计息输入的支持来源', () => {
  const formula = '利息按10000元×10%×365天÷365计算。';
  const links = [{ evidenceId: 'ev', quote: formula, locator: '相反意见', relation: 'contradict' }];
  const result = verify('qs', [{ text: formula, links }], [evidence('对方说明', formula)]).find(item => item.type === 'E-CALC');
  assert.equal(result.verdict, 'fail');
  assert.equal(result.calculation, undefined);
});

test('证据清单反查漏列，忽略底稿、重复件、未解析件和跨案材料，不伪造正文声明', () => {
  const materials = [
    { ...evidence('借条', '借款本金'), id: 'listed' },
    { ...evidence('银行流水', '当日转账'), id: 'omitted' },
    { ...evidence('原告身份证.jpg', '居民身份证'), id: 'identity', sourceFingerprint: 'id-v1' },
    { ...evidence('重复流水', '当日转账'), id: 'duplicate', duplicateOf: 'omitted' },
    { ...evidence('草稿', '工作笔记'), id: 'draft' },
    { ...evidence('未知材料', '尚待分类'), id: 'unknown' },
    { ...evidence('其他案件凭证', '他案付款'), id: 'other-case', caseId: 'other' },
    { ...evidence('未完成OCR', ''), id: 'unparsed', parsing: { status: 'processing' } },
  ];
  const insights = materials.filter(item => !['unknown', 'listed'].includes(item.id)).map(item => ({ evidenceId: item.id, status: 'ready',
    materialRole: item.id === 'draft' ? 'working_draft' : item.id === 'identity' ? 'identity' : 'source_evidence' }));
  const nearby = [{ evidenceId: 'omitted', locator: '第 1 行', text: '当日转账' }];
  const inspect = (text, verified = true) => {
    const doc = { id: 'doc', caseId: 'case', docKey: 'zj', paragraphs: [{ id: 'p', text, verified }] };
    return evidenceVerification.verifyEvidence(doc, extractDeclarations(doc).declarations, { evidences: materials, evidenceFragments: nearby, evidenceInsights: insights });
  };
  const { declarations: rows, documentDiagnostics } = inspect('借条\n不在卷内的公证书');
  assert.equal(rows.length, 2);
  const listed = rows.find(item => item.quote === '借条');
  assert.equal(listed.verdict, 'pass');
  assert.equal(listed.checks.A3.outcome, 'pass');
  assert.deepEqual(listed.sources.map(item => item.id), ['listed']);
  assert.equal(rows.find(item => item.quote.includes('公证书')).verdict, 'miss');
  assert.equal(documentDiagnostics.length, 1);
  assert.equal(documentDiagnostics[0].code, 'A3');
  assert.equal(documentDiagnostics[0].verdict, 'warn');
  assert.deepEqual(documentDiagnostics[0].sources.map(({ id, name, locator, version }) => [id, name, locator, version]), [
    ['omitted', '银行流水', '第 1 行', undefined], ['identity', '原告身份证.jpg', '材料全文', 'id-v1'],
  ]);
  const { declarations: [unreviewed] } = inspect('借条', false);
  assert.equal(unreviewed.verdict, 'pending');
  assert.equal(unreviewed.checks.A3.outcome, 'pass');
  for (const text of ['不在卷内的公证书', '证据清单']) {
    const result = inspect(text);
    assert.ok(result.declarations.every(item => item.verdict === 'miss'));
    assert.deepEqual(result.documentDiagnostics, documentDiagnostics);
  }
  assert.deepEqual(inspect('借条\n银行流水\n原告身份证.jpg').documentDiagnostics, []);
});

test('前审指错只接受已定位的前审材料，不能把普通凭证展示为 L1', () => {
  const text = '一审认定被告分文未付。';
  const quote = '被告已支付35,000元利息。';
  const [result] = verify('ss', [{ text, links: [{ evidenceId: 'ev', locator: '第1页', quote, relation: 'context' }] }],
    [evidence('付款凭证', quote)], [{ evidenceId: 'ev', locator: '第1页', text: quote }]);
  assert.equal(result.verdict, 'miss');
  assert.equal(result.checks.A1.outcome, 'miss');
  assert.deepEqual(result.sources, []);
});

test('未带句锚的旧链接只能保留在能与原文直接对齐的句子上', () => {
  const first = '被告于2023年4月11日支付利息35,000元。';
  const second = '被告名下另有房产两套。';
  const link = { evidenceId: 'ev', locator: '第 1 段', quote: first, relation: 'support' };
  const results = verify('qs', [{ text: first + second, verified: true, link }], [evidence('银行流水', first)]);
  assert.ok(results.find(item => item.quote === first).sources.length);
  const unrelated = results.find(item => item.quote === second);
  assert.equal(unrelated.verdict, 'miss');
  assert.deepEqual(unrelated.sources, []);
  const repeated = verify('qs', [{ text: first + first, verified: true, link }], [evidence('银行流水', first)]);
  assert.equal(repeated.length, 2);
  assert.ok(repeated.every(item => item.verdict === 'miss' && !item.sources.length));
});

test('旧链接不得用已替换材料或其他主体、期次的片段补位', () => {
  const text = '被告已支付第2期利息35,000元。';
  for (const quote of ['原告已支付第2期利息35,000元。', '被告已支付第1期利息35,000元。']) {
    const links = [{ evidenceId: 'ev', locator: '第1行', quote, relation: 'support', sentenceIndex: 0, sentenceText: text }];
    const [result] = verify('qs', [{ text, links, verified: true }], [evidence('付款凭证', quote)]);
    assert.equal(result.verdict, 'miss');
    assert.deepEqual(result.sources, []);
  }
  const links = [{ evidenceId: 'ev', locator: '第1行', quote: text, relation: 'support', sentenceIndex: 0, sentenceText: text }];
  const [result] = verify('qs', [{ text, links, verified: true }], [evidence('付款凭证', '被告已支付第3期利息35,000元。')]);
  assert.equal(result.verdict, 'miss');
  assert.deepEqual(result.sources, []);
  const quote = '被告已支付第3期利息35,000元。';
  const [inapplicable] = verify('qs', [{ text, links: [{ ...links[0], quote, relation: 'contradict' }] }], [evidence('付款凭证', quote)]);
  assert.equal(inapplicable.verdict, 'miss');
  assert.deepEqual(inapplicable.sources, []);
});

test('同一笔付款有原文反证时输出四项差异，签收信息不足时提示按原文改写', () => {
  const text = '被告于2023年4月1日支付利息30,000元。';
  const other = '原告于2023年4月11日支付本金35,000元。';
  const link = { evidenceId: 'ev', locator: '付款记录', quote: other, relation: 'contradict' };
  const [conflict] = verify('qs', [{ text, link }], [evidence('流水', other)]);
  assert.equal(conflict.verdict, 'fail');
  assert.equal(conflict.checks.A2.outcome, 'fail');
  assert.deepEqual(conflict.differences.map(item => item.field), ['日期', '金额', '主体', '性质']);

  const receipt = '2024年4月12日，仓库管理员刘某签收。';
  const [unconfirmed] = verify('qs', [{ text: '2024年4月12日，被告法定代表人亲自签收。', verified: true,
    link: { evidenceId: 'ev', locator: '签收栏', quote: receipt, relation: 'support' } }], [evidence('送货单', receipt)]);
  assert.equal(unconfirmed.verdict, 'warn');
  assert.equal(unconfirmed.checks.A2.outcome, 'warn');
  assert.match(unconfirmed.reason, /仓库管理员刘某签收/u);

  const receiptWithoutDate = '被告支付利息30,000元。';
  const [partial] = verify('qs', [{ text, verified: true, link: { ...link, quote: receiptWithoutDate, relation: 'support' } }],
    [evidence('流水', receiptWithoutDate)]);
  assert.equal(partial.verdict, 'warn');
  assert.equal(partial.checks.A1.outcome, 'warn');
  assert.match(partial.checks.A2.reason, /日期待核实.*金额一致.*主体一致.*性质一致/u);
});

test('原审责任性质被反转时输出原文差异', () => {
  const text = '原审判项认定甲公司承担连带责任。';
  const quote = '甲公司承担补充责任。';
  const [result] = verify('ss', [{ text, links: [{ evidenceId: 'ev', locator: '判项第一项', quote }] }],
    [evidence('一审判决书', quote)], [{ evidenceId: 'ev', locator: '判项第一项', text: quote }]);
  assert.equal(result.verdict, 'fail');
  assert.equal(result.checks.A2.outcome, 'fail');
  assert.deepEqual(result.differences, [{ field: '责任性质', document: '连带', source: '补充' }]);
});

test('证明目的分别给出通过、预警和越界，越界理由保留材料原文', () => {
  const quote = '被告承认收到借款。';
  const rows = verify('zj', [{ text: '收条\t证明被告承认收到借款。\n收条\t证明借款已清偿。\n收条\t证明被告构成欺诈。', verified: true }],
    [evidence('收条', quote)]).filter(item => item.type === 'E-PURP');
  assert.deepEqual(rows.map(item => item.checks.A4.outcome), ['pass', 'warn', 'fail']);
  assert.deepEqual(rows.map(item => item.verdict), ['pass', 'warn', 'fail']);
  assert.match(rows[2].reason, /被告承认收到借款/u);
  const denied = verify('zj', [{ text: '收条\t证明借款已清偿。', verified: true }], [evidence('收条', '该收条不能证明借款已清偿。')]);
  assert.equal(denied.find(item => item.type === 'E-PURP').checks.A4.outcome, 'warn');
});

test('同一付款事项跨段冲突时保留两处定位，排除其他期次和对方转述', () => {
  const first = '被告自2023年4月1日后未再支付第2期利息。';
  const check = later => verify('qs', [{ text: first }, { text: later }]).find(item => item.quote === first);
  const positive = check('被告于2023年4月11日支付第2期利息35,000元。');
  assert.equal(positive.checks.A5.outcome, 'fail');
  assert.match(positive.reason, /第1段第1句.*第2段第1句/u);
  assert.equal(check('被告于2023年4月11日支付第二期利息35,000元。').checks.A5.outcome, 'fail');
  const [sameParagraph] = verify('qs', [{ text: `${first}被告于2023年4月11日支付第2期利息35,000元。` }]);
  assert.equal(sameParagraph.checks.A5.outcome, 'fail');
  assert.match(sameParagraph.reason, /第1段第1句.*第1段第2句/u);
  for (const quote of ['被告于2023年4月11日支付第3期利息35,000元。', '原告主张被告于2023年4月11日支付第2期利息35,000元。',
    '被告于2023年4月11日支付第2期利息的义务仍然存在。', '被告于2023年4月11日支付第2期利息后方可提货。']) {
    assert.notEqual(check(quote).checks.A5?.outcome, 'fail');
  }
  const reported = '被告于2023年4月1日转述原告说此后未再支付。';
  const [cited] = verify('qs', [{ text: reported }, { text: '被告于2023年4月11日支付第2期利息35,000元。' }]);
  assert.notEqual(cited.checks.A5?.outcome, 'fail');
});

test('欠款复算采用已定位的货款总额与累计实付，金额冲突和缺输入分别判定', () => {
  const text = '被告仅支付货款200,000元，尚欠376,000元。';
  const reconciliation = '货款总额576,000元，累计已付货款200,000元。';
  const evaluate = (text, quote) => verify('qs', [{ text, verified: true,
    link: { evidenceId: 'ev', quote, locator: '结算单', relation: 'support' } }], [evidence('结算单', quote)]).find(item => item.type === 'E-CALC');
  const supported = evaluate(text, reconciliation);
  assert.equal(supported.verdict, 'pass');
  assert.match(supported.reason, /576000 − 200000 = 376000 元/u);
  assert.deepEqual(supported.calculation, { kind: 'trade-balance', total: 576000, paid: 200000, amount: 376000, sources: supported.sources });
  const conflict = evaluate(text.replace('376,000', '389,000'), reconciliation);
  assert.equal(conflict.verdict, 'fail');
  assert.deepEqual(conflict.calculation, supported.calculation);
  assert.deepEqual(conflict.differences, [{ field: '欠款', document: '389,000元', source: '376000元' }]);
  assert.equal(evaluate(text, '货款总额576,000元，单笔支付200,000元。').verdict, 'warn');
});

test('卷内约定的 360 日单利可以复算，其他计息口径不能补位', () => {
  const formula = '利息按10000元×10%×180天÷360计算。';
  const link = { evidenceId: 'ev', locator: '计息条款', quote: formula, relation: 'support' };
  const [agreed] = verify('qs', [{ text: formula, verified: true, link }], [evidence('借款合同', formula)]).filter(item => item.type === 'E-CALC');
  assert.equal(agreed.calculation.annualDays, 360);
  assert.equal(agreed.calculation.amount, 500);
  const [different] = verify('qs', [{ text: formula, verified: true, link }], [evidence('借款合同', formula.replace('÷360', '÷365'))]).filter(item => item.type === 'E-CALC');
  assert.equal(different.verdict, 'warn');
  assert.equal(different.calculation, undefined);
  const clippedLink = { ...link, quote: '10000元×10%×180天÷360' };
  const [clipped] = verify('qs', [{ text: formula, verified: true, link: clippedLink }], [evidence('借款合同', formula.replace('10000', '110000'))])
    .filter(item => item.type === 'E-CALC');
  assert.equal(clipped.verdict, 'warn');
  assert.deepEqual(clipped.sources, []);
  assert.equal(clipped.calculation, undefined);
});

test('异名旧链接不能让清单幽灵行通过，也不能让证明目的借用同段别的证据', () => {
  const quote = '被告承认收到借款。';
  const link = { evidenceId: 'ev', quote, locator: '借条原文', relation: 'support' };
  const missing = verify('zj', [{ text: '公证书', link, verified: true }], [evidence('借条', quote)])[0];
  assert.equal(missing.verdict, 'miss');
  assert.equal(missing.checks.A3.outcome, 'miss');
  assert.deepEqual(missing.sources, []);
  const materials = [evidence('借条', quote), { ...evidence('收条', '收条仅记载交付日期。'), id: 'receipt' }];
  const result = verify('zj', [{ text: '收条\t证明被告承认收到借款。', link, verified: true }], materials)
    .find(item => item.type === 'E-PURP');
  assert.equal(result.verdict, 'warn');
  assert.deepEqual(result.sources.map(item => item.id), ['receipt']);
});

test('未再向某人支付与同期付款给其他收款对象可以同时成立', () => {
  const text = '被告自2023年4月1日后未再向原告支付利息。';
  const check = recipient => verify('qs', [{ text }, { text: `被告于2023年4月11日向${recipient}支付利息35,000元。` }])[0];
  assert.equal(check('原告').checks.A5.outcome, 'fail');
  assert.notEqual(check('第三人').checks.A5?.outcome, 'fail');
});

test('只有对方目录明确列全才能判质证对象不存在，口头质疑维持黄灯', () => {
  const absent = '对证据4王某证人证言：证人与原告系同事，且未出庭，不认可。';
  const catalog = { ...evidence('对方证据目录', '共3项\n证据1：借条\n证据2：银行流水\n证据3：微信截图'), id: 'catalog' };
  const ready = { evidenceId: catalog.id, materialRole: 'party_statement', status: 'ready' };
  const find = items => items.find(item => item.type === 'E-CROSS');
  assert.equal(find(verify('zz', [{ text: absent }])).verdict, 'miss');
  const disproved = find(verify('zz', [{ text: absent }], [catalog], [], [ready]));
  assert.equal(disproved.verdict, 'fail');
  assert.deepEqual(disproved.sources, []);
  assert.equal(find(verify('zz', [{ text: absent }], [{ ...catalog, ocrText: catalog.ocrText.replace('共3项', '共4项') }], [], [ready])).verdict, 'miss');

  const context = '证据3为微信截图。';
  const [result] = verify('zz', [{ text: '对证据3微信截图：不认可真实性，截图可能被篡改。', verified: true,
    link: { evidenceId: 'ev', quote: context, locator: '截图', relation: 'support' } }], [evidence('微信截图', context)]).filter(item => item.type === 'E-CROSS');
  assert.equal(result.verdict, 'warn');
  assert.equal(result.checks.A4.outcome, 'warn');
});

test('冻结种子的 L1 判定使用独立构造的原文片段及实际定位', async () => {
  const [documents, labels, supplements] = await Promise.all(['documents', 'expected', 'supplements'].map(readSeed));
  const [judgment, paymentJudgment] = supplements.find(item => item.documentId === 'c1-ss').segments;
  const facts = [
    ['c1-subj', 'c1-qs', 0, '身份材料', '姓名：王某，男，住北京市朝阳区。', '身份信息已人工核对'],
    ['c1-q1', 'c1-qs', 1, '借条原件.jpg', '2023年3月15日，被告向原告借款500,000元，借期一年，年利率12%。'],
    ['c1-q2', 'c1-qs', 2, '借条原件.jpg', '借款本金500,000元，约定年利率12%。'],
    ['c1-q3', 'c1-qs', 3, '微信聊天截图.png', '2024年3月20日，被告回复“钱我认，再宽限两个月”。', '截图未经公证'],
    ['c1-q4', 'c1-qs', 4, '银行流水', '被告于2023年4月11日向原告支付利息35,000元。', '', 'contradict'],
    ['c1-q5', 'c1-qs', 5],
    ['c1-d2', 'c1-db', 1, '银行流水', '答辩人于2023年4月11日向原告转账35,000元，款项性质为利息。'],
    ['c1-d3', 'c1-db', 2, '民事起诉状', '2023年3月15日完成借款本金500,000元的转账交付，年利率为12%。'],
    ['c1-d5', 'c1-db', 4],
    ['c1-z1', 'c1-zj', 0, '借条原件.jpg', '借款本金50万元，借期一年，年利率12%。'],
    ['c1-z2', 'c1-zj', 1, '微信聊天截图.png', '钱我认，再宽限两个月。'],
    ['c1-z3', 'c1-zj', 2],
    ['c1-t1', 'c1-zz', 0, '借条及付款凭证', '2023年3月15日，借款人确认收到50万元。'],
    ['c1-t2', 'c1-zz', 1, '微信聊天截图.png', '钱我认，再宽限两个月。'],
    ['c1-l1', 'c1-dlc', 0, '借条与同日付款凭证', '2023年3月15日签署借条并收到同日银行转账50万元。'],
    ['c1-s1', 'c1-ss', 0, '一审判决书.pdf', judgment.text, '存在补强材料', 'support', judgment.loc],
    ['c1-s2', 'c1-ss', 1, '一审判决书.pdf', paymentJudgment.text, '', 'support', paymentJudgment.loc],
    ['c1-s3', 'c1-ss', 2],
    ['c2-q1', 'c2-qs', 0, '钢材购销合同', '2024年3月10日签订合同，供应Q235B钢材120吨，单价每吨4,800元，货款总额576,000元，收货后30日内付清。'],
    ['c2-q2', 'c2-qs', 1, '签收单', '2024年4月12日，仓库管理员刘某签收。'],
    ['c2-q3', 'c2-qs', 2, '买卖结算单', '货款总额576,000元，累计已付货款200,000元。'],
    ['c2-q4', 'c2-qs', 3, '催款函及EMS凭证', '原告于2024年6月15日向被告发出催款函，EMS于2024年6月18日由被告签收。'],
  ];
  for (const [id, documentId, index, name, quote, note, relation = 'support', locator = '原文第 1 段'] of facts) {
    const document = documents.find(item => item.id === documentId);
    const text = document.paragraphs[index];
    const link = quote && document.docKey !== 'zj'
      ? { evidenceId: 'ev', quote, locator, sentenceIndex: 0, relation } : undefined;
    const results = verify(document.docKey, [{ text, verified: true, note, link }], quote ? [evidence(name, quote)] : [],
      quote ? [{ evidenceId: 'ev', locator, text: quote }] : []);
    const expected = labels.find(item => item.id === id);
    assert.ok(expected && expected.documentId === documentId && expected.paragraphIndex === index, id);
    const actual = results.find(item => item.type === expected.type);
    assert.ok(actual, `${id} 应产生 ${expected.type}`);
    assert.equal(text.slice(actual.location.start, actual.location.end), actual.quote, id);
    assert.equal(actual.verdict, expected.verdict, `${id}: ${actual.reason}`);
    if (link) assert.ok(actual.sources.some(source => source.quote === quote && source.locator === locator), id);
    if (id === 'c1-q4') assert.deepEqual(actual.differences.map(item => item.field), ['日期', '金额']);
    if (id === 'c1-s2') assert.equal(actual.differences[0].field, '前审付款认定');
    if (id === 'c2-q3') assert.match(actual.reason, /576000 − 200000 = 376000 元/u);
  }
});

test('c1-z4 漏列身份证和户籍材料呈文书级预警，c1-z1 原清单行仍通过', async () => {
  const [documents, labels, sources] = await Promise.all(['documents', 'expected', 'sources'].map(readSeed));
  const document = documents.find(item => item.id === 'c1-zj');
  const doc = { ...document, paragraphs: document.paragraphs.map((text, index) => ({ id: `p${index}`, text, verified: true })) };
  const physical = sources.find(item => item.caseId === 'c1').materials.filter(item => ['M01', 'M03', 'M04', 'M05'].includes(item.id));
  const evidences = physical.map(item => ({ ...evidence(item.n, '受控卷内材料'), id: item.id, caseId: 'c1' }));
  const evidenceInsights = physical.map(item => ({ evidenceId: item.id, version: 1, status: 'ready',
    materialRole: item.g === '身份主体' ? 'identity' : 'source_evidence' }));
  const result = evidenceVerification.verifyEvidence(doc, extractDeclarations(doc).declarations, { evidences, evidenceInsights, evidenceFragments: [] });
  const original = labels.find(item => item.id === 'c1-z1');
  const omission = labels.find(item => item.id === 'c1-z4');
  assert.equal(result.declarations.find(item => item.type === original.type && item.location.paragraphIndex === original.paragraphIndex).verdict, original.verdict);
  assert.equal(result.documentDiagnostics[0].verdict, omission.verdict);
  assert.deepEqual(result.documentDiagnostics[0].sources.map(item => item.name), ['原告身份证.jpg', '被告户籍信息.pdf']);
  assert.ok(result.declarations.every(item => !item.quote.includes('未列入证据清单')));
});

test('c1-d1 仅在受控流水明确记载同一主体后续付款时判反证', async () => {
  const [documents, labels] = await Promise.all(['documents', 'expected'].map(readSeed));
  const label = labels.find(item => item.id === 'c1-d1');
  const text = documents.find(item => item.id === label.documentId).paragraphs[label.paragraphIndex];
  const sentence = '答辩人于2023年4月11日支付利息35,000元，此后未再付款。';
  const compute = sourceText => {
    const link = { evidenceId: 'ev', quote: sourceText, locator: '受控流水第 6 页', sentenceIndex: 1, sentenceText: sentence, relation: 'support' };
    const doc = { id: 'd1', docKey: 'db', caseId: 'case', paragraphs: [{ id: 'p', text, verified: true, link }] };
    const candidates = [{ paragraphId: 'p', type: 'E-CROSS', quote: sentence }];
    const declarations = extractDeclarations(doc, candidates).declarations;
    return evidenceVerification.verifyEvidenceDeclarations(doc, declarations, { evidences: [evidence('银行流水', sourceText)],
      evidenceFragments: [{ evidenceId: 'ev', locator: link.locator, text: sourceText }], evidenceInsights: [] })
      .find(item => item.type === label.type && item.quote === sentence);
  };
  assert.notEqual(compute('答辩人于2023年4月11日支付利息35,000元。').verdict, 'fail');
  const laterPayment = '答辩人于2023年5月6日支付利息2,500元。';
  const actual = compute(laterPayment);
  assert.equal(actual.verdict, label.verdict);
  assert.deepEqual(actual.differences.find(item => item.field === '后续付款'), { field: '后续付款', document: sentence, source: laterPayment });
});
