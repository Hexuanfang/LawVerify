export const CASE_MEMORY = {
  c1: {
    summary: '本案围绕借款是否交付、已付利息如何认定以及剩余款项如何计算展开。借条与银行流水可互相印证，付款叙述及部分证明目的仍有争议。',
    disputeFocuses: ['借条与同日转账能否共同证明借贷关系及借款交付。', '已支付利息的日期、金额及其对诉请的影响。'],
    claimsAndDefenses: ['原告请求返还本金并支付利息。', '被告在答辩状中指出，银行流水记载有一笔 35,000 元的利息支付。'],
    keyPersons: ['王某 · 原告、出借人', '李某 · 被告、借款人'],
    keyAmounts: ['500,000 元 · 借款交付', '35,000 元 · 流水记载的利息支付', '12% · 借条载明的年利率'],
    timeline: [
      { date: '2023-03-15', text: '签署借条并转账 500,000 元', doc: 'qs', id: 'c1-q1', material: 'M01' },
      { date: '2023-04-11', text: '流水记载支付利息 35,000 元', doc: 'qs', id: 'c1-q4', material: 'M02' },
      { date: '2024-03-20', text: '微信中承认欠款并请求宽限', doc: 'qs', id: 'c1-q3', material: 'M03' },
    ],
  },
  c2: {
    summary: '本案围绕钢材交付、验收单签收人和货款余额展开。合同、验收单和对公流水分别对应价款、履行情况和已支付金额。',
    disputeFocuses: ['验收单的签收人身份及该签收对交付的证明范围。', '已支付款项、剩余货款及逾期起算依据。'],
    claimsAndDefenses: ['原告请求支付剩余货款及逾期付款损失。', '示例案卷暂未提供被告答辩。'],
    keyPersons: ['星辰科技 · 原告、供货方', '远大商贸 · 被告、采购方', '刘某 · 验收材料所载库管员'],
    keyAmounts: ['576,000 元 · 合同价款', '200,000 元 · 已付款', '376,000 元 · 文书主张的货款余额'],
    timeline: [
      { date: '2024-03-10', text: '签订钢材购销合同', doc: 'qs', id: 'c2-q1', material: 'N01' },
      { date: '2024-05-10', text: '验收材料记载库管员刘某签收', doc: 'qs', id: 'c2-q2', material: 'N02' },
      { date: '2024-05-20', text: '对公流水记载付款 200,000 元', doc: 'qs', id: 'c2-q3', material: 'N03' },
      { date: '2024-06-18', text: '催款函送达记录显示已签收', doc: 'qs', id: 'c2-q4', material: 'N04' },
    ],
  },
};

const storageKey = 'lawverify.case-memory.v1';

export function loadCaseNotes() {
  try {
    const records = JSON.parse(window.localStorage.getItem(storageKey) || '{}');
    return records && typeof records === 'object' && !Array.isArray(records) ? records : {};
  } catch {
    return {};
  }
}

export function saveCaseNotes(records) {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(records));
    return true;
  } catch {
    return false;
  }
}

export function noteRecord(records, caseId) {
  const record = records[caseId];
  return { ...record, stance: typeof record?.stance === 'string' ? record.stance : '', notes: Array.isArray(record?.notes) ? record.notes : [] };
}
