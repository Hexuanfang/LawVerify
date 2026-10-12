import type {
  KnowledgeCase,
  KnowledgeStatuteDocument,
  WorkspaceState,
} from './domain.js'
import { readBundledLawLibrarySeed } from './bundled-law-library.js'

function createId(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`
}

function mergeKnowledgeStatutes(
  defaults: KnowledgeStatuteDocument[],
  bundled: KnowledgeStatuteDocument[],
) {
  const merged = [...defaults]

  for (const document of bundled) {
    const existingIndex = merged.findIndex((item) => item.title === document.title)
    if (existingIndex >= 0) {
      merged[existingIndex] = document
      continue
    }

    merged.push(document)
  }

  return merged
}

function buildKnowledgeStatutes(): KnowledgeStatuteDocument[] {
  const civilProcedureId = createId('statute')
  const civilCodeId = createId('statute')
  const civilProcedureInterpretationId = createId('statute')
  const civilEvidenceInterpretationId = createId('statute')

  return [
    {
      id: civilProcedureId,
      title: '中华人民共和国民事诉讼法',
      docType: '法律',
      issuer: '全国人民代表大会常务委员会',
      effectiveStatus: 'effective',
      effectiveDate: '2024-01-01T00:00:00.000Z',
      publishDate: '2023-09-01T00:00:00.000Z',
      revisionDate: '2023-09-01T00:00:00.000Z',
      version: '2023 修正',
      sourceUrl: 'https://www.npc.gov.cn/npc/c2/c30834/202310/t20231018_432137.html',
      sourceTextUrl: 'https://www.npc.gov.cn/npc/c2/c30834/202310/t20231018_432137.html',
      sourceProvider: 'npc_flk',
      sourceAuthority: '全国人大常委会办公厅',
      sourceVerifiedAt: '2026-09-24T00:00:00.000Z',
      keywords: ['民诉法', '民事诉讼法', '电子数据', '证据', '举证', '质证', '真实性'],
      articles: [
        {
          id: createId('article'),
          documentId: civilProcedureId,
          articleNumber: '第六十六条',
          content: '证据包括：（一）当事人的陈述；（二）书证；（三）物证；（四）视听资料；（五）电子数据；（六）证人证言；（七）鉴定意见；（八）勘验笔录。证据必须查证属实，才能作为认定事实的根据。',
          plainText: '证据包括：（一）当事人的陈述；（二）书证；（三）物证；（四）视听资料；（五）电子数据；（六）证人证言；（七）鉴定意见；（八）勘验笔录。证据必须查证属实，才能作为认定事实的根据。',
          aliases: ['证据种类', '法定证据种类', '电子数据证据', '微信聊天记录证据'],
          topicTags: ['证据能力', '电子数据'],
        },
        {
          id: createId('article'),
          documentId: civilProcedureId,
          articleNumber: '第六十七条',
          content:
            '当事人对自己提出的主张，有责任提供证据。当事人及其诉讼代理人因客观原因不能自行收集的证据，或者人民法院认为审理案件需要的证据，人民法院应当调查收集。',
          plainText:
            '当事人对自己提出的主张，有责任提供证据。当事人及其诉讼代理人因客观原因不能自行收集的证据，或者人民法院认为审理案件需要的证据，人民法院应当调查收集。',
          aliases: ['举证责任', '谁主张谁举证', '主张责任'],
          topicTags: ['举证责任', '证明责任'],
        },
        {
          id: createId('article'),
          documentId: civilProcedureId,
          articleNumber: '第七十一条',
          content: '人民法院应当按照法定程序，全面、客观地审查核实证据。',
          plainText: '人民法院应当按照法定程序，全面、客观地审查核实证据。',
          aliases: ['证据审查', '审查核实'],
          topicTags: ['证据审查', '证明力'],
        },
      ],
    },
    {
      id: civilCodeId,
      title: '中华人民共和国民法典',
      docType: '法律',
      issuer: '全国人民代表大会',
      effectiveStatus: 'effective',
      effectiveDate: '2021-01-01T00:00:00.000Z',
      publishDate: '2020-05-28T00:00:00.000Z',
      version: '现行有效',
      sourceUrl: 'https://flk.npc.gov.cn/',
      sourceTextUrl: 'https://flk.npc.gov.cn/',
      sourceProvider: 'npc_flk',
      sourceAuthority: '全国人大常委会办公厅',
      sourceVerifiedAt: '2026-09-24T00:00:00.000Z',
      keywords: ['民法典', '合同履行', '违约责任', '买卖合同', '付款义务'],
      articles: [
        {
          id: createId('article'),
          documentId: civilCodeId,
          articleNumber: '第五百零九条',
          content: '当事人应当按照约定全面履行自己的义务。',
          plainText: '当事人应当按照约定全面履行自己的义务。',
          aliases: ['全面履行原则'],
          topicTags: ['合同履行', '付款义务'],
        },
        {
          id: createId('article'),
          documentId: civilCodeId,
          articleNumber: '第五百七十七条',
          content: '当事人一方不履行合同义务或者履行合同义务不符合约定的，应当承担继续履行、采取补救措施或者赔偿损失等违约责任。',
          plainText: '当事人一方不履行合同义务或者履行合同义务不符合约定的，应当承担违约责任。',
          aliases: ['违约责任', '不履行合同义务'],
          topicTags: ['违约责任', '损失赔偿'],
        },
        {
          id: createId('article'),
          documentId: civilCodeId,
          articleNumber: '第五百八十五条',
          content: '当事人可以约定一方违约时应当根据违约情况向对方支付一定数额的违约金，也可以约定因违约产生的损失赔偿额的计算方法。约定的违约金低于造成的损失的，人民法院或者仲裁机构可以根据当事人的请求予以增加；约定的违约金过分高于造成的损失的，人民法院或者仲裁机构可以根据当事人的请求予以适当减少。当事人就迟延履行约定违约金的，违约方支付违约金后，还应当履行债务。',
          plainText: '当事人可以约定违约金或者损失赔偿额的计算方法。约定的违约金低于造成的损失的，可以请求增加；过分高于造成的损失的，可以请求适当减少。迟延履行约定违约金的，支付违约金后仍应履行债务。',
          aliases: ['违约金', '约定违约金', '损失赔偿额计算方法'],
          topicTags: ['违约责任', '违约金', '损失赔偿'],
        },
      ],
    },
    {
      id: civilProcedureInterpretationId,
      title: '最高人民法院关于适用《中华人民共和国民事诉讼法》的解释',
      docType: '司法解释',
      issuer: '最高人民法院',
      effectiveStatus: 'effective',
      effectiveDate: '2022-04-10T00:00:00.000Z',
      publishDate: '2022-03-22T00:00:00.000Z',
      revisionDate: '2022-03-22T00:00:00.000Z',
      version: '2022 修正',
      sourceUrl: 'https://gw.nscourt.gov.cn/nscourt/wzsy/swgk/sfwj/content/post_1473222.html',
      sourceTextUrl: 'https://gw.nscourt.gov.cn/nscourt/wzsy/swgk/sfwj/content/post_1473222.html',
      sourceProvider: 'npc_flk',
      sourceAuthority: '最高人民法院',
      sourceVerifiedAt: '2026-09-24T00:00:00.000Z',
      keywords: ['民诉解释', '民事诉讼法解释', '电子数据', '视听资料', '微信聊天记录'],
      articles: [
        {
          id: createId('article'),
          documentId: civilProcedureInterpretationId,
          articleNumber: '第一百一十六条',
          content: '视听资料包括录音资料和影像资料。电子数据是指通过电子邮件、电子数据交换、网上聊天记录、博客、微博客、手机短信、电子签名、域名等形成或者存储在电子介质中的信息。存储在电子介质中的录音资料和影像资料，适用电子数据的规定。',
          plainText: '视听资料包括录音资料和影像资料。电子数据是指通过电子邮件、电子数据交换、网上聊天记录、博客、微博客、手机短信、电子签名、域名等形成或者存储在电子介质中的信息。存储在电子介质中的录音资料和影像资料，适用电子数据的规定。',
          aliases: ['电子数据定义', '视听资料与电子数据', '微信聊天记录'],
          topicTags: ['电子数据', '视听资料', '证据能力'],
        },
      ],
    },
    {
      id: civilEvidenceInterpretationId,
      title: '最高人民法院关于民事诉讼证据的若干规定',
      docType: '司法解释',
      issuer: '最高人民法院',
      effectiveStatus: 'effective',
      effectiveDate: '2020-05-01T00:00:00.000Z',
      publishDate: '2019-12-25T00:00:00.000Z',
      revisionDate: '2019-12-25T00:00:00.000Z',
      version: '2019 修正',
      sourceUrl: 'https://www.guizhoucourt.gov.cn/qwfb/213174.jhtml',
      sourceTextUrl: 'https://www.guizhoucourt.gov.cn/qwfb/213174.jhtml',
      sourceProvider: 'npc_flk',
      sourceAuthority: '最高人民法院',
      sourceVerifiedAt: '2026-09-24T00:00:00.000Z',
      keywords: ['证据规定', '民事证据规定', '电子数据', '即时通信', '微信聊天记录'],
      articles: [
        {
          id: createId('article'),
          documentId: civilEvidenceInterpretationId,
          articleNumber: '第十四条',
          content: '电子数据包括下列信息、电子文件：（一）网页、博客、微博客等网络平台发布的信息；（二）手机短信、电子邮件、即时通信、通讯群组等网络应用服务的通信信息；（三）用户注册信息、身份认证信息、电子交易记录、通信记录、登录日志等信息；（四）文档、图片、音频、视频、数字证书、计算机程序等电子文件；（五）其他以数字化形式存储、处理、传输的能够证明案件事实的信息。',
          plainText: '电子数据包括下列信息、电子文件：（一）网页、博客、微博客等网络平台发布的信息；（二）手机短信、电子邮件、即时通信、通讯群组等网络应用服务的通信信息；（三）用户注册信息、身份认证信息、电子交易记录、通信记录、登录日志等信息；（四）文档、图片、音频、视频、数字证书、计算机程序等电子文件；（五）其他以数字化形式存储、处理、传输的能够证明案件事实的信息。',
          aliases: ['电子数据范围', '微信聊天记录', '即时通信证据'],
          topicTags: ['电子数据', '即时通信', '证据审查'],
        },
      ],
    },
  ]
}

function buildKnowledgeCases(): KnowledgeCase[] {
  const caseAId = createId('knowledge-case')
  const caseBId = createId('knowledge-case')
  const caseCId = createId('knowledge-case')

  return [
    {
      id: caseAId,
      title: '张某与李某买卖合同纠纷案',
      caseNumber: '(2024)京01民终218号',
      courtName: '北京市第一中级人民法院',
      courtLevel: '中级人民法院',
      region: '北京',
      trialLevel: '二审',
      caseType: '民事',
      cause: '买卖合同纠纷',
      judgmentDate: '2024-04-18T00:00:00.000Z',
      effectiveDate: '2024-04-18T00:00:00.000Z',
      issueSummary: '围绕聊天记录、收货确认和尾款支付承诺是否足以证明付款义务到期且未履行。',
      holdingSummary: '对方在即时通信中明确确认收货并承诺付款的，可以作为认定义务到期及未履行的补强证据。',
      reasoningSummary: '结合合同付款条款、物流签收和微信确认内容，足以形成完整证据链，证明买方负有支付尾款义务。',
      resultSummary: '判令被告支付剩余货款及逾期付款损失。',
      sourceType: '裁判文书',
      sourceUrl: 'https://wenshu.court.gov.cn/',
      keywords: ['微信聊天记录', '收货确认', '尾款', '付款义务'],
      focusTags: ['付款义务', '电子数据真实性', '合同履行'],
      referencedStatutes: ['中华人民共和国民法典 第五百零九条', '中华人民共和国民法典 第五百七十七条'],
      excerpts: [
        {
          id: createId('excerpt'),
          caseId: caseAId,
          excerptType: 'holding',
          locator: '裁判理由第 3 段',
          content: '买方在微信聊天中明确表示“货已经收到，本周五前安排尾款”，应视为对收货事实及付款义务的再次确认。',
          summary: '微信确认可作为收货与付款承诺的补强证据。',
          keywords: ['微信', '尾款', '收货确认'],
        },
        {
          id: createId('excerpt'),
          caseId: caseAId,
          excerptType: 'reasoning',
          locator: '裁判理由第 5 段',
          content: '电子数据与合同文本、送货单形成相互印证时，其真实性和关联性足以达到优势证明标准。',
          summary: '电子数据可与书证相互印证形成完整证明链。',
          keywords: ['电子数据', '优势证明', '相互印证'],
        },
      ],
    },
    {
      id: caseBId,
      title: '某贸易公司与某供应链公司买卖合同纠纷案',
      caseNumber: '(2023)沪0115民初9218号',
      courtName: '上海市浦东新区人民法院',
      courtLevel: '基层人民法院',
      region: '上海',
      trialLevel: '一审',
      caseType: '民事',
      cause: '买卖合同纠纷',
      judgmentDate: '2023-11-06T00:00:00.000Z',
      effectiveDate: '2023-11-21T00:00:00.000Z',
      issueSummary: '电子对账及催款记录能否证明对方认可欠款余额。',
      holdingSummary: '连续的催款与回复记录、对账单和发票可共同证明欠款事实。',
      reasoningSummary: '即便没有单独签章确认，只要交易过程持续、往来内容稳定一致，也可认定商业往来中的债务确认。',
      resultSummary: '支持原告诉请，判令支付货款及违约金。',
      sourceType: '裁判文书',
      sourceUrl: 'https://wenshu.court.gov.cn/',
      keywords: ['对账单', '催款', '商业往来', '欠款确认'],
      focusTags: ['欠款确认', '商业惯例', '违约责任'],
      referencedStatutes: ['中华人民共和国民法典 第五百七十七条'],
      excerpts: [
        {
          id: createId('excerpt'),
          caseId: caseBId,
          excerptType: 'issue',
          locator: '争议焦点第 1 点',
          content: '被告虽抗辩未签署最终对账单，但对连续催款记录从未提出异议，应认定其对欠款事实知悉。',
          summary: '持续催款未异议可作为认知欠款的推定基础。',
          keywords: ['催款', '未异议', '欠款事实'],
        },
      ],
    },
    {
      id: caseCId,
      title: '最高人民法院指导性案例：电子数据证据审查规则',
      caseNumber: '指导性案例',
      courtName: '最高人民法院',
      courtLevel: '最高人民法院',
      region: '全国',
      trialLevel: '指导案例',
      caseType: '民事',
      cause: '电子数据证据审查',
      judgmentDate: '2022-06-10T00:00:00.000Z',
      effectiveDate: '2022-06-10T00:00:00.000Z',
      issueSummary: '电子数据的形成方式、存储介质与提取路径如何影响其证明力。',
      holdingSummary: '对电子数据应从形成主体、保存完整性、关联印证材料等方面综合判断真实性。',
      reasoningSummary: '电子数据并不因载体可变而当然不可信，关键在于是否有连续、稳定、可核验的来源链路。',
      resultSummary: '明确电子数据真实性审查的多维标准。',
      sourceType: '指导案例',
      sourceUrl: 'https://www.court.gov.cn/',
      keywords: ['电子数据', '真实性', '审查规则', '来源链路'],
      focusTags: ['电子数据真实性', '证据审查'],
      referencedStatutes: ['中华人民共和国民事诉讼法 第六十六条', '中华人民共和国民事诉讼法 第七十一条'],
      excerpts: [
        {
          id: createId('excerpt'),
          caseId: caseCId,
          excerptType: 'reasoning',
          locator: '裁判要旨',
          content: '对电子数据真实性的判断，应结合形成时间、生成主体、存储环境以及与其他证据的印证情况综合认定。',
          summary: '电子数据真实性审查应采用综合判断方法。',
          keywords: ['形成时间', '存储环境', '综合认定'],
        },
      ],
    },
  ]
}

export function buildInitialState(): WorkspaceState {
  const bundledLawLibrary = readBundledLawLibrarySeed()
  const knowledgeStatutes = mergeKnowledgeStatutes(
    buildKnowledgeStatutes(),
    bundledLawLibrary?.knowledgeStatutes ?? [],
  )
  const knowledgeCases = buildKnowledgeCases()

  return {
    user: {
      id: createId('user'),
      name: 'Hexuanfang',
      phone: '13800000000',
      email: '',
      organization: '',
      title: '合伙人 / 诉讼律师',
      points: 160,
      pointLogs: [
        {
          id: createId('point'),
          type: 'recharge',
          amount: 200,
          note: '初始化演示积分',
          createdAt: new Date().toISOString(),
        },
      ],
    },
    cases: [],
    evidences: [],
    evidenceFragments: [],
    evidenceInsights: [],
    caseContextMemories: [],
    draftMemories: [],
    certificates: [],
    claimUnits: [],
    claimEvidenceMatches: [],
    knowledgeCases,
    knowledgeFiles: bundledLawLibrary?.knowledgeFiles ?? [],
    knowledgeStatutes,
    paymentOrders: [],
  }
}
