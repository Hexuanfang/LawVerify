import type {
  AccountSummary,
  BillingOrder,
  BillingPackage,
  BillingProvider,
  InvoiceProfile,
  InvoiceRequest,
  PointPolicy,
  PointLedgerEntry,
  ReleaseItem,
  SitePlan,
  UsageMetric,
} from './types.js'

export const sitePlans: SitePlan[] = [
  {
    id: 'free-monthly',
    name: '免费版',
    priceLabel: '免费',
    billingCycle: 'monthly',
    description: '适合先体验核心能力与轻量试用。',
    highlights: ['每月 100 积分', '可进入账户中心', '支持后续按需购买积分'],
    points: 100,
  },
  {
    id: 'personal-monthly',
    name: '个人版',
    priceLabel: '¥49/月',
    billingCycle: 'monthly',
    description: '适合个人律师和轻量案件处理。',
    highlights: ['基础 AI 起草', '证据核验', '标准积分额度'],
    points: 500,
  },
  {
    id: 'pro-monthly',
    name: '专业版',
    priceLabel: '¥199/月',
    billingCycle: 'monthly',
    description: '适合高频办案与知识库增强。',
    highlights: ['更高积分额度', '优先模型能力', '账户中心高级功能'],
    points: 2500,
    recommended: true,
  },
  {
    id: 'team-custom',
    name: '团队版',
    priceLabel: '联系销售',
    billingCycle: 'custom',
    description: '适合律所团队与企业法务。',
    highlights: ['组织权限', '团队席位', '统一发票与订单管理'],
    points: 0,
  },
]

export const releases: ReleaseItem[] = [
  {
    id: 'release-0-0-1',
    version: '0.0.1',
    channel: 'stable',
    sizeLabel: '58 MB',
    publishedAt: '2026-09-27T09:00:00+08:00',
    sha256: '3a9b0f08c4c7e936b6c8ef9b0c1f4ae73c6a47b1802f9c92f4308df8f0c58db1',
    notes: ['首个官网与账户中心骨架版本。', '支持桌面端下载入口与云端接口联调。'],
    downloadUrl: 'https://download.lawverify.com/LawVerify-Setup-0.0.1.exe',
  },
]

export const accountSummary: AccountSummary = {
  id: 'user-demo-001',
  displayName: 'Hexuanfang',
  email: '972167580@qq.com',
  tierName: '专业版月付',
  pointsBalance: 2460,
  subscriptionExpiresAt: '2026-10-26T23:59:59+08:00',
}

export const usageSummary: UsageMetric[] = [
  { label: '本月文书生成', value: '82 次' },
  { label: '证据理解', value: '436 次' },
  { label: '知识库检索', value: '291 次' },
  { label: '剩余积分', value: '2,460' },
]

export const pointLedger: PointLedgerEntry[] = [
  {
    id: 'ledger-001',
    createdAt: '2026-09-26T18:50:00+08:00',
    description: '证据理解消耗',
    delta: -120,
    balanceAfter: 2460,
    entryType: 'consume',
    actionType: 'evidence_summary',
    operationKey: 'consume-evidence-summary-001',
  },
  {
    id: 'ledger-002',
    createdAt: '2026-09-25T09:16:00+08:00',
    description: '专业版充值到账',
    delta: 2000,
    balanceAfter: 2580,
    entryType: 'recharge',
  },
]

export const pointPolicies: PointPolicy[] = [
  {
    actionType: 'document_parse',
    label: '文档解析',
    description: '用于 OCR、版面拆解和基础结构抽取。',
    unitLabel: '份文件',
    pointsPerUnit: 2,
  },
  {
    actionType: 'evidence_summary',
    label: '证据摘要',
    description: '针对单份证据生成摘要、证明目的和关键事实提炼。',
    unitLabel: '份证据',
    pointsPerUnit: 2,
  },
  {
    actionType: 'legal_check',
    label: '法条核对',
    description: '识别法条并核对官方法源内容。',
    unitLabel: '次',
    pointsPerUnit: 3,
  },
  {
    actionType: 'case_reference',
    label: '案例参照',
    description: '检索并筛选相似裁判案例。',
    unitLabel: '次',
    pointsPerUnit: 5,
  },
  {
    actionType: 'evidence_match',
    label: '证据联动',
    description: '按争议焦点或主张语义，全篇分块执行深度证据匹配与事实穿透。',
    unitLabel: '次',
    pointsPerUnit: 20,
  },
  {
    actionType: 'crosscheck_paragraph',
    label: '单段质证生成',
    description: '生成单段质证意见或单个争点回应。',
    unitLabel: '段',
    pointsPerUnit: 3,
  },
  {
    actionType: 'crosscheck_full',
    label: '整份质证生成',
    description: '生成完整质证意见全文。',
    unitLabel: '份文书',
    pointsPerUnit: 15,
  },
  {
    actionType: 'pleading_full',
    label: '整文生成',
    description: '生成答辩状、代理词等完整法律文书。',
    unitLabel: '份文书',
    pointsPerUnit: 15,
  },
]

export const invoiceProfiles: InvoiceProfile[] = [
  {
    id: 'invoice-profile-001',
    title: '北京智律科技有限公司',
    taxNo: '91110108MA1234567A',
    type: 'enterprise',
    isDefault: true,
  },
]

export const invoiceRequests: InvoiceRequest[] = [
  {
    id: 'invoice-request-001',
    orderId: 'LV202609270001',
    title: '北京智律科技有限公司',
    taxNo: '91110108MA1234567A',
    registeredAddress: '北京市海淀区中关村南大街 27 号',
    registeredPhone: '010-88886666',
    bankName: '招商银行北京分行',
    bankAccount: '6225888888888888',
    recipientEmail: 'finance@zhilv.example',
    amountLabel: '¥199.00',
    status: 'draft',
  },
]

export const billingProviders: BillingProvider[] = [
  { id: 'alipay', label: '支付宝', enabled: true },
  { id: 'wechat', label: '微信支付', enabled: true },
]

export const billingPackages: BillingPackage[] = [
  {
    id: 'points-100',
    name: '积分包 100',
    amountFen: 1000,
    points: 100,
    description: '适合低频补充积分。',
  },
  {
    id: 'points-500',
    name: '积分包 500',
    amountFen: 4500,
    points: 500,
    description: '适合阶段性办案高峰。',
  },
  {
    id: 'pro-monthly',
    name: '专业版月付',
    amountFen: 19900,
    points: 2500,
    description: '包含更高积分额度与高级能力。',
  },
]

export const billingOrders: BillingOrder[] = [
  {
    id: 'payment-order-001',
    orderNo: 'LV202609270001',
    packageId: 'pro-monthly',
    packageName: '专业版月付',
    amountFen: 19900,
    points: 2500,
    channel: 'alipay',
    status: 'paid',
    qrCodeContent: 'https://pay.lawverify.com/mock/LV202609270001',
    createdAt: '2026-09-26T18:40:00+08:00',
    paidAt: '2026-09-26T18:45:00+08:00',
  },
  {
    id: 'payment-order-002',
    orderNo: 'LV202609250017',
    packageId: 'points-500',
    packageName: '积分包 500',
    amountFen: 4500,
    points: 500,
    channel: 'wechat',
    status: 'paid',
    qrCodeContent: 'https://pay.lawverify.com/mock/LV202609250017',
    createdAt: '2026-09-25T09:10:00+08:00',
    paidAt: '2026-09-25T09:16:00+08:00',
  },
  {
    id: 'payment-order-003',
    orderNo: 'LV202609240011',
    packageId: 'points-100',
    packageName: '积分包 100',
    amountFen: 1000,
    points: 100,
    channel: 'alipay',
    status: 'pending',
    qrCodeContent: 'https://pay.lawverify.com/mock/LV202609240011',
    createdAt: '2026-09-24T21:05:00+08:00',
  },
]
