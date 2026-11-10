// 合成评测语料生成器：产出 server/eval/datasets/synthetic-v1.jsonl
// 用脚本生成而不是手写 JSONL，是为了让分页标记、句号切分与主张编号保持一致，
// 任何人都能重跑这条命令得到逐字节相同的文件。
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))

/** 按与 splitEvidenceTextIntoPages 一致的分页标记拼接材料正文 */
function paged(pages) {
  return pages.map((content, index) => `-- 第 ${index + 1}/${pages.length} 页 --\n${content}`).join('\n')
}

/** 段落正文：句子之间用句号连接，保证与 getLinkageSentences 的切分结果一致 */
function paragraph(sentences) {
  return sentences.map(sentence => (sentence.endsWith('。') ? sentence : `${sentence}。`)).join('')
}

const samples = []

/* ------------------------------------------------------------------ */
/* 样本一：甲乙买卖合同纠纷                                            */
/* ------------------------------------------------------------------ */
{
  const materials = [
    {
      id: 'm-1',
      number: 'E01',
      sourceNumber: '证据1',
      name: '购销合同',
      type: 'pdf',
      relativePath: '证据1 购销合同.pdf',
      text: paged([
        '甲乙买卖合同\n合同编号：LV-2023-0512\n甲方：甲科技有限公司\n乙方：乙贸易有限公司\n经双方协商一致，就甲方向乙方采购电子元器件事宜订立本合同。',
        '合同总价款为人民币120万元，分两期支付。\n第一期于合同生效后十个工作日内支付60万元，第二期于交付验收合格后支付60万元。\n甲方应于2023年7月30日前将全部货物交付至乙方指定仓库。\n乙方逾期付款的，每逾期一日按未付金额万分之五支付违约金。\n本合同自双方签字盖章之日起生效，一式贰份。',
      ]),
    },
    {
      id: 'm-2',
      number: 'E02',
      sourceNumber: '证据2',
      name: '付款凭证',
      type: 'pdf',
      relativePath: '证据2 付款凭证.pdf',
      text: paged([
        '中国银行交易回单\n付款方：甲科技有限公司\n收款方：乙贸易有限公司\n交易金额：人民币600,000.00元（大写：陆拾万元整）\n交易日期：2023年5月25日\n用途：购销合同第一期货款',
      ]),
    },
    {
      id: 'm-3',
      number: 'E03',
      sourceNumber: '证据3',
      name: '微信聊天记录',
      type: 'text',
      relativePath: '证据3 微信聊天记录.txt',
      text: paged([
        '（微信聊天记录 OCR 文本）\n联系人：采购部-张\n2023-06-18 09:12 乙方张经理：合同约定的货什么时候能到？我们仓库要备货。\n2023-06-18 09:20 甲方王经理：最迟7月30日按合同交齐。',
        '2023-07-15 10:03 甲方王经理：货已装车发运，单号已发你邮箱。\n2023-08-02 14:22 甲方王经理：张经理，第二期货款该付了，麻烦安排。\n2023-08-05 16:40 乙方张经理：这批货有部分外观破损，先确认责任再付剩下的。',
      ]),
    },
    {
      id: 'm-4',
      number: 'E04',
      sourceNumber: '证据4',
      name: '庭审笔录',
      type: 'pdf',
      relativePath: '证据4 庭审笔录.pdf',
      text: paged([
        '庭审笔录\n审判长：双方对购销合同本身的签订是否有异议？\n原告代理人：没有异议，合同是双方真实签订的。\n被告代理人：合同确实签订，但对履行情况有异议。',
        '审判长：被告主张货款未全额支付的原因？\n被告代理人：货物存在质量问题，且交付时间晚于约定。\n原告代理人：交付凭证可以证明已在约定期限内完成交付。\n审判长：双方是否还有补充意见？\n被告代理人：没有。',
      ]),
    },
    {
      id: 'm-5',
      number: 'E05',
      sourceNumber: '证据5',
      name: '营业执照',
      type: 'pdf',
      relativePath: '证据5 营业执照.pdf',
      text: paged([
        '营业执照\n统一社会信用代码：91310000MA1FL0000X\n名称：乙贸易有限公司\n类型：有限责任公司\n成立日期：2015年8月12日\n住所：上海市浦东新区XX路100号',
      ]),
    },
    {
      id: 'm-6',
      number: 'E06',
      sourceNumber: '证据6',
      name: '法定代表人身份证明',
      type: 'pdf',
      relativePath: '证据6 法定代表人身份证明.pdf',
      text: paged([
        '法定代表人身份证明\n兹证明周某同志系我公司的法定代表人，特此证明。\n身份证号码：3101**********1234\n联系电话：021-****8888\n单位名称：乙贸易有限公司',
      ]),
    },
    {
      id: 'm-7',
      number: 'E07',
      sourceNumber: '证据7',
      name: '送货单',
      type: 'pdf',
      relativePath: '证据7 送货单.pdf',
      text: paged([
        '送货单\n收货单位：乙贸易有限公司\n送货单位：甲科技有限公司\n送货日期：2023年7月28日\n送货单号：SR-20230728-01\n货物名称：电子元器件\n数量：5000件\n签收人：孙某',
      ]),
    },
    {
      id: 'm-8',
      number: 'E08',
      sourceNumber: '证据8',
      name: '质量异议函',
      type: 'pdf',
      relativePath: '证据8 质量异议函.pdf',
      text: paged([
        '质量异议函\n致：甲科技有限公司\n我司于2023年7月28日收到贵司交付的电子元器件5000件，其中约200件外包装破损、部分元件规格与合同附件不符。\n我司暂缓支付第二期货款60万元，待双方确认处理方案后再行支付。\n此致\n敬礼',
      ]),
    },
    {
      id: 'm-9',
      number: 'E09',
      sourceNumber: '证据9',
      name: '律师工作底稿',
      type: 'word',
      relativePath: '证据9 律师工作底稿.docx',
      text: paged([
        '律师工作底稿（内部讨论稿，未经核实）\n争议焦点：第二期货款60万元是否应支付。\n初步判断：交付有送货单与微信记录支持；质量异议由被告提出，暂无第三方检测报告。',
        '待核实事项：一、是否存在第三方质量检测报告；二、违约金的起算时点是否应扣除延迟交付天数。\n内部意见：本案应重点准备第二期货款的支付请求与质量抗辩的回应。\n本底稿仅供办案线索使用，不能独立证明争议事实。',
      ]),
    },
    {
      id: 'm-10',
      number: 'E10',
      sourceNumber: '证据10',
      name: '补充协议',
      type: 'pdf',
      relativePath: '证据10 补充协议.pdf',
      text: paged([
        '补充协议\n甲乙双方于2023年6月10日就原购销合同（合同编号LV-2023-0512）签订本补充协议。\n一、交付期限由2023年7月30日变更为2023年8月5日。\n二、第二期付款期限同步顺延至交付验收合格后十个工作日内。\n三、本补充协议与原合同具有同等法律效力。',
      ]),
    },
  ]

  const paragraphs = [
    { id: 'p-1', text: paragraph([
      '原告甲科技有限公司与被告乙贸易有限公司于2023年5月12日签订《购销合同》，约定原告向被告采购电子元器件，合同总价款人民币120万元',
      '合同约定第一期于合同生效后十个工作日内支付60万元，第二期于交付验收合格后支付60万元',
      '原告已于2023年5月25日通过银行转账方式支付第一期货款60万元',
      '双方于2023年6月10日签订《补充协议》，将交付期限由2023年7月30日变更为2023年8月5日',
      '原告已于2023年7月28日按约完成全部货物交付，被告在送货单上签字确认',
      '原告在微信聊天记录中多次催收第二期货款60万元，被告至今未支付',
      '截至起诉之日，被告尚欠原告货款60万元',
      '综上，请求判令被告支付所欠货款60万元及相应违约金',
    ]) },
    { id: 'p-2', text: paragraph([
      '2023年6月18日，被告在微信中询问货物何时到达，原告答复最迟7月30日按合同交齐',
      '2023年7月15日，原告在微信中告知被告货物已装车发运',
      '2023年7月28日，原告向被告指定仓库交付电子元器件5000件，送货单载明收货单位为乙贸易有限公司',
      '送货单由被告工作人员孙某签收',
      '被告在庭审中认可合同已经签订，但对履行情况提出异议',
      '上述交付事实有送货单、微信聊天记录与庭审笔录相互印证',
    ]) },
    { id: 'p-3', text: paragraph([
      '被告主张交付的货物存在质量问题，并据此拒付第二期货款',
      '被告提交的质量异议函称约200件外包装破损、部分元件规格与合同附件不符',
      '被告至今未提供第三方质量检测报告',
      '现有材料中没有任何第三方质量检测报告可以采信',
      '被告的异议属于事后单方陈述，不能推翻原告的交付凭证',
      '依据《中华人民共和国民法典》第五百七十七条，当事人一方不履行合同义务的，应当承担违约责任',
    ]) },
    { id: 'p-4', text: paragraph([
      '被告乙贸易有限公司系依法成立的有限责任公司，统一社会信用代码为91310000MA1FL0000X',
      '乙贸易有限公司的住所为上海市浦东新区XX路100号',
      '周某系被告公司的法定代表人',
      '被告具备适格的诉讼主体资格',
    ]) },
    { id: 'p-5', text: '一、诉讼请求\n甲方：甲科技有限公司\n此致\n敬礼\n附件：证据清单' },
    { id: 'p-6', text: paragraph([
      '合同约定被告逾期付款的，每逾期一日按未付金额万分之五支付违约金',
      '双方在合同中明确约定了逾期付款违约金条款',
      '自2023年8月6日起计算逾期付款违约金',
      '原告主张的违约金数额以合同约定的标准计算',
    ]) },
  ]

  const claims = [
    { paragraphId: 'p-1', sentenceIndex: 0, sentenceText: '原告甲科技有限公司与被告乙贸易有限公司于2023年5月12日签订《购销合同》，约定原告向被告采购电子元器件，合同总价款人民币120万元。', expect: { link: true, materialId: 'm-1', locator: '第 2 页', relation: 'support', statutes: [], cases: [] }, notes: '合同签订时间与总价款落在合同第 2 页' },
    { paragraphId: 'p-1', sentenceIndex: 1, sentenceText: '合同约定第一期于合同生效后十个工作日内支付60万元，第二期于交付验收合格后支付60万元。', expect: { link: true, materialId: 'm-1', locator: '第 2 页', relation: 'support', statutes: [], cases: [] }, notes: '两期付款安排' },
    { paragraphId: 'p-1', sentenceIndex: 2, sentenceText: '原告已于2023年5月25日通过银行转账方式支付第一期货款60万元。', expect: { link: true, materialId: 'm-2', locator: '第 1 页', relation: 'support', statutes: [], cases: [] }, notes: '付款凭证' },
    { paragraphId: 'p-1', sentenceIndex: 3, sentenceText: '双方于2023年6月10日签订《补充协议》，将交付期限由2023年7月30日变更为2023年8月5日。', expect: { link: true, materialId: 'm-10', locator: '第 1 页', relation: 'support', statutes: [], cases: [] }, notes: '补充协议' },
    { paragraphId: 'p-1', sentenceIndex: 4, sentenceText: '原告已于2023年7月28日按约完成全部货物交付，被告在送货单上签字确认。', expect: { link: true, materialId: 'm-7', locator: '第 1 页', relation: 'support', statutes: [], cases: [] }, notes: '送货单' },
    { paragraphId: 'p-1', sentenceIndex: 5, sentenceText: '原告在微信聊天记录中多次催收第二期货款60万元，被告至今未支付。', expect: { link: true, materialId: 'm-3', locator: '第 2 页', relation: 'support', statutes: [], cases: [] }, notes: '微信催款记录' },
    { paragraphId: 'p-1', sentenceIndex: 6, sentenceText: '截至起诉之日，被告尚欠原告货款60万元。', expect: { link: true, materialId: 'm-8', locator: '第 1 页', relation: 'partial', statutes: [], cases: [] }, notes: '异议函自认暂缓支付，但未确认最终结算数额' },
    { paragraphId: 'p-1', sentenceIndex: 7, sentenceText: '综上，请求判令被告支付所欠货款60万元及相应违约金。', expect: { link: true, materialId: null, locator: '', relation: 'unrelated', statutes: ['民法典第五百七十七条 违约责任'], cases: [] }, notes: '法律适用句，需要法条核验，不指向具体材料' },

    { paragraphId: 'p-2', sentenceIndex: 0, sentenceText: '2023年6月18日，被告在微信中询问货物何时到达，原告答复最迟7月30日按合同交齐。', expect: { link: true, materialId: 'm-3', locator: '第 1 页', relation: 'support', statutes: [], cases: [] }, notes: '微信第 1 页' },
    { paragraphId: 'p-2', sentenceIndex: 1, sentenceText: '2023年7月15日，原告在微信中告知被告货物已装车发运。', expect: { link: true, materialId: 'm-3', locator: '第 2 页', relation: 'support', statutes: [], cases: [] }, notes: '微信第 2 页' },
    { paragraphId: 'p-2', sentenceIndex: 2, sentenceText: '2023年7月28日，原告向被告指定仓库交付电子元器件5000件，送货单载明收货单位为乙贸易有限公司。', expect: { link: true, materialId: 'm-7', locator: '第 1 页', relation: 'support', statutes: [], cases: [] }, notes: '送货单' },
    { paragraphId: 'p-2', sentenceIndex: 3, sentenceText: '送货单由被告工作人员孙某签收。', expect: { link: true, materialId: 'm-7', locator: '第 1 页', relation: 'support', statutes: [], cases: [] }, notes: '签收人' },
    { paragraphId: 'p-2', sentenceIndex: 4, sentenceText: '被告在庭审中认可合同已经签订，但对履行情况提出异议。', expect: { link: true, materialId: 'm-4', locator: '第 1 页', relation: 'support', statutes: [], cases: [] }, notes: '庭审笔录' },
    { paragraphId: 'p-2', sentenceIndex: 5, sentenceText: '上述交付事实有送货单、微信聊天记录与庭审笔录相互印证。', expect: { link: true, materialId: null, locator: '', relation: 'unrelated', statutes: [], cases: [] }, notes: '综合判断句，需要人工确认具体引用哪些材料' },

    { paragraphId: 'p-3', sentenceIndex: 0, sentenceText: '被告主张交付的货物存在质量问题，并据此拒付第二期货款。', expect: { link: true, materialId: 'm-4', locator: '第 2 页', relation: 'support', statutes: [], cases: [] }, notes: '庭审笔录中的抗辩' },
    { paragraphId: 'p-3', sentenceIndex: 1, sentenceText: '被告提交的质量异议函称约200件外包装破损、部分元件规格与合同附件不符。', expect: { link: true, materialId: 'm-8', locator: '第 1 页', relation: 'support', statutes: [], cases: [] }, notes: '异议函' },
    { paragraphId: 'p-3', sentenceIndex: 2, sentenceText: '被告至今未提供第三方质量检测报告。', expect: { link: true, materialId: null, locator: '', relation: 'unrelated', statutes: [], cases: [] }, notes: '无对应材料，但仍是需要核验的事实句' },
    { paragraphId: 'p-3', sentenceIndex: 3, sentenceText: '现有材料中没有任何第三方质量检测报告可以采信。', expect: { link: true, materialId: null, locator: '', relation: 'unrelated', statutes: [], cases: [] }, notes: '同上' },
    { paragraphId: 'p-3', sentenceIndex: 4, sentenceText: '被告的异议属于事后单方陈述，不能推翻原告的交付凭证。', expect: { link: true, materialId: null, locator: '', relation: 'unrelated', statutes: [], cases: [] }, notes: '法律评价句，不应直接挂接材料' },
    { paragraphId: 'p-3', sentenceIndex: 5, sentenceText: '依据《中华人民共和国民法典》第五百七十七条，当事人一方不履行合同义务的，应当承担违约责任。', expect: { link: true, materialId: null, locator: '', relation: 'unrelated', statutes: ['民法典第五百七十七条 违约责任'], cases: [] }, notes: '法条引用句' },

    { paragraphId: 'p-4', sentenceIndex: 0, sentenceText: '被告乙贸易有限公司系依法成立的有限责任公司，统一社会信用代码为91310000MA1FL0000X。', expect: { link: true, materialId: 'm-5', locator: '第 1 页', relation: 'support', statutes: [], cases: [] }, notes: '营业执照' },
    { paragraphId: 'p-4', sentenceIndex: 1, sentenceText: '乙贸易有限公司的住所为上海市浦东新区XX路100号。', expect: { link: true, materialId: 'm-5', locator: '第 1 页', relation: 'support', statutes: [], cases: [] }, notes: '营业执照住所' },
    { paragraphId: 'p-4', sentenceIndex: 2, sentenceText: '周某系被告公司的法定代表人。', expect: { link: true, materialId: 'm-6', locator: '第 1 页', relation: 'support', statutes: [], cases: [] }, notes: '身份证明' },
    { paragraphId: 'p-4', sentenceIndex: 3, sentenceText: '被告具备适格的诉讼主体资格。', expect: { link: true, materialId: null, locator: '', relation: 'unrelated', statutes: [], cases: [] }, notes: '法律评价句' },

    { paragraphId: 'p-5', sentenceIndex: 0, sentenceText: '一、诉讼请求', expect: { link: false, materialId: null, locator: '', relation: 'unrelated', statutes: [], cases: [] }, notes: '小标题应跳过' },
    { paragraphId: 'p-5', sentenceIndex: 1, sentenceText: '甲方：甲科技有限公司', expect: { link: false, materialId: null, locator: '', relation: 'unrelated', statutes: [], cases: [] }, notes: '当事人信息字段应跳过' },
    { paragraphId: 'p-5', sentenceIndex: 2, sentenceText: '此致', expect: { link: false, materialId: null, locator: '', relation: 'unrelated', statutes: [], cases: [] }, notes: '套话应跳过' },
    { paragraphId: 'p-5', sentenceIndex: 3, sentenceText: '敬礼', expect: { link: false, materialId: null, locator: '', relation: 'unrelated', statutes: [], cases: [] }, notes: '套话应跳过' },
    { paragraphId: 'p-5', sentenceIndex: 4, sentenceText: '附件：证据清单', expect: { link: false, materialId: null, locator: '', relation: 'unrelated', statutes: [], cases: [] }, notes: '附件行应跳过' },

    { paragraphId: 'p-6', sentenceIndex: 0, sentenceText: '合同约定被告逾期付款的，每逾期一日按未付金额万分之五支付违约金。', expect: { link: true, materialId: 'm-1', locator: '第 2 页', relation: 'support', statutes: [], cases: [] }, notes: '违约金条款' },
    { paragraphId: 'p-6', sentenceIndex: 1, sentenceText: '双方在合同中明确约定了逾期付款违约金条款。', expect: { link: true, materialId: 'm-1', locator: '第 2 页', relation: 'support', statutes: [], cases: [] }, notes: '违约金条款' },
    { paragraphId: 'p-6', sentenceIndex: 2, sentenceText: '自2023年8月6日起计算逾期付款违约金。', expect: { link: true, materialId: null, locator: '', relation: 'unrelated', statutes: [], cases: [] }, notes: '起算点需要人工确认' },
    { paragraphId: 'p-6', sentenceIndex: 3, sentenceText: '原告主张的违约金数额以合同约定的标准计算。', expect: { link: true, materialId: null, locator: '', relation: 'unrelated', statutes: [], cases: [] }, notes: '法律评价句' },
  ]

  samples.push({
    id: 'syn-0001',
    corpus: 'synthetic',
    case: { name: '甲乙买卖合同纠纷', role: 'plaintiff' },
    materials,
    paragraphs,
    claims: claims.map((claim, index) => ({ id: `c-${index + 1}`, ...claim })),
  })
}

/* ------------------------------------------------------------------ */
/* 样本二：丙丁建设工程施工合同纠纷                                     */
/* ------------------------------------------------------------------ */
{
  const materials = [
    {
      id: 'n-1',
      number: 'E01',
      sourceNumber: '证据1',
      name: '建设工程施工合同',
      type: 'pdf',
      relativePath: '证据1 建设工程施工合同.pdf',
      text: paged([
        '建设工程施工合同\n合同编号：JG-2022-118\n发包人：丁置业有限公司\n承包人：丙建筑工程有限公司\n双方就丁置业有限公司开发的建设工程项目施工事宜订立本合同。',
        '合同总价为人民币860万元，工期为2022年9月1日至2023年8月31日。\n发包人按月支付工程进度款，累计达到合同价的70%时停止支付。\n承包人应当在工程竣工验收合格后28日内提交结算资料。\n逾期付款的，按同期全国银行间借贷中心公布的一年期贷款市场报价利率的两倍计付资金占用费。',
      ]),
    },
    {
      id: 'n-2',
      number: 'E02',
      sourceNumber: '证据2',
      name: '工程款支付凭证',
      type: 'pdf',
      relativePath: '证据2 工程款支付凭证.pdf',
      text: paged([
        '工程款支付凭证\n付款方：丁置业有限公司\n收款方：丙建筑工程有限公司\n金额：人民币2,580,000.00元\n日期：2023年3月20日\n备注：2023年2月进度款',
      ]),
    },
    {
      id: 'n-3',
      number: 'E03',
      sourceNumber: '证据3',
      name: '竣工验收报告',
      type: 'pdf',
      relativePath: '证据3 竣工验收报告.pdf',
      text: paged([
        '竣工验收报告\n工程名称：丁置业商业中心一期\n建设单位：丁置业有限公司\n施工单位：丙建筑工程有限公司\n监理单位：××监理有限公司',
        '验收结论：工程质量符合设计与施工验收规范要求，同意通过竣工验收。\n验收日期：2023年9月15日\n施工单位项目负责人：李某',
      ]),
    },
    {
      id: 'n-4',
      number: 'E04',
      sourceNumber: '证据4',
      name: '监理月报',
      type: 'pdf',
      relativePath: '证据4 监理月报.pdf',
      text: paged([
        '监理月报（2023年6月）\n本月形象进度：主体结构施工至8层。\n本月完成产值：180万元。\n累计完成产值：520万元。',
        '本月完成产值：210万元。\n累计完成产值：730万元。\n监理意见：施工进度基本符合总进度计划要求。',
      ]),
    },
    {
      id: 'n-5',
      number: 'E05',
      sourceNumber: '证据5',
      name: '现场签证单',
      type: 'pdf',
      relativePath: '证据5 现场签证单.pdf',
      text: paged([
        '现场签证单\n工程名称：丁置业商业中心一期\n签证事由：业主要求提前插入地下车库通风管道预埋。\n签证金额：人民币26万元\n签证人：丁置业有限公司现场负责人\n施工单位：丙建筑工程有限公司',
      ]),
    },
    {
      id: 'n-6',
      number: 'E06',
      sourceNumber: '证据6',
      name: '法定代表人身份证复印件',
      type: 'image',
      relativePath: '证据6 法定代表人身份证复印件.pdf',
      text: paged([
        '居民身份证（复印件）\n姓名：吴某\n公民身份号码：3201**********0011\n住址：江苏省南京市XX区',
      ]),
    },
    {
      id: 'n-7',
      number: 'E07',
      sourceNumber: '证据7',
      name: '律师工作底稿-工期分析',
      type: 'word',
      relativePath: '证据7 律师工作底稿-工期分析.docx',
      text: paged([
        '律师工作底稿（内部讨论稿）\n争点：停工期间的工期与费用损失如何计算。\n初步判断：监理月报显示2023年6月起进度恢复。',
        '待核实事项：一、签证单26万元是否已计入进度款。二、竣工验收后结算资料提交时间。\n内部意见：应主张发包人逾期付款的利息。\n本底稿仅供内部讨论，不能独立证明逾期付款事实。',
      ]),
    },
    {
      id: 'n-8',
      number: 'E08',
      sourceNumber: '证据8',
      name: '甲方回函',
      type: 'pdf',
      relativePath: '证据8 甲方回函.pdf',
      text: paged([
        '回函\n致：丙建筑工程有限公司\n关于贵司提交的结算资料，我司已于2023年10月8日收到。\n目前正在进行内部审核，审核完成后将按合同约定程序支付。\n此致\n敬礼',
      ]),
    },
    {
      id: 'n-9',
      number: 'E09',
      sourceNumber: '证据9',
      name: '短信往来记录',
      type: 'text',
      relativePath: '证据9 短信往来记录.txt',
      text: paged([
        '（短信记录 OCR 文本）\n2023-04-12 09:05 发件人：丙项目部：贵司3月进度款已收到，感谢。\n2023-09-20 16:30 发件人：丙项目部：工程已于9月15日通过竣工验收，结算资料本周报送。\n2023-10-08 10:22 发件人：丙项目部：请确认结算资料签收情况。',
      ]),
    },
  ]

  const paragraphs = [
    { id: 'q-1', text: paragraph([
      '原告丙建筑工程有限公司与被告丁置业有限公司于2022年8月20日签订《建设工程施工合同》，约定由原告承建被告开发的建设工程项目',
      '合同总价为人民币860万元，工期为2022年9月1日至2023年8月31日',
      '合同约定发包人按月支付工程进度款，累计达到合同价70%时停止支付',
      '原告已实际完成工程价款730万元，超过合同总价70%的602万元',
      '被告仅支付工程款258万元，尚欠工程款472万元',
      '双方于2023年9月15日完成竣工验收，验收结论为工程质量符合设计与施工验收规范要求',
      '原告已于2023年10月8日向被告提交结算资料，被告回函确认收到',
      '综上，请求判令被告支付欠付工程款472万元及逾期付款利息',
    ]) },
    { id: 'q-2', text: paragraph([
      '2023年6月监理月报显示本月完成产值180万元，累计完成产值520万元',
      '2023年7月监理月报显示本月完成产值210万元，累计完成产值730万元',
      '监理单位在月报中认为施工进度基本符合总进度计划要求',
      '因业主要求提前插入地下车库通风管道预埋，双方办理了现场签证单，签证金额为26万元',
      '该26万元签证款是否已随进度款一并支付，需以付款凭证为准',
      '被告迟延支付进度款导致原告垫资施工的事实，有监理月报与进度款支付凭证相互印证',
    ]) },
    { id: 'q-3', text: paragraph([
      '被告在2023年4月12日收到原告3月进度款后，仍未按月支付后续进度款',
      '2023年9月20日原告短信告知工程已通过竣工验收并报送结算资料',
      '被告在回函中称正在进行内部审核，审核完成后按合同约定程序支付',
      '合同约定逾期付款按同期一年期贷款市场报价利率的两倍计付资金占用费',
      '双方对欠付工程款的数额及利息计算方式尚未达成一致',
      '依据《中华人民共和国民法典》第八百零四条，发包人未按约定支付价款的，承包人有权催告在合理期限内支付',
    ]) },
    { id: 'q-4', text: paragraph([
      '原告丙建筑工程有限公司的法定代表人吴某身份信息明确',
      '被告丁置业有限公司系依法设立的企业法人，具备适格的诉讼主体资格',
      '本案争议的法律适用应以建设工程施工合同约定与民法典建设工程合同章为准',
      '被告对工程结算金额与欠付数额均有异议',
    ]) },
    { id: 'q-5', text: '二、事实与理由\n甲方：丙建筑工程有限公司\n统一社会信用代码：91320000MA1FL0000Y\n附件：证据清单\n甲方（盖章）：丙建筑工程有限公司' },
  ]

  const claims = [
    { paragraphId: 'q-1', sentenceIndex: 0, sentenceText: '原告丙建筑工程有限公司与被告丁置业有限公司于2022年8月20日签订《建设工程施工合同》，约定由原告承建被告开发的建设工程项目。', expect: { link: true, materialId: 'n-1', locator: '第 1 页', relation: 'support', statutes: [], cases: [] }, notes: '合同首部' },
    { paragraphId: 'q-1', sentenceIndex: 1, sentenceText: '合同总价为人民币860万元，工期为2022年9月1日至2023年8月31日。', expect: { link: true, materialId: 'n-1', locator: '第 2 页', relation: 'support', statutes: [], cases: [] }, notes: '合同价与工期' },
    { paragraphId: 'q-1', sentenceIndex: 2, sentenceText: '合同约定发包人按月支付工程进度款，累计达到合同价70%时停止支付。', expect: { link: true, materialId: 'n-1', locator: '第 2 页', relation: 'support', statutes: [], cases: [] }, notes: '进度款条款' },
    { paragraphId: 'q-1', sentenceIndex: 3, sentenceText: '原告已实际完成工程价款730万元，超过合同总价70%的602万元。', expect: { link: true, materialId: 'n-4', locator: '第 2 页', relation: 'support', statutes: [], cases: [] }, notes: '监理月报累计产值' },
    { paragraphId: 'q-1', sentenceIndex: 4, sentenceText: '被告仅支付工程款258万元，尚欠工程款472万元。', expect: { link: true, materialId: 'n-2', locator: '第 1 页', relation: 'partial', statutes: [], cases: [] }, notes: '付款凭证只证明已付258万，欠付数额为推算' },
    { paragraphId: 'q-1', sentenceIndex: 5, sentenceText: '双方于2023年9月15日完成竣工验收，验收结论为工程质量符合设计与施工验收规范要求。', expect: { link: true, materialId: 'n-3', locator: '第 2 页', relation: 'support', statutes: [], cases: [] }, notes: '竣工验收结论' },
    { paragraphId: 'q-1', sentenceIndex: 6, sentenceText: '原告已于2023年10月8日向被告提交结算资料，被告回函确认收到。', expect: { link: true, materialId: 'n-8', locator: '第 1 页', relation: 'support', statutes: [], cases: [] }, notes: '回函' },
    { paragraphId: 'q-1', sentenceIndex: 7, sentenceText: '综上，请求判令被告支付欠付工程款472万元及逾期付款利息。', expect: { link: true, materialId: null, locator: '', relation: 'unrelated', statutes: ['民法典第八百零四条 建设工程价款支付'], cases: [] }, notes: '法律适用句' },

    { paragraphId: 'q-2', sentenceIndex: 0, sentenceText: '2023年6月监理月报显示本月完成产值180万元，累计完成产值520万元。', expect: { link: true, materialId: 'n-4', locator: '第 1 页', relation: 'support', statutes: [], cases: [] }, notes: '监理月报第 1 页' },
    { paragraphId: 'q-2', sentenceIndex: 1, sentenceText: '2023年7月监理月报显示本月完成产值210万元，累计完成产值730万元。', expect: { link: true, materialId: 'n-4', locator: '第 2 页', relation: 'support', statutes: [], cases: [] }, notes: '监理月报第 2 页' },
    { paragraphId: 'q-2', sentenceIndex: 2, sentenceText: '监理单位在月报中认为施工进度基本符合总进度计划要求。', expect: { link: true, materialId: 'n-4', locator: '第 2 页', relation: 'support', statutes: [], cases: [] }, notes: '监理意见' },
    { paragraphId: 'q-2', sentenceIndex: 3, sentenceText: '因业主要求提前插入地下车库通风管道预埋，双方办理了现场签证单，签证金额为26万元。', expect: { link: true, materialId: 'n-5', locator: '第 1 页', relation: 'support', statutes: [], cases: [] }, notes: '现场签证单' },
    { paragraphId: 'q-2', sentenceIndex: 4, sentenceText: '该26万元签证款是否已随进度款一并支付，需以付款凭证为准。', expect: { link: true, materialId: null, locator: '', relation: 'unrelated', statutes: [], cases: [] }, notes: '需人工核对付款凭证' },
    { paragraphId: 'q-2', sentenceIndex: 5, sentenceText: '被告迟延支付进度款导致原告垫资施工的事实，有监理月报与进度款支付凭证相互印证。', expect: { link: true, materialId: null, locator: '', relation: 'unrelated', statutes: [], cases: [] }, notes: '综合判断句' },

    { paragraphId: 'q-3', sentenceIndex: 0, sentenceText: '被告在2023年4月12日收到原告3月进度款后，仍未按月支付后续进度款。', expect: { link: true, materialId: 'n-9', locator: '第 1 页', relation: 'support', statutes: [], cases: [] }, notes: '短信记录' },
    { paragraphId: 'q-3', sentenceIndex: 1, sentenceText: '2023年9月20日原告短信告知工程已通过竣工验收并报送结算资料。', expect: { link: true, materialId: 'n-9', locator: '第 1 页', relation: 'support', statutes: [], cases: [] }, notes: '短信记录' },
    { paragraphId: 'q-3', sentenceIndex: 2, sentenceText: '被告在回函中称正在进行内部审核，审核完成后按合同约定程序支付。', expect: { link: true, materialId: 'n-8', locator: '第 1 页', relation: 'support', statutes: [], cases: [] }, notes: '回函' },
    { paragraphId: 'q-3', sentenceIndex: 3, sentenceText: '合同约定逾期付款按同期一年期贷款市场报价利率的两倍计付资金占用费。', expect: { link: true, materialId: 'n-1', locator: '第 2 页', relation: 'support', statutes: [], cases: [] }, notes: '逾期付款条款' },
    { paragraphId: 'q-3', sentenceIndex: 4, sentenceText: '双方对欠付工程款的数额及利息计算方式尚未达成一致。', expect: { link: true, materialId: null, locator: '', relation: 'unrelated', statutes: [], cases: [] }, notes: '争议焦点句' },
    { paragraphId: 'q-3', sentenceIndex: 5, sentenceText: '依据《中华人民共和国民法典》第八百零四条，发包人未按约定支付价款的，承包人有权催告在合理期限内支付。', expect: { link: true, materialId: null, locator: '', relation: 'unrelated', statutes: ['民法典第八百零四条 建设工程合同价款支付'], cases: [] }, notes: '法条引用句' },

    { paragraphId: 'q-4', sentenceIndex: 0, sentenceText: '原告丙建筑工程有限公司的法定代表人吴某身份信息明确。', expect: { link: true, materialId: 'n-6', locator: '第 1 页', relation: 'support', statutes: [], cases: [] }, notes: '身份类材料只核验身份' },
    { paragraphId: 'q-4', sentenceIndex: 1, sentenceText: '被告丁置业有限公司系依法设立的企业法人，具备适格的诉讼主体资格。', expect: { link: true, materialId: null, locator: '', relation: 'unrelated', statutes: [], cases: [] }, notes: '法律评价句' },
    { paragraphId: 'q-4', sentenceIndex: 2, sentenceText: '本案争议的法律适用应以建设工程施工合同约定与民法典建设工程合同章为准。', expect: { link: true, materialId: null, locator: '', relation: 'unrelated', statutes: ['民法典第八百零七条 建设工程合同定义'], cases: [] }, notes: '法律适用句' },
    { paragraphId: 'q-4', sentenceIndex: 3, sentenceText: '被告对工程结算金额与欠付数额均有异议。', expect: { link: true, materialId: null, locator: '', relation: 'unrelated', statutes: [], cases: [] }, notes: '争议焦点句' },

    { paragraphId: 'q-5', sentenceIndex: 0, sentenceText: '二、事实与理由', expect: { link: false, materialId: null, locator: '', relation: 'unrelated', statutes: [], cases: [] }, notes: '小标题应跳过' },
    { paragraphId: 'q-5', sentenceIndex: 1, sentenceText: '甲方：丙建筑工程有限公司', expect: { link: false, materialId: null, locator: '', relation: 'unrelated', statutes: [], cases: [] }, notes: '当事人信息字段应跳过' },
    { paragraphId: 'q-5', sentenceIndex: 2, sentenceText: '统一社会信用代码：91320000MA1FL0000Y', expect: { link: false, materialId: null, locator: '', relation: 'unrelated', statutes: [], cases: [] }, notes: '当事人信息字段应跳过' },
    { paragraphId: 'q-5', sentenceIndex: 3, sentenceText: '附件：证据清单', expect: { link: false, materialId: null, locator: '', relation: 'unrelated', statutes: [], cases: [] }, notes: '附件行应跳过' },
    { paragraphId: 'q-5', sentenceIndex: 4, sentenceText: '甲方（盖章）：丙建筑工程有限公司', expect: { link: false, materialId: null, locator: '', relation: 'unrelated', statutes: [], cases: [] }, notes: '当事人信息字段应跳过' },
  ]

  samples.push({
    id: 'syn-0002',
    corpus: 'synthetic',
    case: { name: '丙丁建设工程施工合同纠纷', role: 'plaintiff' },
    materials,
    paragraphs,
    claims: claims.map((claim, index) => ({ id: `c-${index + 1}`, ...claim })),
  })
}

const lines = samples.map(sample => JSON.stringify(sample))
writeFileSync(path.join(here, 'synthetic-v1.jsonl'), `${lines.join('\n')}\n`, 'utf8')

const materialCount = samples.reduce((total, sample) => total + sample.materials.length, 0)
const claimCount = samples.reduce((total, sample) => total + sample.claims.length, 0)
console.log(`synthetic-v1.jsonl: ${samples.length} 个样本 / ${materialCount} 份材料 / ${claimCount} 条主张句`)
