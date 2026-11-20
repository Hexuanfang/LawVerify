import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { normalizeDocKey, profile, validateProfile } from '../../src/intelligence/verification/profile.ts';
import { extractDeclarations, parseModelDeclarationCandidates } from '../../src/intelligence/verification/extract.ts';
import { Document, Packer, Paragraph, Table, TableCell, TableRow } from 'docx';
import { readOfficeDocxBlocks } from '../../src/office/patch.ts';

test('发布配置与交付真值无漂移，覆盖十类、十二元素和全部检查码', async () => {
  const input = new URL('../../../docs/prd开发交付/doc-element-profile.json', import.meta.url);
  assert.deepEqual(profile, JSON.parse(await readFile(input, 'utf8')));
  assert.doesNotThrow(() => validateProfile(profile));
  const changed = structuredClone(profile);
  changed.profiles.zj.elements['E-LAW'].checks.push('B1');
  assert.throws(() => validateProfile(changed), /off/);
  assert.equal(normalizeDocKey('cx'), 'proc');
  assert.equal(normalizeDocKey('未知'), undefined);
});

test('复合引用、计算与事实分别成声明，重复句的定位可复现', () => {
  const text = '请求支付借款，依据《测试法》第一条。被告于2024年1月1日支付，利息按10万元×5%计算。被告已签字。被告已签字。';
  const result = extractDeclarations({ id: 'doc', docKey: 'qs', paragraphs: [{ id: 'p', text }] });
  const types = result.declarations.map(item => item.type);
  for (const type of ['E-CLAIM', 'E-LAW', 'E-FACT', 'E-CALC']) assert.ok(types.includes(type), type);
  const firstSentence = result.declarations.filter(item => item.location.sentenceIndex === 0);
  assert.deepEqual(firstSentence.map(item => [item.type, item.quote]), [['E-CLAIM', '请求支付借款'], ['E-LAW', '《测试法》第一条']]);
  const secondSentence = result.declarations.filter(item => item.location.sentenceIndex === 1);
  assert.deepEqual(secondSentence.map(item => [item.type, item.quote]), [['E-FACT', '被告于2024年1月1日支付'], ['E-CALC', '利息按10万元×5%计算。']]);
  const repeat = result.declarations.filter(item => item.quote === '被告已签字。');
  assert.equal(repeat.length, 2);
  assert.notEqual(repeat[0].id, repeat[1].id);
  for (const item of result.declarations) assert.equal(text.slice(item.location.start, item.location.end), item.quote);
});

test('法条在句首时，后续请求仍是独立的原文范围', () => {
  const text = '依据《测试法》第一条，请求返还借款。';
  const { declarations } = extractDeclarations({ id: 'doc', docKey: 'qs', paragraphs: [{ id: 'p', text }] });
  assert.deepEqual(declarations.map(item => [item.type, item.quote]), [['E-LAW', '《测试法》第一条'], ['E-CLAIM', '请求返还借款。']]);
});

test('律师函中要求收函后履行或核对的文字是要求，不是已发生的事实', () => {
  const text = '请在收到本函后与委托人核对借款本金及已支付利息。';
  const { declarations } = extractDeclarations({ id: 'doc', docKey: 'lsh', paragraphs: [{ id: 'p', text }] });
  assert.deepEqual(declarations.map(item => [item.type, item.quote]), [['E-CLAIM', text]]);
});

test('证据清单仅抽证据和目的，分开真实表格坐标与扁平文本', () => {
  const richText = '<table><tr><td>证据名称</td><td>证明目的</td></tr><tr><td>借条</td><td>证明款项已付，参见《测试法》第一条</td></tr></table>';
  const text = '证据名称\t证明目的\n借条\t证明款项已付，参见《测试法》第一条';
  const document = { id: 'doc', docKey: 'zj', paragraphs: [{ id: 'p', text, richText }] };
  const { declarations, offCandidates } = extractDeclarations(document);
  assert.deepEqual(declarations.map(item => item.type), ['E-EVID', 'E-PURP']);
  assert.deepEqual(declarations.map(item => [item.location.row, item.location.column]), [[2, 1], [2, 2]]);
  assert.ok(offCandidates.some(item => item.type === 'E-LAW'));
  const flat = extractDeclarations({ ...document, paragraphs: [{ id: 'p', text }] });
  assert.ok(flat.declarations.every(item => item.location.column === undefined));
});

test('未分类不按标题猜测，空泛指错进入候选且模型不得引入非原文', () => {
  const paragraphs = [{ id: 'p', text: '一审认定事实错误。' }];
  assert.ok(extractDeclarations({ id: 'doc', title: '上诉状', paragraphs }).classificationRequired);
  const result = extractDeclarations({ id: 'doc', docKey: 'ss', paragraphs }, [{ paragraphId: 'p', type: 'E-ERR', quote: '模型新造句' }]);
  assert.deepEqual(result.declarations.map(item => [item.type, item.quote]), [['E-ERR', '一审认定事实错误。']]);
});

test('候选保留句级锚，拒绝无消歧的重复片段和只有法律评价的事实候选', () => {
  const repeated = '双方分歧在于交货地点';
  const opinion = '被告构成欺诈。';
  const text = `${repeated}。${repeated}。${opinion}`;
  const document = { id: 'doc', docKey: 'dlc', paragraphs: [{ id: 'p', text }] };
  const candidate = { paragraphId: 'p', type: 'E-FOCUS', quote: repeated };
  const { declarations } = extractDeclarations(document, [
    candidate, { ...candidate, start: text.lastIndexOf(repeated) },
    { paragraphId: 'p', type: 'E-FACT', quote: opinion },
  ]);
  assert.deepEqual(declarations.filter(item => item.type === 'E-FOCUS').map(item => item.location.sentenceIndex), [1]);
  assert.ok(!declarations.some(item => item.type === 'E-FACT' && item.quote.includes(opinion)));
});

test('模型事实类型仅接受九类，主观判断、法律评价和背景都不能作为事实候选', () => {
  const quote = '被告于2024年3月2日在库房交付合同货物';
  const paragraph = { id: 'p', text: `${quote}。` };
  const factKinds = ['subject', 'act', 'time', 'place', 'object', 'result', 'cause', 'intent', 'procedure'];
  const base = { sentenceIndex: 0, type: 'E-FACT', quote, factKinds: [...factKinds, 'invented'] };
  const candidates = parseModelDeclarationCandidates(paragraph, [
    ...['opinion', 'legal-evaluation', 'background', 'fact'].map(nature => ({ ...base, nature })),
    { ...base, type: 'E-LAW' },
    { ...base, type: 'E-UNKNOWN' },
    { ...base, nature: 'fact', sentenceIndex: 2 },
  ]);
  assert.deepEqual(candidates, [{ paragraphId: 'p', type: 'E-FACT', quote, start: 0, factKinds }]);
});

test('有完整原文锚的两条事实可替代规则生成的整句，去重但不丢失独立事实', () => {
  const paragraph = { id: 'p', text: '被告已支付首款，原告已交付货物。' };
  const document = { id: 'doc', docKey: 'qs', paragraphs: [paragraph] };
  const pieces = ['被告已支付首款', '原告已交付货物'].map(quote => ({ sentenceIndex: 0, type: 'E-FACT', nature: 'fact', quote }));
  const { declarations } = extractDeclarations(document, parseModelDeclarationCandidates(paragraph, [...pieces, pieces[0]]));
  assert.deepEqual(declarations.filter(item => item.type === 'E-FACT').map(item => item.quote), pieces.map(item => item.quote));
});

test('非法模型候选不关闭兜底，法律评价不吞掉同句的客观事实', () => {
  const paragraph = { id: 'p', text: '依据《测试法》第一条，被告已支付五万元。被告的上述行为已构成欺诈。被告转账五万元，上述行为已构成欺诈。' };
  assert.equal(parseModelDeclarationCandidates(paragraph, [{ sentenceIndex: 0, type: 'E-FACT', nature: 'fact', quote: '模型改写的付款' }]), undefined);
  assert.deepEqual(parseModelDeclarationCandidates(paragraph, []), []);
  const { declarations } = extractDeclarations({ id: 'doc', docKey: 'qs', paragraphs: [paragraph] });
  assert.deepEqual(declarations.filter(item => item.type === 'E-FACT').map(item => item.quote), ['被告已支付五万元。', '被告转账五万元']);
});

test('实际 DOCX 的证据清单保留表格单元格坐标', async () => {
  const rows = [['序号', '证据名称', '证明目的'], ['1', '借条', '证明借款合意']].map(row => new TableRow({
    children: row.map(text => new TableCell({ children: [new Paragraph(text)] })),
  }));
  const bytes = await Packer.toBuffer(new Document({ sections: [{ children: [new Table({ rows })] }] }));
  const paragraphs = (await readOfficeDocxBlocks(bytes, true)).map((item, index) => ({ ...item, id: `p${index}` }));
  const { declarations } = extractDeclarations({ id: 'docx', docKey: 'zj', paragraphs });
  assert.deepEqual(declarations.map(item => [item.type, item.quote, item.location.row, item.location.column]), [
    ['E-EVID', '借条', 2, 2], ['E-PURP', '证明借款合意', 2, 3],
  ]);
});
