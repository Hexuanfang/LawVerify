// 合成场景的事实与标准答案显式定义，不调用被测模型/规则生成标注。
// 八案共享边界模板，以便在不同主体、金额、行业词下检查同一种错误。
const scenarios = [
  ['sale', '买卖合同', '甲电子公司', '乙贸易公司', '货款', 128000, '电子元器件5000件'],
  ['loan', '民间借贷', '张甲', '李乙', '借款', 96000, '银行转账借款本金'],
  ['construction', '建设工程', '丙建设公司', '丁置业公司', '工程款', 860000, '地下室防水工程'],
  ['lease', '房屋租赁', '王甲', '赵乙', '租金', 36000, '仓库租赁2026年第四季度'],
  ['employment', '劳动报酬', '戊服务公司', '陈乙', '工资', 18000, '2026年9月至10月工资'],
  ['service', '技术服务', '己软件公司', '庚制造公司', '服务费', 245000, '设备监测软件开发'],
  ['insurance', '保险理赔', '辛保险公司', '孙乙', '赔款', 73000, '车辆碰撞事故理赔'],
  ['agency', '委托代理', '壬咨询公司', '周乙', '代理费', 52000, '专项事务代理服务'],
]

export function buildDataset() {
  return scenarios.map(([id, name, payer, payee, kind, amount, subject], caseIndex) => {
    const paid = Math.floor(amount / 2), balance = amount - paid
    const prefix = `案件${caseIndex + 1}`
    const material = (key, title, role, pages) => ({ id: key, number: `E${String(key).padStart(2, '0')}`, name: title, role, pages })
    const materials = [
      material('1', `${kind}合同`, 'source_evidence', [
        `${prefix}${name}合同。付款方：${payer}。收款方：${payee}。标的：${subject}。双方于2026年9月1日签订。`,
        `本合同约定${kind}总额${amount}元，付款期限为2026年10月15日。违约金每日按未付金额万分之三计算。`,
      ]),
      material('2', '银行电子回单', 'source_evidence', [
        `银行电子回单。付款方：${payer}。收款方：${payee}。交易日期：2026年10月12日。转账金额${paid}元，交易状态：成功。用途：${kind}。`,
      ]),
      material('3', '双方对账确认书', 'source_evidence', [
        `双方对账确认：截至2026年11月1日，${payer}尚未支付${kind}尾款${balance}元。双方签字确认。`,
      ]),
      material('4', '内部工作底稿', 'working_draft', [
        `律师工作底稿，内部意见，未经核实。怀疑${payer}尚欠${kind}${amount}元，需调取银行流水；不能独立证明付款事实。`,
      ]),
      material('5', '主体身份证明', 'identity', [
        `主体身份证明。名称：${payer}。登记住所：示例市示例路18号。该材料只证明主体身份，不证明履行事实。`,
      ]),
      material('6', '补充协议', 'source_evidence', [
        `双方于2026年10月10日签订补充协议，将${kind}付款期限变更为2026年11月15日，原金额和其他条款不变。`,
      ]),
      material('7', '银行电子回单', 'source_evidence', [
        `其他交易银行电子回单。付款方：无关甲公司。收款方：无关乙公司。交易日期：2026年10月12日。转账金额${amount}元。用途：设备押金，与本案无关。`,
      ]),
      material('8', '收款确认短信', 'source_evidence', [
        `2026年10月12日，${payee}向${payer}发送短信：已收到你方支付的${kind}${paid}元，剩余款项请按约支付。`,
      ]),
    ]
    const target = (materialId, relation = 'support', page = 1) => ({ materialId, relation, page })
    const rows = [
      ['contract', `双方约定${kind}总额${amount}元。`, [target('1', 'support', 2)], '金额与合同原文'],
      ['payment', `${payer}于2026年10月12日向${payee}支付${kind}${paid}元。`, [target('2'), target('8')], '回单及收款短信共同支持'],
      ['negation', `截至2026年11月1日，${payer}已经付清${kind}尾款${balance}元。`, [target('3', 'contradict')], '已付清与尚未支付冲突'],
      ['amount_conflict', `本合同约定${kind}总额${amount + 9000}元。`, [target('1', 'contradict', 2)], '同一合同金额错误'],
      ['amendment', `补充协议将${kind}付款期限改为2026年11月15日。`, [target('6')], '后签补充协议变更期限'],
      ['superseded', `${kind}的原合同付款期限为2026年10月15日。`, [target('1', 'support', 2)], '明确询问原合同，并非变更后的期限'],
      ['draft', `内部底稿怀疑${payer}尚欠${kind}${amount}元，该怀疑尚未核实。`, [target('4', 'context')], '底稿仅能作为线索'],
      ['identity', `${payer}登记住所为示例市示例路18号。`, [target('5')], '完整身份事实不是孤立身份字段'],
      ['wrong_party', '无关甲公司向无关乙公司支付设备押金。', [target('7')], '同名回单但不同交易主体'],
      ['no_evidence', `${payer}已另行现金支付${kind}尾款${balance}元。`, [], '不存在现金收据，不能从转账回单推断'],
      ['no_evidence', `${payer}承认伪造了全部银行回单。`, [], '无伪造承认材料'],
      ['heading', '一、诉讼请求', [], '标题不挂接'],
      ['identity_field', `甲方：${payer}`, [], '孤立身份字段不挂接'],
      ['boilerplate', '此致', [], '套话不挂接'],
      ['date_conflict', '本案银行转账发生于2026年10月13日。', [target('2', 'contradict')], '同一笔转账日期错误'],
      ['scope', `本合同标的是${subject}。`, [target('1')], '标的内容应定位合同第一页'],
    ]
    return { id, name, corpus: 'synthetic-v2', annotation: '显式事实标注，未经独立法律专家复核；不代表真实案件分布', materials,
      claims: rows.map(([scenario, text, expected, rationale], index) => ({ id: `${id}-c${index + 1}`, scenario, text, expected, rationale })) }
  })
}

export const dataset = buildDataset()

// 刻意独立于标准答案：这些是对生产挂接防线的攻击输入，不是模型实测响应。
export function guardProbes(sample) {
  const contractQuote = sample.materials[0].pages[1]
  return [
    { id: 'valid_page_two', claimId: sample.claims[0].id, materialId: '1', quote: contractQuote, relation: 'support', shouldKeep: true, expectedPage: 2 },
    { id: 'invented_quote', claimId: sample.claims[0].id, materialId: '1', quote: '这是完全虚构的引文ZXCVBN', relation: 'support', shouldKeep: false },
    { id: 'unknown_material', claimId: sample.claims[0].id, materialId: '99', quote: contractQuote, relation: 'support', shouldKeep: false },
    { id: 'heading', claimId: sample.claims[11].id, materialId: '1', quote: contractQuote, relation: 'support', shouldKeep: false },
    { id: 'identity_for_payment', claimId: sample.claims[1].id, materialId: '5', quote: sample.materials[4].pages[0], relation: 'support', shouldKeep: false },
    { id: 'draft_as_proof', claimId: sample.claims[6].id, materialId: '4', quote: sample.materials[3].pages[0], relation: 'support', shouldKeep: true, expectedRelation: 'context' },
    // 原文引文是真的，但与主张不匹配；规则防线不应被误认为能完成语义核验。
    { id: 'true_quote_wrong_claim', claimId: sample.claims[9].id, materialId: '2', quote: sample.materials[1].pages[0], relation: 'support', shouldKeep: false },
    { id: 'negation_wrong_relation', claimId: sample.claims[2].id, materialId: '3', quote: sample.materials[2].pages[0], relation: 'support', shouldKeep: false },
  ]
}
