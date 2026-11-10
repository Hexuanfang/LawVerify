// 离线回放夹具生成器：产出 server/eval/fixtures/linkage-offline-v1.json
// 夹具记录的是模型原始响应文本与流水线解析后的挂接结果，
// 用于离线复现「解析健壮率」与「引用可溯率」两项指标。
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))

const json = value => JSON.stringify(value)

const entries = [
  {
    id: 'fx-001',
    sampleId: 'syn-0001',
    kind: 'normal',
    stage: 'links',
    paragraphIds: ['p-1'],
    expectParse: true,
    raw: json({
      paragraphs: [{
        paragraphId: 'p-1',
        evidenceLinks: [
          { sentenceIndex: 0, evidenceNumber: 'E01', relation: 'support', reason: '合同总价款120万元', quoteHint: '合同总价款为人民币120万元，分两期支付' },
          { sentenceIndex: 2, evidenceNumber: 'E02', relation: 'support', reason: '第一期货款已付60万元', quoteHint: '交易金额：人民币600,000.00元' },
        ],
        statuteIntents: [],
        caseIntents: [],
      }],
    }),
    links: [
      { materialId: 'm-1', locator: '第 2 页', quote: '合同总价款为人民币120万元，分两期支付', relation: 'support', sentenceIndex: 0 },
      { materialId: 'm-2', locator: '第 1 页', quote: '交易金额：人民币600,000.00元', relation: 'support', sentenceIndex: 2 },
    ],
  },
  {
    id: 'fx-002',
    sampleId: 'syn-0001',
    kind: 'fenced',
    stage: 'links',
    paragraphIds: ['p-2'],
    expectParse: true,
    raw: `\`\`\`json\n${json({
      paragraphs: [{
        paragraphId: 'p-2',
        evidenceLinks: [
          { sentenceIndex: 2, evidenceNumber: 'E07', relation: 'support', reason: '送货单', quoteHint: '送货日期：2023年7月28日' },
          { sentenceIndex: 1, evidenceNumber: 'E03', relation: 'support', reason: '微信发运通知', quoteHint: '2023-07-15 10:03 甲方王经理：货已装车发运，单号已发你邮箱。' },
        ],
        statuteIntents: [],
        caseIntents: [],
      }],
    })}\n\`\`\``,
    links: [
      { materialId: 'm-7', locator: '第 1 页', quote: '送货日期：2023年7月28日', relation: 'support', sentenceIndex: 2 },
      { materialId: 'm-3', locator: '第 2 页', quote: '2023-07-15 10:03 甲方王经理：货已装车发运，单号已发你邮箱。', relation: 'support', sentenceIndex: 1 },
    ],
  },
  {
    id: 'fx-003',
    sampleId: 'syn-0001',
    kind: 'truncated-envelope',
    stage: 'links',
    paragraphIds: ['p-4'],
    expectParse: true,
    // 外层信封被截断，但内层段落对象完整，解析器应能从残留文本中恢复。
    raw: '{"paragraphs":[{"paragraphId":"p-4","evidenceLinks":[{"sentenceIndex":0,"evidenceNumber":"E05","relation":"support","reason":"营业执照","quoteHint":"统一社会信用代码：91310000MA1FL0000X"}]}',
    links: [
      { materialId: 'm-5', locator: '第 1 页', quote: '统一社会信用代码：91310000MA1FL0000X', relation: 'support', sentenceIndex: 0 },
    ],
  },
  {
    id: 'fx-004',
    sampleId: 'syn-0002',
    kind: 'unexpected-envelope',
    stage: 'links',
    paragraphIds: ['q-1'],
    expectParse: true,
    raw: json({
      result: {
        paragraphs: [{
          paragraphId: 'q-1',
          evidenceLinks: [
            { sentenceIndex: 1, evidenceNumber: 'E01', relation: 'support', reason: '合同总价与工期', quoteHint: '合同总价为人民币860万元' },
          ],
          statuteIntents: [],
          caseIntents: [],
        }],
      },
    }),
    links: [
      { materialId: 'n-1', locator: '第 2 页', quote: '合同总价为人民币860万元', relation: 'support', sentenceIndex: 1 },
    ],
  },
  {
    id: 'fx-005',
    sampleId: 'syn-0002',
    kind: 'extra-fields',
    stage: 'links',
    paragraphIds: ['q-3'],
    expectParse: true,
    raw: json({
      paragraphs: [{
        paragraphId: 'q-3',
        paragraphSummary: '结算与付款争议',
        evidenceLinks: [
          { sentenceIndex: 3, evidenceNumber: 'E01', relation: 'support', reason: '逾期付款利息条款', quoteHint: '逾期付款的，按同期全国银行间借贷中心公布的一年期贷款市场报价利率的两倍计付资金占用费' },
        ],
        statuteIntents: [
          { sentenceIndex: 5, lawTitle: '中华人民共和国民法典', articleNumber: '第八百零四条', query: '发包人未按约定支付价款' },
        ],
        caseIntents: [],
        unknownField: { nested: true },
      }],
      debug: true,
    }),
    links: [
      { materialId: 'n-1', locator: '第 2 页', quote: '逾期付款的，按同期全国银行间借贷中心公布的一年期贷款市场报价利率的两倍计付资金占用费', relation: 'support', sentenceIndex: 3 },
    ],
  },
  {
    id: 'fx-006',
    sampleId: 'syn-0002',
    kind: 'garbage',
    stage: 'links',
    paragraphIds: ['q-4'],
    expectParse: false,
    raw: '抱歉，我无法完成该任务的联动分析。',
    links: [],
  },
  {
    id: 'fx-007',
    sampleId: 'syn-0002',
    kind: 'double-encoded',
    stage: 'links',
    paragraphIds: ['q-2'],
    expectParse: true,
    // 模型把整段 JSON 又编码了一次字符串，解析器需要先解包再取段落。
    raw: json(json({
      paragraphs: [{
        paragraphId: 'q-2',
        evidenceLinks: [
          { sentenceIndex: 3, evidenceNumber: 'E05', relation: 'support', reason: '现场签证单', quoteHint: '签证金额：人民币26万元' },
        ],
        statuteIntents: [],
        caseIntents: [],
      }],
    })),
    links: [
      { materialId: 'n-5', locator: '第 1 页', quote: '签证金额：人民币26万元', relation: 'support', sentenceIndex: 3 },
    ],
  },
]

const payload = {
  corpus: 'synthetic',
  note: '模型原始响应回放夹具：raw 为原始响应文本，links 为流水线解析后的挂接结果。',
  entries,
}

writeFileSync(path.join(here, 'linkage-offline-v1.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
console.log(`linkage-offline-v1.json: ${entries.length} 条夹具 / ${entries.reduce((total, entry) => total + (entry.links?.length ?? 0), 0)} 条挂接`)
