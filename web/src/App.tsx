import { useEffect, useMemo, useState, type ReactNode } from 'react'
import QRCode from 'qrcode'

import { api, authStorage, consumeDesktopTokenFromUrl, isAuthApiError } from './api'
import { HeroSlogan } from './HeroSlogan'
import { AccountFeatures, ProductAnalytics } from './AccountFeatures'

type SiteRoute =
  | '/'
  | '/product'
  | '/pricing'
  | '/download'
  | '/docs'
  | '/login'
  | '/register'
  | '/console'
  | '/console/billing'
  | '/console/orders'
  | '/console/usage'
  | '/console/invoices'
  | '/console/profile'
  | '/admin'
  | '/admin/users'
  | '/admin/usage'
  | '/admin/feedback'

type PaymentChannel = 'alipay' | 'wechat'

interface NavItem {
  label: string
  href: SiteRoute
}

interface SitePlan {
  id: string
  name: string
  priceLabel: string
  billingCycle: string
  description: string
  highlights: string[]
  points: number
  recommended?: boolean
}

interface BillingPackage {
  id: string
  name: string
  amountFen: number
  points: number
  description: string
}

interface BillingProvider {
  id: PaymentChannel
  label: string
  enabled: boolean
  reason?: string
}

interface ReleaseItem {
  id: string
  version: string
  platform?: 'win32' | 'darwin'
  arch?: 'x64' | 'arm64'
  channel: string
  sizeLabel: string
  publishedAt: string
  sha256: string
  notes: string[]
  downloadUrl: string
  checksumUrl?: string
}

interface BillingOrder {
  id: string
  orderNo: string
  packageId: string
  packageName: string
  amountFen: number
  points: number
  channel: PaymentChannel
  status: 'pending' | 'paid' | 'closed' | 'failed'
  qrCodeContent: string
  paymentUrl?: string
  providerOrderId?: string
  createdAt: string
  paidAt?: string
}

interface UsageMetric {
  label: string
  value: string
}

interface PointPolicy {
  actionType: string
  label: string
  description: string
  unitLabel: string
  pointsPerUnit: number
}

interface PointLedgerItem {
  id: string
  createdAt: string
  description: string
  delta: number
  balanceAfter: number
  entryType?: 'recharge' | 'consume' | 'refund' | 'adjust' | 'freeze' | 'unfreeze'
  actionType?: string
  operationKey?: string
}

interface InvoiceRequest {
  id: string
  orderId: string
  title: string
  taxNo: string
  registeredAddress: string
  registeredPhone: string
  bankName: string
  bankAccount: string
  recipientEmail?: string
  amountLabel: string
  status: 'draft' | 'submitted' | 'issued'
}

interface InvoiceFormValue {
  title: string
  taxNo: string
  registeredAddress: string
  registeredPhone: string
  bankName: string
  bankAccount: string
  recipientEmail: string
}

interface AccountSummary {
  displayName: string
  email: string
  tierName: string
  pointsBalance: number
  subscriptionExpiresAt: string
}

interface SessionProfile {
  user: {
    id: string
    email: string
    name: string
  }
  organization: {
    id: string
    name: string
    membershipId?: string
    role: string
  }
}

interface DashboardData {
  plans: SitePlan[]
  packages: BillingPackage[]
  providers: BillingProvider[]
  releases: ReleaseItem[]
  orders: BillingOrder[]
  usage: UsageMetric[]
  pointPolicies: PointPolicy[]
  pointLedger: PointLedgerItem[]
  invoices: InvoiceRequest[]
  account: AccountSummary
  apiOnline: boolean
}

interface AdminTrendPoint {
  date: string
  label: string
  value: number
}

interface AdminDashboardMetrics {
  totalUsers: number
  totalOrganizations: number
  totalPointsConsumed: number
  userGrowthTrend: AdminTrendPoint[]
  tokenConsumptionTrend: AdminTrendPoint[]
}

interface AdminUserListItem {
  id: string
  email: string
  name: string
  createdAt: string
  pointsBalance: number
}

interface AdminUsersResponse {
  users: AdminUserListItem[]
}

interface AdminUsageUserItem {
  name: string
  email: string
  totalConsumed: number
  actionCount: number
  lastConsumedAt: string
}

interface AdminUsageLogItem {
  id: string
  name: string
  email: string
  actionType: string
  changePoints: number
  note: string
  createdAt: string
}

interface AdminUsageResponse {
  users: AdminUsageUserItem[]
  logs: AdminUsageLogItem[]
}

interface AdminFeedbackStatItem {
  key: 'bug' | 'suggestion' | 'experience' | 'other' | 'pending' | 'reviewing' | 'resolved' | 'ignored'
  label: string
  count: number
}

interface AdminFeedbackVersionItem {
  version: string
  count: number
}

interface AdminFeedbackKeywordItem {
  keyword: string
  count: number
}

interface AdminFeedbackUserItem {
  name: string
  email: string
  count: number
  lastSubmittedAt: string
}

interface AdminFeedbackItem {
  id: string
  userEmail: string
  userName: string
  feedbackType: 'bug' | 'suggestion' | 'experience' | 'other'
  feedbackTypeLabel: string
  title: string
  content: string
  contact?: string
  appVersion?: string
  clientPlatform?: string
  pageContext?: string
  caseName?: string
  status: 'pending' | 'reviewing' | 'resolved' | 'ignored'
  statusLabel: string
  adminNote?: string
  createdAt: string
  updatedAt: string
  handledAt?: string
  handledByEmail?: string
}

interface AdminFeedbackResponse {
  overview: {
    totalCount: number
    pendingCount: number
    reviewingCount: number
    resolvedCount: number
    ignoredCount: number
    last7DaysCount: number
    bugCount: number
    suggestionCount: number
  }
  trend: AdminTrendPoint[]
  typeStats: AdminFeedbackStatItem[]
  statusStats: AdminFeedbackStatItem[]
  versionStats: AdminFeedbackVersionItem[]
  topUsers: AdminFeedbackUserItem[]
  topKeywords: AdminFeedbackKeywordItem[]
  items: AdminFeedbackItem[]
}

const emptyInvoiceForm: InvoiceFormValue = {
  title: '',
  taxNo: '',
  registeredAddress: '',
  registeredPhone: '',
  bankName: '',
  bankAccount: '',
  recipientEmail: '',
}

const siteNav: NavItem[] = [
  { label: '产品介绍', href: '/product' },
  { label: '价格套餐', href: '/pricing' },
  { label: '下载中心', href: '/download' },
  { label: '帮助文档', href: '/docs' },
]

const consoleNav: NavItem[] = [
  { label: '控制台首页', href: '/console' },
  { label: '充值与套餐', href: '/console/billing' },
  { label: '订单记录', href: '/console/orders' },
  { label: '使用情况', href: '/console/usage' },
  { label: '发票管理', href: '/console/invoices' },
  { label: '账户资料', href: '/console/profile' },
]

const adminNav: NavItem[] = [
  { label: '系统概览', href: '/admin' },
  { label: '用户管理', href: '/admin/users' },
  { label: '使用统计', href: '/admin/usage' },
  { label: '用户反馈', href: '/admin/feedback' },
]

const fallbackData: DashboardData = {
  plans: [
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
      highlights: ['基础 AI 起草与证据核验'],
      points: 500,
    },
    {
      id: 'pro-monthly',
      name: '专业版',
      priceLabel: '¥199/月',
      billingCycle: 'monthly',
      description: '适合高频办案与知识库增强。',
      highlights: ['更高积分额度与优先模型能力'],
      points: 2500,
      recommended: true,
    },
    {
      id: 'team-custom',
      name: '团队版',
      priceLabel: '联系销售',
      billingCycle: 'custom',
      description: '适合律所团队与企业法务。',
      highlights: ['团队席位、组织权限与发票管理'],
      points: 0,
    },
  ],
  packages: [
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
  ],
  providers: [
    { id: 'alipay', label: '支付宝', enabled: false, reason: '待配置商户参数' },
    { id: 'wechat', label: '微信支付', enabled: false, reason: '待配置商户参数' },
  ],
  releases: [],
  orders: [],
  usage: [
    { label: '本月文书生成', value: '0 次' },
    { label: '证据理解', value: '0 次' },
    { label: '知识库检索', value: '0 次' },
    { label: '剩余积分', value: '0' },
  ],
  pointPolicies: [
    {
      actionType: 'evidence_match',
      label: '证据联动',
      description: '按争议焦点或主张语义，全篇分块执行深度证据匹配与事实穿透。',
      unitLabel: '次',
      pointsPerUnit: 20,
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
    {
      actionType: 'case_reference',
      label: '案例参照',
      description: '检索并筛选相似裁判案例。',
      unitLabel: '次',
      pointsPerUnit: 5,
    },
    {
      actionType: 'legal_check',
      label: '法条核对',
      description: '识别法条并核对官方法源内容。',
      unitLabel: '次',
      pointsPerUnit: 3,
    },
    {
      actionType: 'crosscheck_paragraph',
      label: '单段质证生成',
      description: '生成单段质证意见或单个争点回应。',
      unitLabel: '段',
      pointsPerUnit: 3,
    },
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
  ],
  pointLedger: [],
  invoices: [],
  account: {
    displayName: '未登录',
    email: '',
    tierName: '未开通套餐',
    pointsBalance: 0,
    subscriptionExpiresAt: '',
  },
  apiOnline: false,
}

function normalizeRoute(pathname: string): SiteRoute {
  const clean = pathname.replace(/\/+$/, '') || '/'
  const knownRoutes = new Set<SiteRoute>([
    '/',
    '/product',
    '/pricing',
    '/download',
    '/docs',
    '/login',
    '/register',
    '/console',
    '/console/billing',
    '/console/orders',
    '/console/usage',
    '/console/invoices',
    '/console/profile',
    '/admin',
    '/admin/users',
    '/admin/usage',
    '/admin/feedback',
  ])

  return knownRoutes.has(clean as SiteRoute) ? (clean as SiteRoute) : '/'
}

function formatCurrency(amountFen: number) {
  return `¥${(amountFen / 100).toFixed(2)}`
}

function formatChannel(channel: PaymentChannel) {
  return channel === 'wechat' ? '微信支付' : '支付宝'
}

function formatOrderStatus(status: BillingOrder['status']) {
  if (status === 'paid') {
    return '已支付'
  }
  if (status === 'closed') {
    return '已关闭'
  }
  if (status === 'failed') {
    return '支付失败'
  }
  return '待支付'
}

function formatInvoiceStatus(status: InvoiceRequest['status']) {
  if (status === 'issued') {
    return '已开票'
  }
  if (status === 'submitted') {
    return '审核中'
  }
  return '待申请'
}

function formatDateTime(value: string) {
  return value ? value.replace('T', ' ').slice(0, 16) : '-'
}

function formatAdminDateTime(value?: string) {
  if (!value) {
    return '-'
  }
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

function getAdminUsageDisplayName(item: { name?: string; email: string }) {
  return item.name?.trim() || item.email
}

function formatCompactStat(value: number) {
  if (value >= 1000000) {
    return `${(value / 1000000).toFixed(1)}M`
  }
  if (value >= 10000) {
    return `${(value / 10000).toFixed(1)}w`
  }
  return value.toLocaleString()
}

function getTrendLatestValue(trend: AdminTrendPoint[]) {
  return trend[trend.length - 1]?.value ?? 0
}

function getTrendIncrease(trend: AdminTrendPoint[]) {
  if (!trend.length) {
    return 0
  }
  return Math.max(getTrendLatestValue(trend) - trend[0].value, 0)
}

function getTrendPeakValue(trend: AdminTrendPoint[]) {
  return trend.reduce((peak, item) => Math.max(peak, item.value), 0)
}

function formatPointDelta(value: number) {
  const prefix = value > 0 ? '+' : ''
  return `${prefix}${value}`
}

function formatPointEntryType(value?: PointLedgerItem['entryType']) {
  switch (value) {
    case 'consume':
      return '消费'
    case 'refund':
      return '退款'
    case 'adjust':
      return '调账'
    case 'freeze':
      return '冻结'
    case 'unfreeze':
      return '解冻'
    case 'recharge':
    default:
      return '充值'
  }
}

function isPointPackage(item: BillingPackage) {
  return item.id.startsWith('points-')
}

function SiteLink({ item, current }: { item: NavItem; current: SiteRoute }) {
  const isActive = current === item.href
  return (
    <a className={`nav-link ${isActive ? 'active' : ''}`} href={item.href} aria-current={isActive ? 'page' : undefined}>
      {item.label}
    </a>
  )
}

function MarketingHero({
  eyebrow,
  title,
  description,
  primaryHref,
  primaryLabel,
  secondaryHref,
  secondaryLabel,
  badges,
  metrics,
  variantClassName = '',
}: {
  eyebrow: string
  title: string
  description: string
  primaryHref: string
  primaryLabel: string
  secondaryHref: string
  secondaryLabel: string
  badges?: string[]
  metrics: Array<{
    label: string
    value: string
    detail: string
  }>
  variantClassName?: string
}) {
  return (
    <section className={`hero-card site-hero ${variantClassName}`.trim()}>
      <div className="site-hero-copy">
        <span className="eyebrow">{eyebrow}</span>
        {variantClassName === 'site-hero-home' || variantClassName === 'site-hero-product'
          ? <HeroSlogan title={title} />
          : <h1>{title.split('\n').map((line, index) => (
            <span className={`hero-title-line${index > 0 ? ' hero-title-accent' : ''}`} key={line}>{line}</span>
          ))}</h1>}
        <p>{description}</p>
        <div className="hero-actions">
          <a className="primary-button" href={primaryHref}>{primaryLabel}</a>
          <a className="ghost-button" href={secondaryHref}>{secondaryLabel}</a>
        </div>
        {badges?.length ? (
          <div className="site-inline-badges">
            {badges.map((item) => (
              <span key={item}>{item}</span>
            ))}
          </div>
        ) : null}
      </div>
      <div className="site-hero-panel">
        <div className="hero-orbit" aria-hidden="true" />
        {metrics.map((item, index) => (
          <article key={`${item.label}-${item.value}`} className="site-hero-panel-card">
            <div className="hero-panel-label"><span>{item.label}</span><span aria-hidden="true">{String(index + 1).padStart(2, '0')}</span></div>
            <strong>{item.value}</strong>
            <p>{item.detail}</p>
          </article>
        ))}
      </div>
    </section>
  )
}

function HomePage({
  plans,
  packages,
}: {
  plans: SitePlan[]
  packages: BillingPackage[]
}) {
  const downloadHref = '/download'
  const pointPackages = packages.filter(isPointPackage)
  const highlightedPlans = plans.slice(0, 3)
  const strategicSignals = [
    {
      title: '材料很多，也能有条理',
      description: '从证据原件中梳理关键事实、证明目的与争议焦点，让办案思路更清晰。',
    },
    {
      title: '写作提速，判断不让步',
      description: '围绕案件材料生成质证意见，把时间留给论证、打磨与专业判断。',
    },
    {
      title: '每一处引用，都有来路',
      description: '证据、法条与案例在侧边联动查看，让核验跟得上写作的节奏。',
    },
  ]
  const workflow = [
    '导入案件材料与证据原件',
    '在桌面端完成证据理解、生成与核验',
    '逐句核验引用与证据关联',
    '导出文书，继续打磨专业表达',
  ]

  return (
    <div className="public-page-stack">
      <MarketingHero
        eyebrow="你的 AI 办案搭档"
        title={'少一点重复。\n多一点专业判断。'}
        description="整理证据、起草质证意见、核验引用。在同一个工作台，让材料有条理，让思路更清晰。"
        primaryHref={downloadHref}
        primaryLabel="下载客户端"
        secondaryHref="/product"
        secondaryLabel="看看能做什么"
        badges={['证据整理', '质证写作', '句级核验']}
        metrics={[
          { label: '理清材料', value: '证据，心中有数', detail: '关键事实与证明目的，一起梳理。' },
          { label: '专注表达', value: '文书，更进一步', detail: '生成与改写衔接，把精力放在论证上。' },
          { label: '有据可查', value: '引用，随时核验', detail: '证据、法条与案例，沿着引用找回原文。' },
        ]}
        variantClassName="site-hero-home"
      />

      <section className="site-stat-grid">
        {strategicSignals.map((item) => (
          <article key={item.title} className="site-stat-card">
            <span className="feature-kicker">为办案而设计</span>
            <h3>{item.title}</h3>
            <p>{item.description}</p>
          </article>
        ))}
      </section>

      <section className="card site-section-surface">
        <div className="section-head">
          <div>
            <h3>从材料到文书，顺着思路走</h3>
            <span className="muted">整理、写作、核验、导出，让每一步衔接起来。</span>
          </div>
        </div>
        <div className="site-flow-grid">
          {workflow.map((item, index) => (
            <article key={item} className="site-flow-step">
              <span className="site-flow-index">{index + 1}</span>
              <strong>{item}</strong>
            </article>
          ))}
        </div>
      </section>

      <section className="card site-section-surface">
        <div className="section-head">
          <div>
            <h3>订阅套餐</h3>
            <span className="muted">先从免费版体验，也可以按办案强度升级月度套餐。</span>
          </div>
          <a href="/console/billing">进入账户中心</a>
        </div>
        <div className="site-feature-grid">
          {highlightedPlans.map((plan) => (
            <article key={plan.id} className={`card nested-card site-feature-card ${plan.recommended ? 'recommended-card' : ''}`}>
              <span className="eyebrow">套餐</span>
              <h3>{plan.name}</h3>
              <strong className="price">{plan.priceLabel}</strong>
              <p>{plan.description}</p>
              <span className="muted">
                {plan.points > 0 ? `每月 ${plan.points.toLocaleString()} 积分` : '按团队方案定制额度'}
              </span>
            </article>
          ))}
        </div>
      </section>

      <section className="card site-section-surface">
        <div className="section-head">
          <div>
            <h3>单独购买积分</h3>
            <span className="muted">不想升级套餐时，也可以直接补充积分，按需使用。</span>
          </div>
          <a href="/console/billing">购买积分</a>
        </div>
        <div className="site-feature-grid">
          {pointPackages.map((item) => (
            <article key={item.id} className="card nested-card site-feature-card">
              <span className="eyebrow">积分包</span>
              <h3>{item.name}</h3>
              <strong className="price">{formatCurrency(item.amountFen)}</strong>
              <p>{item.description}</p>
              <span className="muted">到账 {item.points.toLocaleString()} 积分</span>
            </article>
          ))}
        </div>
      </section>

      <section className="card site-cta-band">
        <div>
          <span className="eyebrow">开始使用</span>
          <h3>下一份文书，试试更顺手的方式。</h3>
        </div>
        <div className="hero-actions">
          <a className="primary-button" href={downloadHref}>立即下载</a>
          <a className="ghost-button" href="/pricing">查看价格套餐</a>
        </div>
      </section>
    </div>
  )
}

function PricingPage({
  plans,
  packages,
}: {
  plans: SitePlan[]
  packages: BillingPackage[]
}) {
  const pointPackages = packages.filter(isPointPackage)
  const planDetails: Record<string, {
    badge: string
    summary: string
    suitable: string
    deliverables: string
    response: string
    collaboration: string
    invoice: string
    highlights: string[]
    ctaLabel: string
  }> = {
    'free-monthly': {
      badge: '先体验',
      summary: '适合先熟悉证据核验、文书生成和账户中心的完整流程。',
      suitable: '首次体验、轻量试用、低频办案',
      deliverables: '基础文书生成与证据核验',
      response: '标准响应',
      collaboration: '单人使用',
      invoice: '支持账户中心申请',
      highlights: ['每月 100 积分', '可进入完整工作流体验', '后续可按需补充积分'],
      ctaLabel: '免费开始',
    },
    'personal-monthly': {
      badge: '个人律师',
      summary: '适合个人律师持续处理庭审、答辩、举证质证和材料梳理。',
      suitable: '个人律师、轻量案件、高频单人作业',
      deliverables: '基础生成、证据核验与日常文稿整理',
      response: '高峰期优先',
      collaboration: '单人使用',
      invoice: '支持账户中心申请',
      highlights: ['每月 500 积分', '适合持续办案的月度方案', '优先保障高峰时段使用体验'],
      ctaLabel: '选择个人版',
    },
    'pro-monthly': {
      badge: '推荐方案',
      summary: '适合高频办案、长文生成、证据反复核验和法条案例协同参照。',
      suitable: '高频办案、复杂案件、长文反复打磨',
      deliverables: '整文生成、证据核验、法条核对、案例参照',
      response: '高峰期优先',
      collaboration: '个人主力账号',
      invoice: '支持账户中心申请',
      highlights: ['每月 2,500 积分', '更适合高频生成与复核', '当前官网主推的月度方案'],
      ctaLabel: '选择专业版',
    },
    'team-custom': {
      badge: '团队方案',
      summary: '适合律所团队和企业法务统一管理账户、席位、订单和开票。',
      suitable: '律所团队、企业法务、统一采购',
      deliverables: '支持组织级管理与更高额度',
      response: '专属方案沟通',
      collaboration: '组织席位与权限管理',
      invoice: '支持企业开票与统一结算',
      highlights: ['团队席位、组织权限与发票管理', '按团队规模定制额度与方案', '适合统一采购与集中管理'],
      ctaLabel: '联系方案咨询',
    },
  }

  const comparisonRows = [
    {
      label: '适合场景',
      values: plans.map((plan) => planDetails[plan.id]?.suitable || plan.description),
    },
    {
      label: '月度积分',
      values: plans.map((plan) => (plan.points > 0 ? `${plan.points.toLocaleString()} 积分` : '按方案定制')),
    },
    {
      label: '适合产出',
      values: plans.map((plan) => planDetails[plan.id]?.deliverables || '进入工作台处理案件'),
    },
    {
      label: '高峰时段体验',
      values: plans.map((plan) => planDetails[plan.id]?.response || '标准响应'),
    },
    {
      label: '协作方式',
      values: plans.map((plan) => planDetails[plan.id]?.collaboration || '单人使用'),
    },
    {
      label: '发票与结算',
      values: plans.map((plan) => planDetails[plan.id]?.invoice || '支持账户中心申请'),
    },
  ]

  const pricingFaqs = [
    {
      question: '积分怎么理解？',
      answer: '积分是 LawVerify 的统一使用额度，会随着证据摘要、整文生成、改写和其他办案动作按实际消耗扣减。',
    },
    {
      question: '免费版和月度套餐的区别是什么？',
      answer: '免费版适合先熟悉工作流，月度套餐更适合持续办案时稳定使用，额度更高、节奏更连贯。',
    },
    {
      question: '积分包适合什么场景？',
      answer: '当你不想升级月度套餐，但临时遇到庭前准备、集中出稿或案件高峰时，可以直接补充积分，不改变当前套餐层级。',
    },
    {
      question: '能否申请发票？',
      answer: '支持在账户中心提交企业开票信息并申请发票，适合个人执业和团队统一结算。',
    },
  ]

  return (
    <div className="public-page-stack">
      <MarketingHero
        eyebrow="价格套餐"
        title={'按你的节奏，\n选合适的方案。'}
        description="先免费体验，再按办案频次选择套餐。临时出稿高峰，也可以单独补充积分。"
        primaryHref="/console/billing"
        primaryLabel="进入账户中心"
        secondaryHref="/download"
        secondaryLabel="下载客户端"
        badges={['先体验后升级', '月度套餐 + 积分包', '支持企业开票与统一结算']}
        metrics={[
          { label: '轻松起步', value: '先体验，再决定', detail: '从免费版开始，找到适合自己的办案节奏。' },
          { label: '按需选择', value: '忙的时候，更灵活', detail: '月度套餐之外，积分也可以单独补充。' },
          { label: '团队使用', value: '一起办案，一起提效', detail: '支持团队方案与企业开票。' },
        ]}
        variantClassName="site-hero-pricing"
      />

      <section className="site-stat-grid">
        <article className="site-stat-card">
          <span>免费起步</span>
          <h3>先熟悉完整工作流</h3>
          <p>从真实案件材料开始体验，再决定适合自己的使用方案。</p>
        </article>
        <article className="site-stat-card">
          <span>高频办案</span>
          <h3>专业版更适合作为主力方案</h3>
          <p>适合复杂案件、长文反复打磨、证据反复核验与法条案例协同参照。</p>
        </article>
        <article className="site-stat-card">
          <span>团队采购</span>
          <h3>支持团队方案与统一结算</h3>
          <p>适合律所和企业法务进行组织化采购、权限管理和企业开票流程。</p>
        </article>
      </section>

      <section className="card site-section-surface">
        <div className="section-head">
          <div>
            <h3>月度套餐</h3>
            <span className="muted">先快速判断哪一档适合你，再去账户中心完成开通。</span>
          </div>
          <a href="/console/billing">进入账户中心</a>
        </div>
        <div className="pricing-plan-grid">
          {plans.map((plan) => (
            <article key={plan.id} className={`card nested-card pricing-plan-card site-feature-card ${plan.recommended ? 'recommended-card' : ''}`}>
              <div className="pricing-plan-head">
                <span className="eyebrow">{planDetails[plan.id]?.badge || '套餐'}</span>
                <h3>{plan.name}</h3>
                <strong className="price">{plan.priceLabel}</strong>
              </div>
              <p>{planDetails[plan.id]?.summary || plan.description}</p>
              <span className="muted">
                {plan.points > 0 ? `每月 ${plan.points.toLocaleString()} 积分` : '按团队方案定制额度'}
              </span>
              <ul className="pricing-feature-list">
                {(planDetails[plan.id]?.highlights || plan.highlights).map((item) => (
                  <li key={`${plan.id}-${item}`}>{item}</li>
                ))}
              </ul>
              <a className={`wide-button ${plan.recommended ? 'primary-button' : 'ghost-button'}`} href="/console/billing">
                {planDetails[plan.id]?.ctaLabel || '查看详情'}
              </a>
            </article>
          ))}
        </div>
      </section>

      <section className="card site-section-surface">
        <div className="section-head">
          <div>
            <h3>权益对照</h3>
            <span className="muted">先按办案场景判断，再确认每档在额度和协作方式上的差异。</span>
          </div>
        </div>
        <div className="pricing-compare-wrap">
          <table className="pricing-compare-table">
            <thead>
              <tr>
                <th>权益项</th>
                {plans.map((plan) => (
                  <th key={`head-${plan.id}`}>{plan.name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {comparisonRows.map((row) => (
                <tr key={row.label}>
                  <td>{row.label}</td>
                  {row.values.map((value, index) => (
                    <td key={`${row.label}-${plans[index]?.id || index}`}>{value}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card site-section-surface">
        <div className="section-head">
          <div>
            <h3>积分包补充</h3>
            <span className="muted">遇到庭前准备、集中出稿或案件高峰时，直接补充积分更灵活。</span>
          </div>
          <a href="/console/billing">购买积分</a>
        </div>
        <div className="pricing-points-grid">
          {pointPackages.map((item) => (
            <article key={item.id} className="card nested-card pricing-points-card site-feature-card">
              <span className="eyebrow">积分包</span>
              <h3>{item.name}</h3>
              <strong className="price">{formatCurrency(item.amountFen)}</strong>
              <p>{item.description}</p>
              <span className="muted">到账 {item.points.toLocaleString()} 积分</span>
              <span className="muted">适合不改套餐层级时的阶段性补充。</span>
            </article>
          ))}
        </div>
      </section>

      <section className="card site-section-surface">
        <div className="section-head">
          <div>
            <h3>常见问题</h3>
            <span className="muted">把影响开通决策的几个关键问题先讲清楚。</span>
          </div>
        </div>
        <div className="pricing-faq-grid">
          {pricingFaqs.map((item) => (
            <article key={item.question} className="nested-card pricing-faq-card site-feature-card">
              <strong>{item.question}</strong>
              <p className="muted">{item.answer}</p>
            </article>
          ))}
        </div>
      </section>
    </div>
  )
}

function DownloadPage({ releases }: { releases: ReleaseItem[] }) {
  const [showAll, setShowAll] = useState(false)
  const [target, setTarget] = useState(() => /Macintosh|MacIntel/i.test(navigator.userAgent + navigator.platform)
    ? 'darwin-arm64' : 'win32-x64')
  const targets = [
    { value: 'win32-x64', label: 'Windows' },
    { value: 'darwin-arm64', label: 'Mac · Apple 芯片' },
    { value: 'darwin-x64', label: 'Mac · Intel' },
  ]
  const selectedReleases = releases.filter((release) => `${release.platform ?? 'win32'}-${release.arch ?? 'x64'}` === target)
  const latestRelease = selectedReleases[0]
  const historicalReleases = selectedReleases.slice(1)
  const platformLabel = targets.find((item) => item.value === target)?.label ?? 'Windows'
  const installationFlow = [
    target.startsWith('darwin') ? '打开 DMG，将 LawVerify 拖入“应用程序”' : '下载安装包并完成本地安装',
    '使用官网账户登录客户端',
    '按需购买套餐或积分并开始使用',
  ]

  return (
    <div className="public-page-stack">
      <header className="page-intro">
        <span className="eyebrow">下载中心</span>
        <h1>你的工作台，随时就位。</h1>
        <p>Windows 或 Mac，选择适合你的版本。</p>
      </header>
      <div className="hero-actions download-platform-switch" aria-label="选择下载版本">
        {targets.map((item) => (
          <button key={item.value} type="button"
            className={target === item.value ? 'primary-button' : 'ghost-button'}
            aria-pressed={target === item.value}
            onClick={() => { setTarget(item.value); setShowAll(false) }}>
            {item.label}
          </button>
        ))}
      </div>
      <section className="card site-section-surface download-release-shell">
        <article className="download-highlight-card">
          <span className="eyebrow">安装流程</span>
          <h3>3 步完成下载与使用</h3>
          <div className="download-step-list">
            {installationFlow.map((item, index) => (
              <div key={item} className="download-step-item">
                <span className="site-flow-index">{index + 1}</span>
                <strong>{item}</strong>
              </div>
            ))}
          </div>
        </article>
        <article className="download-highlight-card">
          <span className="eyebrow">当前推荐</span>
          <h3>{latestRelease ? `LawVerify ${latestRelease.version}` : '暂无可下载版本'}</h3>
          <p className="muted">
            {latestRelease
              ? `${platformLabel}${latestRelease.channel === 'stable' ? ' 稳定版' : latestRelease.channel === 'test' ? ' 未签名测试版' : ''}，包体 ${latestRelease.sizeLabel}。`
              : `${platformLabel} 安装包暂未开放下载。`}
          </p>
          {latestRelease ? <a className="primary-button" href={latestRelease.downloadUrl}>下载最新版本</a> : null}
          {latestRelease?.channel === 'test' ? <p className="muted">
            {latestRelease.platform === 'darwin'
              ? '未进行 Apple Developer ID 签名及公证，首次打开可能需要在系统设置的“隐私与安全性”中允许。'
              : '未进行代码签名，Windows 可能显示未知发布者或 SmartScreen 提示。'}
          </p> : null}
          {latestRelease && /^[a-f0-9]{64}$/i.test(latestRelease.sha256) ? (
            <details className="download-checksum">
              <summary>安装包完整性校验</summary>
              <p className="muted">下载完成后再运行安装包。校验值不一致时，请重新下载。</p>
              <code>{latestRelease.sha256}</code>
              {latestRelease.checksumUrl ? <a className="ghost-button" href={latestRelease.checksumUrl}>下载 SHA256 校验文件</a> : null}
            </details>
          ) : null}
        </article>
      </section>

      <section className="card site-section-surface">
        <div className="section-head">
          <div>
            <h3>版本列表</h3>
            <span className="muted">{platformLabel}</span>
          </div>
        </div>
        <div className="table-like">
          {selectedReleases.length ? (
            <>
              <div key={latestRelease.id} className="table-row detailed">
                <strong>LawVerify {latestRelease.version} <span className="eyebrow" style={{ marginLeft: '8px' }}>最新</span></strong>
                <span>{platformLabel}</span>
                <span>{latestRelease.sizeLabel}</span>
                <span>{latestRelease.channel === 'test' ? '未签名测试版' : latestRelease.channel === 'stable' ? '稳定版' : latestRelease.channel}</span>
                <a className="primary-button" href={latestRelease.downloadUrl}>立即下载</a>
              </div>
              {historicalReleases.length > 0 ? (
                <>
                  <div
                    className="table-row"
                    style={{ cursor: 'pointer', justifyContent: 'center' }}
                    onClick={() => setShowAll(!showAll)}
                  >
                    <span className="muted">{showAll ? '收起历史版本' : '展开历史版本'}</span>
                  </div>
                  {showAll ? historicalReleases.map((release) => (
                    <div key={release.id} className="table-row detailed" style={{ opacity: 0.78 }}>
                      <strong>LawVerify {release.version}</strong>
                      <span>{platformLabel}</span>
                      <span>{release.sizeLabel}</span>
                      <span>{release.channel === 'test' ? '未签名测试版' : release.channel === 'stable' ? '稳定版' : release.channel}</span>
                      <a className="ghost-button" href={release.downloadUrl}>下载</a>
                    </div>
                  )) : null}
                </>
              ) : null}
            </>
          ) : (
            <div className="table-row detailed">
              <strong>暂无可下载版本</strong>
              <span>-</span>
              <span>-</span>
              <span>-</span>
              <span>请稍后查看</span>
            </div>
          )}
        </div>
      </section>
    </div>
  )
}

function ProductPage() {
  const downloadHref = '/download'
  const productPillars = [
    {
      title: '证据理解与质证生成',
      description: '围绕证据原件、证明目的、争议焦点和主张动作组织生成逻辑，减少律师重复整理工作。',
    },
    {
      title: '证据链与引用联动',
      description: '正文保持连续阅读，证据引用以侧边批注方式联动展示，让引用可追溯但不打断正文。',
    },
    {
      title: '法条与案例协同检索',
      description: '法律依据优先走知识库与结构化检索，案例参照对接外部权威来源，避免单一路径失真。',
    },
    {
      title: '案件级协作与沉淀',
      description: '支持围绕案件材料、知识库和办案方法持续积累，让一次处理不只服务当前文书。',
    },
  ]

  const workflow = [
    '导入案件材料与证据原件',
    '自动提炼争议事实与证明目标',
    '联动生成质证意见、法条依据与案例参照',
    '逐句核验引用，再导出文书继续打磨',
  ]

  const scenarios = [
    {
      title: '个人律师',
      description: '适合高频处理庭审、举证质证、答辩和材料梳理，减少从原件到成稿之间的重复劳动。',
    },
    {
      title: '律所团队',
      description: '适合多人协作管理案件资料、统一知识库、沉淀办案方法，并通过组织账户统一管理订单与开票。',
    },
    {
      title: '企业法务',
      description: '适合合规核验、合同争议分析和证据材料整理，让业务材料与法律结论之间保持可核验链路。',
    },
  ]

  return (
    <div className="public-page-stack">
      <MarketingHero
        eyebrow="面向律师办案"
        title={'理清每一份材料。\n写好每一份文书。'}
        description="从证据理解到质证写作，再到引用核验。让常用能力围绕案件衔接，让你专注于更重要的判断。"
        primaryHref={downloadHref}
        primaryLabel="下载客户端"
        secondaryHref="/console/billing"
        secondaryLabel="进入账户中心"
        badges={['连续文稿体验', '引用联动', '知识库与案例参照协同']}
        metrics={[
          { label: '顺手写作', value: '像文稿一样，连续', detail: '正文保持清爽，引用在侧边联动查看。' },
          { label: '认真核验', value: '每句话，都能回看', detail: '逐句定位证据，检查表达与原件的关联。' },
          { label: '积累经验', value: '办案方法，持续沉淀', detail: '案件梳理与知识库，支持后续写作和参照。' },
        ]}
        variantClassName="site-hero-product"
      />

      <section className="site-feature-grid">
        {productPillars.map((pillar) => (
          <article key={pillar.title} className="card site-feature-card">
            <span className="eyebrow">核心能力</span>
            <h3>{pillar.title}</h3>
            <p className="muted">{pillar.description}</p>
          </article>
        ))}
      </section>

      <section className="card product-flow-card site-section-surface">
        <div className="section-head">
          <div>
            <h3>工作流设计</h3>
            <span className="muted">让案件处理从原始材料进入结构化、可追溯、可交付的产出过程。</span>
          </div>
        </div>
        <div className="product-flow-grid">
          {workflow.map((item, index) => (
            <div key={item} className="product-flow-step">
              <span className="product-flow-index">{index + 1}</span>
              <strong>{item}</strong>
            </div>
          ))}
        </div>
      </section>

      <section className="site-feature-grid product-scenario-grid">
        {scenarios.map((scenario) => (
          <article key={scenario.title} className="card site-feature-card">
            <span className="eyebrow">适用场景</span>
            <h3>{scenario.title}</h3>
            <p className="muted">{scenario.description}</p>
          </article>
        ))}
      </section>

      <section className="card product-architecture-card site-section-surface">
        <div className="section-head">
          <div>
            <h3>让工作更连贯</h3>
            <span className="muted">材料、文稿、引用，在同一个办案工作台衔接。</span>
          </div>
        </div>
        <div className="product-architecture-grid">
          <div className="nested-card">
            <strong>桌面端工作台</strong>
            <span className="muted">负责案件、证据、质证文稿、知识库联动与本地高效操作。</span>
          </div>
          <div className="nested-card">
            <strong>官网与账户中心</strong>
            <span className="muted">负责套餐购买、积分管理、订单记录、发票申请与客户端分发。</span>
          </div>
          <div className="nested-card">
            <strong>引用与原文</strong>
            <span className="muted">从文稿回到证据原件，查看法条与案例参照，让依据有迹可循。</span>
          </div>
        </div>
      </section>

      <section className="card product-cta-card site-cta-band">
        <div className="section-head">
          <div>
            <h3>开始使用</h3>
            <span className="muted">先体验产品能力，再进入账户中心查看价格、订单、发票与客户端下载。</span>
          </div>
        </div>
        <div className="hero-actions">
          <a className="ghost-button" href="/pricing">查看价格套餐</a>
          <a className="ghost-button" href="/console/billing">进入账户中心</a>
        </div>
      </section>
    </div>
  )
}

function DocsPage() {
  const docEntries = [
    {
      title: '客户端下载与安装',
      description: '查看 Windows 与 Mac 安装包。',
      href: '/download',
      cta: '前往下载中心',
    },
    {
      title: '账户、套餐与积分',
      description: '登录账户中心，查看订单、积分与发票。',
      href: '/console/billing',
      cta: '前往账户中心',
    },
  ]

  return (
    <div className="public-page-stack">
      <section className="card site-section-surface">
        <div className="section-head">
          <div>
            <h3>帮助文档</h3>
          </div>
        </div>
        <div className="docs-grid">
          {docEntries.map((item) => (
            <article key={item.title} className="card docs-entry-card">
              <span className="eyebrow">文档入口</span>
              <h3>{item.title}</h3>
              <p className="muted">{item.description}</p>
              <a className="ghost-button" href={item.href}>{item.cta}</a>
            </article>
          ))}
        </div>
      </section>

    </div>
  )
}

function AuthPage({
  mode,
  busy,
  errorMessage,
  onSubmit,
}: {
  mode: 'login' | 'register'
  busy: boolean
  errorMessage: string
  onSubmit: (formData: FormData) => Promise<void>
}) {
  const title = mode === 'login' ? '登录账户中心' : '注册账户中心'
  const actionLabel = mode === 'login' ? '登录' : '注册并创建组织'

  return (
    <section className="auth-shell">
      <form
        className="card auth-card"
        onSubmit={(event) => {
          event.preventDefault()
          void onSubmit(new FormData(event.currentTarget))
        }}
      >
        <span className="eyebrow">账户中心</span>
        <h2>{title}</h2>
        <p className="muted">登录后即可查看订单、积分、发票和客户端下载权益。</p>

        {mode === 'register' ? (
          <>
            <label>
              机构名称
              <input name="organizationName" placeholder="例如：北京市某某律师事务所" required />
            </label>
            <label>
              负责人姓名
              <input name="ownerName" placeholder="请输入负责人姓名" required />
            </label>
            <label>
              邀请码（选填）
              <input name="inviteCode" maxLength={16} defaultValue={new URLSearchParams(window.location.search).get('invite') ?? ''} />
            </label>
          </>
        ) : null}

        <label>
          注册邮箱
          <input name="email" type="text" placeholder="请输入注册邮箱" required />
        </label>
        <label>
          密码
          <input name="password" type="password" placeholder="至少 6 位密码" required minLength={6} />
        </label>

        {errorMessage ? <div className="form-error">{errorMessage}</div> : null}

        <button className="primary-button wide-button" type="submit" disabled={busy}>
          {busy ? '提交中...' : actionLabel}
        </button>
        <div className="auth-switch">
          {mode === 'login' ? (
            <a href="/register">还没有账号？立即注册</a>
          ) : (
            <a href="/login">已有账号？去登录</a>
          )}
        </div>
      </form>
    </section>
  )
}

function ConsoleLayout({
  route,
  data,
  profile,
  billingNotice,
  billingBusy,
  invoiceNotice,
  invoiceBusy,
  invoiceForm,
  invoiceFormOpen,
  selectedChannel,
  onSelectChannel,
  onCreateOrder,
  onCompleteDevelopmentOrder,
  onInvoiceFormChange,
  onToggleInvoiceForm,
  onCreateInvoiceRequest,
}: {
  route: SiteRoute
  data: DashboardData
  profile: SessionProfile | null
  billingNotice: string
  billingBusy: boolean
  invoiceNotice: string
  invoiceBusy: boolean
  invoiceForm: InvoiceFormValue
  invoiceFormOpen: boolean
  selectedChannel: PaymentChannel
  onSelectChannel: (channel: PaymentChannel) => void
  onCreateOrder: (packageId: string) => Promise<void>
  onCompleteDevelopmentOrder: (orderId: string) => Promise<void>
  onInvoiceFormChange: (field: keyof InvoiceFormValue, value: string) => void
  onToggleInvoiceForm: () => void
  onCreateInvoiceRequest: (payload: InvoiceFormValue) => Promise<void>
}) {
  return (
    <section className="console-shell">
      <aside className="console-sidebar card">
        <div>
          <span className="eyebrow">账户中心</span>
          <h2>{data.account.displayName}</h2>
          <p className="muted">{profile?.organization.name || data.account.tierName}</p>
          <p className="muted">积分余额 {data.account.pointsBalance.toLocaleString()}</p>
        </div>
        <nav className="console-nav">
            {consoleNav.map((item) => (
              <SiteLink key={item.href} item={item} current={route} />
            ))}
          </nav>
      </aside>
      <div className="console-main">
        {route === '/console' ? <ConsoleHome data={data} /> : null}
        {route === '/console/billing' ? (
          <BillingPage
            data={data}
            billingBusy={billingBusy}
            billingNotice={billingNotice}
            selectedChannel={selectedChannel}
            onSelectChannel={onSelectChannel}
            onCreateOrder={onCreateOrder}
            onCompleteDevelopmentOrder={onCompleteDevelopmentOrder}
          />
        ) : null}
        {route === '/console/orders' ? <OrdersPage orders={data.orders} /> : null}
        {route === '/console/usage' ? <UsagePage data={data} /> : null}
        {route === '/console/invoices' ? (
          <InvoicesPage
            invoices={data.invoices}
            invoiceBusy={invoiceBusy}
            invoiceNotice={invoiceNotice}
            invoiceForm={invoiceForm}
            invoiceFormOpen={invoiceFormOpen}
            onInvoiceFormChange={onInvoiceFormChange}
            onToggleInvoiceForm={onToggleInvoiceForm}
            onCreateInvoiceRequest={onCreateInvoiceRequest}
          />
        ) : null}
        {route === '/console/profile' ? <ProfilePage account={data.account} profile={profile} /> : null}
      </div>
    </section>
  )
}

function AdminLayout({ route, data }: { route: SiteRoute; data: DashboardData }) {
  const currentLabel = adminNav.find((item) => item.href === route)?.label ?? '系统概览'

  return (
    <section className="admin-shell">
      <aside className="admin-sidebar card">
        <div className="admin-sidebar-head">
          <span className="eyebrow">管理后台</span>
          <h2>超级管理员</h2>
          <p className="muted">{data.account.email}</p>
        </div>
        <div className="admin-sidebar-panel">
          <strong>LawVerify Admin Console</strong>
          <span className="muted">面向平台运营、账户管理与使用监控的统一工作台。</span>
        </div>
        <nav className="console-nav">
          {adminNav.map((item) => (
            <SiteLink key={item.href} item={item} current={route} />
          ))}
        </nav>
        <div className="admin-sidebar-footer">
          <div className="admin-sidebar-panel admin-sidebar-panel-subtle">
            <span className="muted">当前视图</span>
            <strong>{currentLabel}</strong>
          </div>
          <a
            className="ghost-button"
            href="/"
            onClick={() => {
              localStorage.removeItem('lawverify-cloud-token')
              sessionStorage.removeItem('lawverify-login-account')
            }}
            style={{ width: '100%', justifyContent: 'center' }}
          >
            退出登录
          </a>
        </div>
      </aside>
      <div className="admin-main">
        {route === '/admin' ? <AdminDashboardPage /> : null}
        {route === '/admin/users' ? <AdminUsersPage /> : null}
        {route === '/admin/usage' ? <><AdminUsagePage /><ProductAnalytics /></> : null}
        {route === '/admin/feedback' ? <AdminFeedbackPage /> : null}
      </div>
    </section>
  )
}

function AdminPageHeader({
  eyebrow,
  title,
  description,
  metaLabel,
  metaValue,
  metaDescription,
}: {
  eyebrow: string
  title: string
  description: string
  metaLabel: string
  metaValue: string
  metaDescription: string
}) {
  return (
    <section className="card admin-page-hero">
      <div className="admin-page-hero-copy">
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      <div className="admin-page-hero-meta">
        <span>{metaLabel}</span>
        <strong>{metaValue}</strong>
        <p>{metaDescription}</p>
      </div>
    </section>
  )
}

function AdminMetricCard({
  label,
  value,
  detail,
  tone = 'blue',
}: {
  label: string
  value: string
  detail: string
  tone?: 'blue' | 'violet' | 'emerald' | 'amber'
}) {
  return (
    <article className={`admin-metric-card admin-metric-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <p>{detail}</p>
    </article>
  )
}

function AdminDataCard({
  title,
  description,
  action,
  children,
  className = '',
}: {
  title: string
  description?: string
  action?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={`card admin-data-card ${className}`.trim()}>
      <div className="section-head admin-section-head">
        <div>
          <h3>{title}</h3>
          {description ? <p className="muted">{description}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}

function TrendLineChart({
  title,
  hint,
  accentClassName,
  data,
}: {
  title: string
  hint: string
  accentClassName: string
  data: AdminTrendPoint[]
}) {
  const chart = useMemo(() => {
    if (!data.length) {
      return {
        path: '',
        areaPath: '',
        maxValue: 0,
      }
    }

    const width = 640
    const height = 220
    const paddingX = 20
    const paddingTop = 18
    const paddingBottom = 28
    const drawableWidth = width - paddingX * 2
    const drawableHeight = height - paddingTop - paddingBottom
    const maxValue = Math.max(...data.map((item) => item.value), 1)

    const points = data.map((item, index) => {
      const x = paddingX + (drawableWidth * index) / Math.max(data.length - 1, 1)
      const y = paddingTop + drawableHeight - (item.value / maxValue) * drawableHeight
      return { x, y }
    })

    const path = points
      .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
      .join(' ')
    const areaPath = `${path} L ${points[points.length - 1].x.toFixed(2)} ${(height - paddingBottom).toFixed(2)} L ${points[0].x.toFixed(2)} ${(height - paddingBottom).toFixed(2)} Z`

    return {
      path,
      areaPath,
      maxValue,
    }
  }, [data])

  return (
    <section className="card admin-data-card admin-chart-card">
      <div className="section-head admin-section-head">
        <div>
          <h3>{title}</h3>
          <p className="muted">{hint}</p>
        </div>
        <strong className={`admin-chart-highlight ${accentClassName}`}>
          {data[data.length - 1]?.value.toLocaleString() ?? 0}
        </strong>
      </div>
      {data.length ? (
        <div className="admin-chart-shell">
          <svg className={`admin-chart-svg ${accentClassName}`} viewBox="0 0 640 220" role="img" aria-label={title}>
            <defs>
              <linearGradient id={`${accentClassName}-gradient`} x1="0%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" stopColor="currentColor" stopOpacity="0.28" />
                <stop offset="100%" stopColor="currentColor" stopOpacity="0.02" />
              </linearGradient>
            </defs>
            <line x1="20" y1="192" x2="620" y2="192" className="admin-chart-axis" />
            <path d={chart.areaPath} fill={`url(#${accentClassName}-gradient)`} />
            <path d={chart.path} fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <div className="admin-chart-labels">
            <span>{data[0]?.label}</span>
            <span>峰值 {chart.maxValue.toLocaleString()}</span>
            <span>{data[data.length - 1]?.label}</span>
          </div>
        </div>
      ) : (
        <p className="muted">暂无趋势数据</p>
      )}
    </section>
  )
}

function AdminDashboardPage() {
  const [metrics, setMetrics] = useState<AdminDashboardMetrics | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    api.getAdminDashboard()
      .then((res) => setMetrics(res))
      .catch((err) => setError(err instanceof Error ? err.message : '获取系统管理数据失败'))
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return (
      <div className="admin-page-stack">
        <AdminPageHeader
          eyebrow="系统概览"
          title="平台运行总览"
          description="从整体规模、用户增长与积分消耗三个维度，快速把握平台当前运营状态。"
          metaLabel="状态"
          metaValue="数据加载中"
          metaDescription="正在从云端读取管理员仪表盘数据。"
        />
        <section className="card admin-feedback-card">
          <p className="muted">正在加载数据...</p>
        </section>
      </div>
    )
  }

  if (error || !metrics) {
    return (
      <div className="admin-page-stack">
        <AdminPageHeader
          eyebrow="系统概览"
          title="平台运行总览"
          description="从整体规模、用户增长与积分消耗三个维度，快速把握平台当前运营状态。"
          metaLabel="状态"
          metaValue="加载失败"
          metaDescription="管理员数据暂时不可用，请稍后重试。"
        />
        <section className="card admin-feedback-card">
          <div className="notice error">{error || '未找到数据'}</div>
        </section>
      </div>
    )
  }

  const latestUsers = getTrendLatestValue(metrics.userGrowthTrend)
  const recentUserGrowth = getTrendIncrease(metrics.userGrowthTrend)
  const usagePeak = getTrendPeakValue(metrics.tokenConsumptionTrend)
  const latestConsumption = getTrendLatestValue(metrics.tokenConsumptionTrend)

  return (
    <div className="admin-page-stack">
      <AdminPageHeader
        eyebrow="系统概览"
        title="平台运行总览"
        description="以更宽的运营驾驶舱视角查看用户规模、组织增长与积分消耗走势，让关键信号一眼可见。"
        metaLabel="当前用户规模"
        metaValue={formatCompactStat(metrics.totalUsers)}
        metaDescription="聚合所有已注册平台用户，用于判断总体体量。"
      />
      <section className="admin-metric-grid">
        <AdminMetricCard label="总用户数" value={metrics.totalUsers.toLocaleString()} detail="平台累计注册用户规模" tone="blue" />
        <AdminMetricCard label="总机构数" value={metrics.totalOrganizations.toLocaleString()} detail="已建立组织或律所主体数量" tone="violet" />
        <AdminMetricCard label="累计消耗积分" value={metrics.totalPointsConsumed.toLocaleString()} detail="反映平台已发生的真实使用量" tone="amber" />
        <AdminMetricCard label="近 30 天新增用户" value={recentUserGrowth.toLocaleString()} detail={`当前累计 ${latestUsers.toLocaleString()} 用户`} tone="emerald" />
      </section>
      <div className="admin-chart-grid">
        <TrendLineChart
          title="用户增长曲线"
          hint="按近 30 天累计用户数生成趋势线"
          accentClassName="admin-chart-blue"
          data={metrics.userGrowthTrend}
        />
        <TrendLineChart
          title="Token/积分消耗曲线"
          hint="当前按真实积分消耗流水统计近 30 天变化"
          accentClassName="admin-chart-violet"
          data={metrics.tokenConsumptionTrend}
        />
      </div>
      <section className="admin-insight-grid">
        <article className="admin-insight-card">
          <span>增长观察</span>
          <strong>{recentUserGrowth.toLocaleString()}</strong>
          <p>近 30 天累计新增用户，便于判断最近一段时间的平台拉新趋势。</p>
        </article>
        <article className="admin-insight-card">
          <span>消耗峰值</span>
          <strong>{usagePeak.toLocaleString()}</strong>
          <p>近 30 天单日积分消耗峰值，当前最新值为 {latestConsumption.toLocaleString()}。</p>
        </article>
      </section>
    </div>
  )
}

function AdminUsersPage() {
  const [data, setData] = useState<AdminUsersResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    api.getAdminUsers()
      .then((res) => setData(res))
      .catch((err) => setError(err instanceof Error ? err.message : '获取用户列表失败'))
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return (
      <div className="admin-page-stack">
        <AdminPageHeader
          eyebrow="用户管理"
          title="平台用户视图"
          description="从注册节奏、账户余额和用户明细三方面查看平台用户状态。"
          metaLabel="状态"
          metaValue="数据加载中"
          metaDescription="正在读取用户列表与余额数据。"
        />
        <section className="card admin-feedback-card">
          <p className="muted">正在加载数据...</p>
        </section>
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="admin-page-stack">
        <AdminPageHeader
          eyebrow="用户管理"
          title="平台用户视图"
          description="从注册节奏、账户余额和用户明细三方面查看平台用户状态。"
          metaLabel="状态"
          metaValue="加载失败"
          metaDescription="用户数据暂时不可用，请稍后刷新。"
        />
        <section className="card admin-feedback-card">
          <div className="notice error">{error || '未找到数据'}</div>
        </section>
      </div>
    )
  }

  const users = [...data.users].sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
  const totalBalance = users.reduce((sum, user) => sum + user.pointsBalance, 0)
  const activeBalanceUsers = users.filter((user) => user.pointsBalance > 0).length
  const newestUser = users[0]
  const averageBalance = users.length ? Math.round(totalBalance / users.length) : 0

  return (
    <div className="admin-page-stack">
      <AdminPageHeader
        eyebrow="用户管理"
        title="平台用户视图"
        description="让用户规模、余额状态与注册节奏同时呈现在一个更克制、更有呼吸感的管理界面里。"
        metaLabel="最新注册"
        metaValue={newestUser ? newestUser.name || newestUser.email : '-'}
        metaDescription={newestUser ? formatAdminDateTime(newestUser.createdAt) : '暂无注册记录'}
      />
      <section className="admin-metric-grid">
        <AdminMetricCard label="注册用户总数" value={users.length.toLocaleString()} detail="当前已创建平台账号的用户数量" tone="blue" />
        <AdminMetricCard label="平均积分余额" value={averageBalance.toLocaleString()} detail="按用户维度计算的账户余额均值" tone="violet" />
        <AdminMetricCard label="有余额用户" value={activeBalanceUsers.toLocaleString()} detail="积分余额大于 0 的账户数量" tone="emerald" />
        <AdminMetricCard label="累计账户余额" value={totalBalance.toLocaleString()} detail="所有账户当前可用积分总和" tone="amber" />
      </section>
      <AdminDataCard
        title="用户列表"
        description="按最新注册时间排序，方便快速查看新增用户和账户余额情况。"
        action={<span className="admin-table-meta">共 {users.length.toLocaleString()} 位用户</span>}
      >
        {users.length > 0 ? (
          <div className="table-responsive">
            <table className="table admin-table">
              <thead>
                <tr>
                  <th>序号</th>
                  <th>姓名</th>
                  <th>邮箱/账号</th>
                  <th>注册时间</th>
                  <th>积分余额</th>
                </tr>
              </thead>
              <tbody>
                {users.map((user, index) => (
                  <tr key={user.id}>
                    <td className="admin-rank-cell">{index + 1}</td>
                    <td>
                      <div className="admin-user-name-cell">
                        <strong>{user.name || '未命名用户'}</strong>
                        <span>{user.pointsBalance > 0 ? '账户可继续使用' : '当前余额为 0'}</span>
                      </div>
                    </td>
                    <td>{user.email}</td>
                    <td>{formatAdminDateTime(user.createdAt)}</td>
                    <td>
                      <span className="admin-points-badge">{user.pointsBalance.toLocaleString()} 积分</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">暂无用户注册记录</p>
        )}
      </AdminDataCard>
    </div>
  )
}

function AdminUsagePage() {
  const [data, setData] = useState<AdminUsageResponse | null>(null)
  const [sortMode, setSortMode] = useState<'consumed_desc' | 'consumed_asc'>('consumed_desc')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    api.getAdminUsage()
      .then((res) => setData(res))
      .catch((err) => setError(err instanceof Error ? err.message : '获取使用情况失败'))
      .finally(() => setLoading(false))
  }, [])

  const rankedUsers = useMemo(() => {
    if (!data?.users) {
      return []
    }

    const items = [...data.users]
    items.sort((left, right) => {
      if (sortMode === 'consumed_asc') {
        if (left.totalConsumed !== right.totalConsumed) {
          return left.totalConsumed - right.totalConsumed
        }
        return left.actionCount - right.actionCount
      }
      if (right.totalConsumed !== left.totalConsumed) {
        return right.totalConsumed - left.totalConsumed
      }
      return right.actionCount - left.actionCount
    })
    return items
  }, [data, sortMode])

  if (loading) {
    return (
      <div className="admin-page-stack">
        <AdminPageHeader
          eyebrow="使用统计"
          title="平台消耗与调用分析"
          description="从账户消耗排行与近期调用动态两个角度，观察平台使用强度和异常波动。"
          metaLabel="状态"
          metaValue="数据加载中"
          metaDescription="正在读取积分消耗与调用日志。"
        />
        <section className="card admin-feedback-card">
          <p className="muted">正在加载数据...</p>
        </section>
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="admin-page-stack">
        <AdminPageHeader
          eyebrow="使用统计"
          title="平台消耗与调用分析"
          description="从账户消耗排行与近期调用动态两个角度，观察平台使用强度和异常波动。"
          metaLabel="状态"
          metaValue="加载失败"
          metaDescription="当前无法读取积分消耗数据，请稍后重试。"
        />
        <section className="card admin-feedback-card">
          <div className="notice error">{error || '未找到数据'}</div>
        </section>
      </div>
    )
  }

  const totalConsumed = rankedUsers.reduce((sum, user) => sum + user.totalConsumed, 0)
  const totalActions = rankedUsers.reduce((sum, user) => sum + user.actionCount, 0)
  const topUser = rankedUsers[0]
  const spotlightUsers = rankedUsers.slice(0, 3)
  const recentLogs = data.logs.slice(0, 12)

  return (
    <div className="admin-page-stack">
      <AdminPageHeader
        eyebrow="使用统计"
        title="平台消耗与调用分析"
        description="把高频账户、调用强度与最近消耗动态放进同一块宽屏画布里，让运营判断更直接。"
        metaLabel="最高消耗账户"
        metaValue={topUser ? getAdminUsageDisplayName(topUser) : '-'}
        metaDescription={topUser ? `累计消耗 ${topUser.totalConsumed.toLocaleString()} 积分` : '暂无消耗排行数据'}
      />
      <section className="admin-metric-grid">
        <AdminMetricCard label="累计消耗积分" value={totalConsumed.toLocaleString()} detail="已聚合进入排行的总积分消耗" tone="amber" />
        <AdminMetricCard label="累计调用次数" value={totalActions.toLocaleString()} detail="按用户维度合并后的调用总数" tone="blue" />
        <AdminMetricCard label="涉及账户数" value={rankedUsers.length.toLocaleString()} detail="至少发生过一次消耗的账户数量" tone="violet" />
        <AdminMetricCard label="最近动态条数" value={data.logs.length.toLocaleString()} detail="可用于观察当前平台使用热度" tone="emerald" />
      </section>
      {spotlightUsers.length ? (
        <section className="admin-spotlight-grid">
          {spotlightUsers.map((user, index) => (
            <article key={user.email} className="admin-spotlight-card">
              <span>TOP {index + 1}</span>
              <strong>{getAdminUsageDisplayName(user)}</strong>
              <p>{user.email}</p>
              <p>累计消耗 {user.totalConsumed.toLocaleString()} 积分，调用 {user.actionCount.toLocaleString()} 次。</p>
            </article>
          ))}
        </section>
      ) : null}
      <div className="admin-usage-grid">
        <AdminDataCard
          title="按用户消耗统计"
          description="按用户聚合全部消费记录，可按消耗量排序。"
          className="admin-usage-primary"
          action={(
            <label className="admin-filter">
              <span>排序方式</span>
              <select
                className="streamlined-case-select"
                value={sortMode}
                onChange={(event) => setSortMode(event.target.value as 'consumed_desc' | 'consumed_asc')}
              >
                <option value="consumed_desc">消耗量从高到低</option>
                <option value="consumed_asc">消耗量从低到高</option>
              </select>
            </label>
          )}
        >
          {rankedUsers.length > 0 ? (
            <div className="table-responsive">
              <table className="table admin-table">
                <thead>
                  <tr>
                    <th>排名</th>
                    <th>用户账号</th>
                    <th>累计消耗</th>
                    <th>调用次数</th>
                    <th>最近消耗时间</th>
                  </tr>
                </thead>
                <tbody>
                  {rankedUsers.map((user, index) => (
                    <tr key={user.email}>
                      <td className="admin-rank-cell">{index + 1}</td>
                      <td>
                        <div className="admin-user-name-cell">
                          <strong>{getAdminUsageDisplayName(user)}</strong>
                          <span>{user.email}</span>
                        </div>
                      </td>
                      <td><span className="admin-points-badge admin-points-badge-warm">{user.totalConsumed.toLocaleString()} 积分</span></td>
                      <td>{user.actionCount.toLocaleString()}</td>
                      <td>{formatAdminDateTime(user.lastConsumedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted">暂无按用户聚合的消耗数据</p>
          )}
        </AdminDataCard>
        <AdminDataCard
          title="近期消耗动态"
          description="把最近消费动作做成活动流，方便快速查看谁在何时做了什么。"
          className="admin-usage-secondary"
          action={<span className="admin-table-meta">最近 {recentLogs.length} 条</span>}
        >
          {recentLogs.length > 0 ? (
            <div className="admin-activity-list">
              {recentLogs.map((log) => (
                <article key={log.id} className="admin-activity-item">
                  <div className="admin-activity-head">
                    <strong>{log.actionType}</strong>
                    <span className="admin-points-badge admin-points-badge-warm">{log.changePoints} 积分</span>
                  </div>
                  <span className="admin-activity-account">{getAdminUsageDisplayName(log)}</span>
                  <span className="admin-activity-account">{log.email}</span>
                  <p>{log.note || '暂无备注信息'}</p>
                  <time>{formatAdminDateTime(log.createdAt)}</time>
                </article>
              ))}
            </div>
          ) : (
            <p className="muted">暂无使用记录</p>
          )}
        </AdminDataCard>
      </div>
    </div>
  )
}

function getAdminFeedbackStatusTone(status: AdminFeedbackItem['status']) {
  if (status === 'resolved') {
    return 'resolved'
  }
  if (status === 'reviewing') {
    return 'reviewing'
  }
  if (status === 'ignored') {
    return 'ignored'
  }
  return 'pending'
}

function AdminFeedbackPage() {
  const [data, setData] = useState<AdminFeedbackResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | AdminFeedbackItem['status']>('all')
  const [typeFilter, setTypeFilter] = useState<'all' | AdminFeedbackItem['feedbackType']>('all')
  const [updatingId, setUpdatingId] = useState('')

  useEffect(() => {
    api.getAdminFeedback()
      .then((res) => setData(res))
      .catch((err) => setError(err instanceof Error ? err.message : '获取用户反馈失败'))
      .finally(() => setLoading(false))
  }, [])

  const filteredItems = useMemo(() => {
    if (!data?.items) {
      return []
    }

    return data.items.filter((item) => {
      if (statusFilter !== 'all' && item.status !== statusFilter) {
        return false
      }
      if (typeFilter !== 'all' && item.feedbackType !== typeFilter) {
        return false
      }
      return true
    })
  }, [data, statusFilter, typeFilter])

  async function handleFeedbackStatusChange(item: AdminFeedbackItem, nextStatus: AdminFeedbackItem['status']) {
    if (nextStatus === item.status) {
      return
    }

    setUpdatingId(item.id)
    try {
      const result = await api.updateAdminFeedback({
        id: item.id,
        status: nextStatus,
      })
      setData((current) => current ? {
        ...current,
        items: current.items.map((entry) => entry.id === item.id ? {
          ...entry,
          status: result.item.status,
          statusLabel: result.item.statusLabel,
          updatedAt: result.item.updatedAt,
          handledAt: result.item.handledAt,
          handledByEmail: result.item.handledByEmail,
        } : entry),
        overview: {
          ...current.overview,
          pendingCount: current.items.reduce((sum, entry) => sum + (entry.id === item.id ? (result.item.status === 'pending' ? 1 : 0) : (entry.status === 'pending' ? 1 : 0)), 0),
          reviewingCount: current.items.reduce((sum, entry) => sum + (entry.id === item.id ? (result.item.status === 'reviewing' ? 1 : 0) : (entry.status === 'reviewing' ? 1 : 0)), 0),
          resolvedCount: current.items.reduce((sum, entry) => sum + (entry.id === item.id ? (result.item.status === 'resolved' ? 1 : 0) : (entry.status === 'resolved' ? 1 : 0)), 0),
          ignoredCount: current.items.reduce((sum, entry) => sum + (entry.id === item.id ? (result.item.status === 'ignored' ? 1 : 0) : (entry.status === 'ignored' ? 1 : 0)), 0),
        },
        statusStats: current.statusStats.map((stat) => ({
          ...stat,
          count: current.items.reduce((sum, entry) => {
            const status = entry.id === item.id ? result.item.status : entry.status
            return sum + (status === stat.key ? 1 : 0)
          }, 0),
        })),
      } : current)
    } catch (err) {
      window.alert(err instanceof Error ? err.message : '更新反馈状态失败')
    } finally {
      setUpdatingId('')
    }
  }

  if (loading) {
    return (
      <div className="admin-page-stack">
        <AdminPageHeader
          eyebrow="用户反馈"
          title="反馈统计与分析"
          description="聚合桌面端用户提交的真实反馈，按趋势、分类、状态和关键词观察产品问题与需求信号。"
          metaLabel="状态"
          metaValue="数据加载中"
          metaDescription="正在读取桌面端反馈与分析数据。"
        />
        <section className="card admin-feedback-card">
          <p className="muted">正在加载数据...</p>
        </section>
      </div>
    )
  }

  if (!data) {
    return (
      <div className="admin-page-stack">
        <AdminPageHeader
          eyebrow="用户反馈"
          title="反馈统计与分析"
          description="聚合桌面端用户提交的真实反馈，按趋势、分类、状态和关键词观察产品问题与需求信号。"
          metaLabel="状态"
          metaValue="加载失败"
          metaDescription="当前无法读取反馈统计数据，请稍后重试。"
        />
        <section className="card admin-feedback-card">
          <div className="notice error">{error || '未找到数据'}</div>
        </section>
      </div>
    )
  }

  const handledCount = data.overview.resolvedCount + data.overview.ignoredCount
  const handledRate = data.overview.totalCount ? Math.round((handledCount / data.overview.totalCount) * 100) : 0
  const latestFeedback = data.items[0]
  const trendPeak = getTrendPeakValue(data.trend)

  return (
    <div className="admin-page-stack">
      <AdminPageHeader
        eyebrow="用户反馈"
        title="反馈统计与分析"
        description="把桌面端真实反馈沉淀为可运营的数据面板，帮助快速识别高频问题、版本波动和重点用户诉求。"
        metaLabel="最近反馈"
        metaValue={latestFeedback ? latestFeedback.userName || latestFeedback.userEmail : '-'}
        metaDescription={latestFeedback ? formatAdminDateTime(latestFeedback.createdAt) : '暂无反馈记录'}
      />
      <section className="admin-metric-grid">
        <AdminMetricCard label="反馈总量" value={data.overview.totalCount.toLocaleString()} detail="累计收到的桌面端反馈条数" tone="blue" />
        <AdminMetricCard label="近 7 天新增" value={data.overview.last7DaysCount.toLocaleString()} detail="观察最近一周问题与建议密度" tone="violet" />
        <AdminMetricCard label="待处理反馈" value={data.overview.pendingCount.toLocaleString()} detail="尚未进入处理流程的反馈" tone="amber" />
        <AdminMetricCard label="闭环率" value={`${handledRate}%`} detail={`已处理 ${handledCount.toLocaleString()} 条反馈`} tone="emerald" />
      </section>

      <div className="admin-chart-grid">
        <TrendLineChart
          title="反馈趋势"
          hint="按近 30 天每日新增反馈量生成趋势线"
          accentClassName="admin-chart-blue"
          data={data.trend}
        />
        <AdminDataCard
          title="重点观察"
          description="结合分类、状态和高频词，快速定位当前最值得处理的产品信号。"
        >
          <div className="admin-insight-grid">
            <article className="admin-insight-card">
              <span>问题反馈</span>
              <strong>{data.overview.bugCount.toLocaleString()}</strong>
              <p>目前以“问题反馈”为主，适合优先排查稳定性与交互断点。</p>
            </article>
            <article className="admin-insight-card">
              <span>功能建议</span>
              <strong>{data.overview.suggestionCount.toLocaleString()}</strong>
              <p>可辅助判断近期需求方向与用户最希望补齐的能力。</p>
            </article>
            <article className="admin-insight-card">
              <span>单日峰值</span>
              <strong>{trendPeak.toLocaleString()}</strong>
              <p>近 30 天单日反馈峰值，用于观察版本发布后的波动情况。</p>
            </article>
          </div>
        </AdminDataCard>
      </div>

      <div className="admin-chart-grid">
        <AdminDataCard
          title="反馈分类分布"
          description="按反馈类型拆分，帮助判断当前更偏稳定性问题还是需求呼声。"
        >
          <div className="admin-feedback-stat-grid">
            {data.typeStats.map((stat) => (
              <article key={stat.key} className="admin-feedback-stat-card">
                <span>{stat.label}</span>
                <strong>{stat.count.toLocaleString()}</strong>
              </article>
            ))}
          </div>
        </AdminDataCard>
        <AdminDataCard
          title="处理状态分布"
          description="查看反馈从待处理到已解决的整体推进情况。"
        >
          <div className="admin-feedback-stat-grid">
            {data.statusStats.map((stat) => (
              <article key={stat.key} className="admin-feedback-stat-card">
                <span>{stat.label}</span>
                <strong>{stat.count.toLocaleString()}</strong>
              </article>
            ))}
          </div>
        </AdminDataCard>
      </div>

      {data.topUsers.length ? (
        <section className="admin-spotlight-grid">
          {data.topUsers.map((user, index) => (
            <article key={user.email} className="admin-spotlight-card">
              <span>反馈活跃用户 TOP {index + 1}</span>
              <strong>{user.name || user.email}</strong>
              <p>{user.email}</p>
              <p>累计提交 {user.count.toLocaleString()} 条，最近一次 {formatAdminDateTime(user.lastSubmittedAt)}。</p>
            </article>
          ))}
        </section>
      ) : null}

      <div className="admin-chart-grid">
        <AdminDataCard
          title="版本分布"
          description="观察反馈主要集中在哪些桌面端版本，便于回溯发版影响。"
        >
          <div className="admin-feedback-version-list">
            {data.versionStats.length ? data.versionStats.map((item) => (
              <div key={item.version} className="admin-feedback-version-row">
                <strong>{item.version}</strong>
                <span>{item.count.toLocaleString()} 条</span>
              </div>
            )) : <p className="muted">暂无版本统计</p>}
          </div>
        </AdminDataCard>
        <AdminDataCard
          title="热点关键词"
          description="从标题与内容里抽取高频词，辅助快速定位共性诉求。"
        >
          <div className="admin-feedback-keywords">
            {data.topKeywords.length ? data.topKeywords.map((item) => (
              <span key={item.keyword} className="admin-feedback-keyword-chip">
                {item.keyword} · {item.count}
              </span>
            )) : <p className="muted">暂无可用关键词</p>}
          </div>
        </AdminDataCard>
      </div>

      <AdminDataCard
        title="反馈明细"
        description="支持按状态与类型筛选，并可直接调整反馈处理状态。"
        action={(
          <div className="admin-feedback-filters">
            <label className="admin-filter">
              <span>状态</span>
              <select
                className="streamlined-case-select"
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value as 'all' | AdminFeedbackItem['status'])}
              >
                <option value="all">全部状态</option>
                <option value="pending">待处理</option>
                <option value="reviewing">处理中</option>
                <option value="resolved">已解决</option>
                <option value="ignored">暂不处理</option>
              </select>
            </label>
            <label className="admin-filter">
              <span>类型</span>
              <select
                className="streamlined-case-select"
                value={typeFilter}
                onChange={(event) => setTypeFilter(event.target.value as 'all' | AdminFeedbackItem['feedbackType'])}
              >
                <option value="all">全部类型</option>
                <option value="bug">问题反馈</option>
                <option value="suggestion">功能建议</option>
                <option value="experience">体验评价</option>
                <option value="other">其他</option>
              </select>
            </label>
          </div>
        )}
      >
        {filteredItems.length ? (
          <div className="admin-feedback-list">
            {filteredItems.map((item) => (
              <article key={item.id} className="admin-feedback-entry">
                <div className="admin-feedback-entry-head">
                  <div className="admin-feedback-entry-copy">
                    <div className="admin-feedback-badge-row">
                      <span className="admin-feedback-type-badge">{item.feedbackTypeLabel}</span>
                      <span className={`admin-feedback-status-badge ${getAdminFeedbackStatusTone(item.status)}`}>
                        {item.statusLabel}
                      </span>
                    </div>
                    <strong>{item.title}</strong>
                    <p>{item.content}</p>
                  </div>
                  <label className="admin-filter">
                    <span>处理状态</span>
                    <select
                      className="streamlined-case-select"
                      value={item.status}
                      onChange={(event) => void handleFeedbackStatusChange(item, event.target.value as AdminFeedbackItem['status'])}
                      disabled={updatingId === item.id}
                    >
                      <option value="pending">待处理</option>
                      <option value="reviewing">处理中</option>
                      <option value="resolved">已解决</option>
                      <option value="ignored">暂不处理</option>
                    </select>
                  </label>
                </div>
                <div className="admin-feedback-entry-meta">
                  <span><strong>反馈人：</strong>{item.userName || item.userEmail}</span>
                  <span><strong>账号：</strong>{item.userEmail}</span>
                  <span><strong>提交时间：</strong>{formatAdminDateTime(item.createdAt)}</span>
                  <span><strong>桌面端版本：</strong>{item.appVersion || '未知版本'}</span>
                  <span><strong>当前页面：</strong>{item.pageContext || '未记录'}</span>
                  <span><strong>当前案件：</strong>{item.caseName || '未记录'}</span>
                  <span><strong>联系方式：</strong>{item.contact || '未填写'}</span>
                  <span><strong>客户端：</strong>{item.clientPlatform || '未记录'}</span>
                  <span><strong>最后处理：</strong>{item.handledAt ? `${formatAdminDateTime(item.handledAt)} / ${item.handledByEmail || '-'}` : '尚未处理'}</span>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <p className="muted">当前筛选条件下暂无反馈记录</p>
        )}
      </AdminDataCard>
    </div>
  )
}

function ConsoleHome({ data }: { data: DashboardData }) {
  return (
    <div className="stack">
      <section className="card summary-grid">
        <div><span>当前套餐</span><strong>{data.account.tierName}</strong></div>
        <div><span>积分余额</span><strong>{data.account.pointsBalance.toLocaleString()}</strong></div>
        <div><span>最近订单</span><strong>{data.orders[0]?.orderNo || '-'}</strong></div>
        <div><span>发票状态</span><strong>{data.invoices[0] ? formatInvoiceStatus(data.invoices[0].status) : '暂无'}</strong></div>
      </section>
      <section className="card">
        <div className="section-head">
          <h3>最近订单</h3>
          <a href="/console/orders">查看全部</a>
        </div>
        <div className="table-like">
          {data.orders.length ? data.orders.slice(0, 3).map((order) => (
            <div key={order.id} className="table-row">
              <span>{order.orderNo}</span>
              <span>{order.packageName}</span>
              <span>{formatCurrency(order.amountFen)}</span>
              <span>{formatOrderStatus(order.status)}</span>
            </div>
          )) : (
            <div className="table-row">
              <span>暂无订单</span>
              <span>创建套餐或积分订单后会在这里展示</span>
              <span>-</span>
              <span>-</span>
            </div>
          )}
        </div>
      </section>
    </div>
  )
}

function PaymentQrPreview({ value }: { value: string }) {
  const [qrSrc, setQrSrc] = useState('')

  useEffect(() => {
    let cancelled = false

    async function generateQr() {
      if (!value.trim()) {
        setQrSrc('')
        return
      }

      try {
        const nextQrSrc = await QRCode.toDataURL(value, {
          width: 180,
          margin: 1,
        })
        if (!cancelled) {
          setQrSrc(nextQrSrc)
        }
      } catch {
        if (!cancelled) {
          setQrSrc('')
        }
      }
    }

    void generateQr()

    return () => {
      cancelled = true
    }
  }, [value])

  return qrSrc
    ? <img className="payment-qr-image" src={qrSrc} alt="支付二维码" />
    : <div className="payment-qr-placeholder">二维码生成中...</div>
}

function BillingPage({
  data,
  billingBusy,
  billingNotice,
  selectedChannel,
  onSelectChannel,
  onCreateOrder,
  onCompleteDevelopmentOrder,
}: {
  data: DashboardData
  billingBusy: boolean
  billingNotice: string
  selectedChannel: PaymentChannel
  onSelectChannel: (channel: PaymentChannel) => void
  onCreateOrder: (packageId: string) => Promise<void>
  onCompleteDevelopmentOrder: (orderId: string) => Promise<void>
}) {
  const requestedOrderNo = new URLSearchParams(window.location.search).get('orderNo')
  const pendingOrder = data.orders.find(order => order.status === 'pending' && order.orderNo === requestedOrderNo)
    ?? data.orders.find(order => order.status === 'pending')
  const isDevelopmentPendingOrder = Boolean(pendingOrder?.providerOrderId?.startsWith(`dev-${pendingOrder.channel}-`))
  const paymentLink = pendingOrder?.paymentUrl || pendingOrder?.qrCodeContent || ''
  const subscriptionPackages = data.packages.filter((item) => !isPointPackage(item))
  const pointPackages = data.packages.filter(isPointPackage)

  return (
    <div className="stack">
      <section className="card">
        <div className="section-head">
          <h3>充值与套餐购买</h3>
          <span className="muted">支付成功后，桌面端和账户中心会同步更新积分。</span>
        </div>

        <div className="provider-row">
          {data.providers.map((provider) => (
            <button
              key={provider.id}
              className={`channel-chip ${selectedChannel === provider.id ? 'active' : ''}`}
              type="button"
              disabled={!provider.enabled}
              onClick={() => onSelectChannel(provider.id)}
            >
              <strong>{provider.label}</strong>
              <span>{provider.enabled ? '已启用' : provider.reason || '未启用'}</span>
            </button>
          ))}
        </div>

        {billingNotice ? <div className="form-success">{billingNotice}</div> : null}

        <div className="billing-section-stack">
          <div>
            <div className="section-head">
              <div>
                <h4>月度套餐</h4>
                <span className="muted">免费版可先体验，每月付费套餐适合持续办案使用。</span>
              </div>
            </div>
            <div className="section-grid">
              <article className="card nested-card">
                <h4>免费版</h4>
                <strong className="price">免费</strong>
                <p>默认提供基础体验入口，适合先熟悉工作台。</p>
                <span className="muted">每月 100 积分</span>
              </article>
              {subscriptionPackages.map((item) => (
                <article key={item.id} className="card nested-card">
                  <h4>{item.name}</h4>
                  <strong className="price">{formatCurrency(item.amountFen)}</strong>
                  <p>{item.description}</p>
                  <span className="muted">到账积分 {item.points.toLocaleString()}</span>
                  <button
                    className="primary-button"
                    type="button"
                    disabled={billingBusy}
                    onClick={() => void onCreateOrder(item.id)}
                  >
                    {billingBusy ? '处理中...' : `使用${formatChannel(selectedChannel)}下单`}
                  </button>
                </article>
              ))}
            </div>
          </div>

          <div>
            <div className="section-head">
              <div>
                <h4>单独购买积分</h4>
                <span className="muted">按需补充，不改变当前套餐层级。</span>
              </div>
            </div>
            <div className="section-grid">
              {pointPackages.map((item) => (
                <article key={item.id} className="card nested-card">
                  <h4>{item.name}</h4>
                  <strong className="price">{formatCurrency(item.amountFen)}</strong>
                  <p>{item.description}</p>
                  <span className="muted">到账积分 {item.points.toLocaleString()}</span>
                  <button
                    className="primary-button"
                    type="button"
                    disabled={billingBusy}
                    onClick={() => void onCreateOrder(item.id)}
                  >
                    {billingBusy ? '处理中...' : `使用${formatChannel(selectedChannel)}下单`}
                  </button>
                </article>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="card">
        <div className="section-head">
          <h3>待支付订单</h3>
          <span className="muted">支持微信 / 支付宝扫码</span>
        </div>
        {pendingOrder ? (
          <div className="pending-order pending-order-stack payment-order-panel">
            <div className="payment-qr-panel">
              <PaymentQrPreview value={paymentLink} />
              <span className="muted">{isDevelopmentPendingOrder
                ? '模拟订单，请点击模拟完成支付'
                : `请使用${formatChannel(pendingOrder.channel)}扫码完成支付`}</span>
            </div>
            <div className="payment-order-details">
              <div>
                <strong>{pendingOrder.orderNo}</strong>
                <span className="muted">{pendingOrder.packageName} / {formatCurrency(pendingOrder.amountFen)}</span>
                <span className="muted">{formatChannel(pendingOrder.channel)} / {formatOrderStatus(pendingOrder.status)}</span>
                <span className="muted">支付成功后会自动刷新订单状态、积分余额与积分流水。</span>
              </div>
              <div className="pending-order-code">
                <strong>支付链接</strong>
                <a href={paymentLink} target="_blank" rel="noreferrer">
                  打开支付页面
                </a>
                <span className="muted payment-link-text">{paymentLink}</span>
              </div>
              {isDevelopmentPendingOrder ? (
                <button
                  className="primary-button"
                  type="button"
                  disabled={billingBusy}
                  onClick={() => void onCompleteDevelopmentOrder(pendingOrder.id)}
                >
                  {billingBusy ? '处理中...' : '开发环境模拟完成支付'}
                </button>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="pending-order">
            <div>
              <strong>当前没有待支付订单</strong>
              <span className="muted">创建订单后会在这里继续支付。</span>
            </div>
          </div>
        )}
      </section>
    </div>
  )
}

function OrdersPage({ orders }: { orders: BillingOrder[] }) {
  return (
    <section className="card">
      <div className="section-head">
        <h3>订单记录</h3>
        <span className="muted">下单、支付、开票申请全部统一管理</span>
      </div>
      <div className="table-like">
        {orders.length ? orders.map((order) => (
          <div key={order.id} className="table-row detailed">
            <strong>{order.orderNo}</strong>
            <span>{order.packageName}</span>
            <span>{formatCurrency(order.amountFen)}</span>
            <span>{formatChannel(order.channel)} / {formatOrderStatus(order.status)}</span>
            <span>{formatDateTime(order.paidAt || order.createdAt)}</span>
          </div>
        )) : (
          <div className="table-row detailed">
            <strong>暂无订单</strong>
            <span>-</span>
            <span>-</span>
            <span>-</span>
            <span>-</span>
          </div>
        )}
      </div>
    </section>
  )
}

function UsagePage({ data }: { data: DashboardData }) {
  return (
    <div className="stack">
      <section className="card summary-grid">
        {data.usage.map((item) => (
          <div key={item.label}>
            <span>{item.label}</span>
            <strong>{item.value}</strong>
          </div>
        ))}
      </section>
      <section className="card">
        <div className="section-head">
          <h3>账户状态</h3>
          <span className="muted">当前页面展示的积分余额来自云端账户数据库。</span>
        </div>
        <div className="table-like">
          <div className="table-row"><span>账户等级</span><span>{data.account.tierName}</span><span>到期时间</span><span>{formatDateTime(data.account.subscriptionExpiresAt)}</span></div>
          <div className="table-row"><span>积分余额</span><span>{data.account.pointsBalance.toLocaleString()}</span><span>数据来源</span><span>{data.apiOnline ? 'cloud-server' : '本地回退'}</span></div>
        </div>
      </section>
      <section className="card">
        <div className="section-head">
          <h3>积分扣费规则</h3>
          <span className="muted">商用计费按成功结果入账，失败任务应补回积分。</span>
        </div>
        <div className="table-like">
          {data.pointPolicies.map((item) => (
            <div key={item.actionType} className="table-row detailed">
              <strong>{item.label}</strong>
              <span>{item.description}</span>
              <span>{item.pointsPerUnit} 积分 / {item.unitLabel}</span>
              <span>{item.actionType}</span>
            </div>
          ))}
        </div>
      </section>
      <section className="card">
        <div className="section-head">
          <h3>最近积分流水</h3>
          <span className="muted">充值、消费、退款统一沉淀在云端账本中。</span>
        </div>
        <div className="table-like">
          {data.pointLedger.length ? data.pointLedger.slice(0, 12).map((item) => (
            <div key={item.id} className="table-row detailed">
              <strong>{item.description}</strong>
              <span>{formatPointEntryType(item.entryType)}</span>
              <span>{formatPointDelta(item.delta)} 积分</span>
              <span>余额 {item.balanceAfter.toLocaleString()}</span>
              <span>{formatDateTime(item.createdAt)}</span>
            </div>
          )) : (
            <div className="table-row detailed">
              <strong>暂无积分流水</strong>
              <span>-</span>
              <span>-</span>
              <span>-</span>
              <span>-</span>
            </div>
          )}
        </div>
      </section>
    </div>
  )
}

function InvoicesPage({
  invoices,
  invoiceBusy,
  invoiceNotice,
  invoiceForm,
  invoiceFormOpen,
  onInvoiceFormChange,
  onToggleInvoiceForm,
  onCreateInvoiceRequest,
}: {
  invoices: InvoiceRequest[]
  invoiceBusy: boolean
  invoiceNotice: string
  invoiceForm: InvoiceFormValue
  invoiceFormOpen: boolean
  onInvoiceFormChange: (field: keyof InvoiceFormValue, value: string) => void
  onToggleInvoiceForm: () => void
  onCreateInvoiceRequest: (payload: InvoiceFormValue) => Promise<void>
}) {
  return (
    <div className="stack">
      <section className="card">
        <div className="section-head">
          <h3>发票管理</h3>
          <button className="primary-button" type="button" disabled={invoiceBusy} onClick={onToggleInvoiceForm}>
            {invoiceFormOpen ? '收起表单' : '申请开票'}
          </button>
        </div>
        {invoiceNotice ? <div className="form-success">{invoiceNotice}</div> : null}
        {invoiceFormOpen ? (
          <form
            className="invoice-form-grid"
            onSubmit={(event) => {
              event.preventDefault()
              void onCreateInvoiceRequest(invoiceForm)
            }}
          >
            <label>
              开票企业名称
              <input
                value={invoiceForm.title}
                onChange={(event) => onInvoiceFormChange('title', event.target.value)}
                placeholder="请输入开票企业全称"
                required
              />
            </label>
            <label>
              纳税人识别号
              <input
                value={invoiceForm.taxNo}
                onChange={(event) => onInvoiceFormChange('taxNo', event.target.value)}
                placeholder="请输入统一社会信用代码/税号"
                required
              />
            </label>
            <label>
              企业注册地址
              <input
                value={invoiceForm.registeredAddress}
                onChange={(event) => onInvoiceFormChange('registeredAddress', event.target.value)}
                placeholder="请输入企业注册地址"
                required
              />
            </label>
            <label>
              企业注册电话
              <input
                value={invoiceForm.registeredPhone}
                onChange={(event) => onInvoiceFormChange('registeredPhone', event.target.value)}
                placeholder="请输入企业注册电话"
                required
              />
            </label>
            <label>
              开户银行
              <input
                value={invoiceForm.bankName}
                onChange={(event) => onInvoiceFormChange('bankName', event.target.value)}
                placeholder="请输入开户银行"
                required
              />
            </label>
            <label>
              银行账号
              <input
                value={invoiceForm.bankAccount}
                onChange={(event) => onInvoiceFormChange('bankAccount', event.target.value)}
                placeholder="请输入企业银行账号"
                required
              />
            </label>
            <label>
              收票邮箱
              <input
                value={invoiceForm.recipientEmail}
                onChange={(event) => onInvoiceFormChange('recipientEmail', event.target.value)}
                placeholder="选填，用于接收电子发票"
                type="email"
              />
            </label>
            <div className="invoice-form-actions">
              <button className="primary-button" type="submit" disabled={invoiceBusy}>
                {invoiceBusy ? '提交中...' : '提交开票申请'}
              </button>
            </div>
          </form>
        ) : null}
        <div className="table-like">
          {invoices.length ? invoices.map((invoice) => (
            <div key={invoice.id} className="table-row detailed">
              <strong>{invoice.title}</strong>
              <span>{invoice.taxNo}</span>
              <span>{invoice.orderId}</span>
              <span>{invoice.amountLabel}</span>
              <span>{formatInvoiceStatus(invoice.status)}</span>
            </div>
          )) : (
            <div className="table-row detailed">
              <strong>暂无发票申请</strong>
              <span>-</span>
              <span>-</span>
              <span>-</span>
            </div>
          )}
        </div>
      </section>
    </div>
  )
}

function ProfilePage({ account, profile }: { account: AccountSummary; profile: SessionProfile | null }) {
  return (
    <>
    <section className="card form-grid">
      <h3>账户资料</h3>
      <label>
        姓名
        <input value={account.displayName} readOnly />
      </label>
      <label>
        邮箱
        <input value={account.email} readOnly />
      </label>
      <label>
        所属组织
        <input value={profile?.organization.name || '-'} readOnly />
      </label>
      <label>
        当前角色
        <input value={profile?.organization.role || '-'} readOnly />
      </label>
    </section>
    <AccountFeatures />
    </>
  )
}

function ConsoleAuthRequired() {
  return (
    <section className="auth-shell">
      <div className="card auth-card">
        <span className="eyebrow">账户中心</span>
        <h2>请先登录</h2>
        <p className="muted">订单、积分、发票和下载权益都需要登录后查看。</p>
        <div className="hero-actions">
          <a className="primary-button" href="/login">去登录</a>
          <a className="ghost-button" href="/register">注册新账户</a>
        </div>
      </div>
    </section>
  )
}

function Content({
  route,
  data,
  profile,
  authToken,
  authBusy,
  authError,
  billingBusy,
  billingNotice,
  invoiceBusy,
  invoiceNotice,
  invoiceForm,
  invoiceFormOpen,
  selectedChannel,
  onSelectChannel,
  onCreateOrder,
  onCompleteDevelopmentOrder,
  onInvoiceFormChange,
  onToggleInvoiceForm,
  onCreateInvoiceRequest,
  onLogin,
  onRegister,
}: {
  route: SiteRoute
  data: DashboardData
  profile: SessionProfile | null
  authToken: string
  authBusy: boolean
  authError: string
  billingBusy: boolean
  billingNotice: string
  invoiceBusy: boolean
  invoiceNotice: string
  invoiceForm: InvoiceFormValue
  invoiceFormOpen: boolean
  selectedChannel: PaymentChannel
  onSelectChannel: (channel: PaymentChannel) => void
  onCreateOrder: (packageId: string) => Promise<void>
  onCompleteDevelopmentOrder: (orderId: string) => Promise<void>
  onInvoiceFormChange: (field: keyof InvoiceFormValue, value: string) => void
  onToggleInvoiceForm: () => void
  onCreateInvoiceRequest: (payload: InvoiceFormValue) => Promise<void>
  onLogin: (formData: FormData) => Promise<void>
  onRegister: (formData: FormData) => Promise<void>
}) {
  if (route === '/login') {
    return <AuthPage mode="login" busy={authBusy} errorMessage={authError} onSubmit={onLogin} />
  }

  if (route === '/register') {
    return <AuthPage mode="register" busy={authBusy} errorMessage={authError} onSubmit={onRegister} />
  }

  if (route.startsWith('/admin')) {
    if (!authToken) {
      return <ConsoleAuthRequired />
    }

    return (
      <AdminLayout
        route={route}
        data={data}
      />
    )
  }

  if (route.startsWith('/console')) {
    if (!authToken) {
      return <ConsoleAuthRequired />
    }

    return (
      <ConsoleLayout
        route={route}
        data={data}
        profile={profile}
        billingNotice={billingNotice}
        billingBusy={billingBusy}
        invoiceNotice={invoiceNotice}
        invoiceBusy={invoiceBusy}
        invoiceForm={invoiceForm}
        invoiceFormOpen={invoiceFormOpen}
        selectedChannel={selectedChannel}
        onSelectChannel={onSelectChannel}
        onCreateOrder={onCreateOrder}
        onCompleteDevelopmentOrder={onCompleteDevelopmentOrder}
        onInvoiceFormChange={onInvoiceFormChange}
        onToggleInvoiceForm={onToggleInvoiceForm}
        onCreateInvoiceRequest={onCreateInvoiceRequest}
      />
    )
  }

  if (route === '/pricing') {
    return <PricingPage plans={data.plans} packages={data.packages} />
  }

  if (route === '/download') {
    return <DownloadPage releases={data.releases} />
  }

  if (route === '/product') {
    return <ProductPage />
  }

  if (route === '/docs') {
    return <DocsPage />
  }

  return <HomePage plans={data.plans} packages={data.packages} />
}

export default function App() {
  const route = normalizeRoute(window.location.pathname)
  const [data, setData] = useState<DashboardData>(fallbackData)
  const [profile, setProfile] = useState<SessionProfile | null>(null)
  const [authToken, setAuthToken] = useState(() => consumeDesktopTokenFromUrl() || authStorage.getToken())
  useEffect(() => {
    if (authToken) void api.getAnalyticsPreference().then(() => api.trackProductEvent('app.open')).catch(() => {})
  }, [authToken])
  const [authBusy, setAuthBusy] = useState(false)
  const [authError, setAuthError] = useState('')
  const [isInitializing, setIsInitializing] = useState(!!(consumeDesktopTokenFromUrl() || authStorage.getToken()))
  const [billingBusy, setBillingBusy] = useState(false)
  const [billingNotice, setBillingNotice] = useState('')
  const [invoiceBusy, setInvoiceBusy] = useState(false)
  const [invoiceNotice, setInvoiceNotice] = useState('')
  const [invoiceForm, setInvoiceForm] = useState<InvoiceFormValue>(emptyInvoiceForm)
  const [invoiceFormOpen, setInvoiceFormOpen] = useState(false)
  const [selectedChannel, setSelectedChannel] = useState<PaymentChannel>('alipay')

  const enabledProviders = useMemo(
    () => data.providers.filter((item) => item.enabled),
    [data.providers],
  )

  useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        const [plans, catalog, releases] = await Promise.all([
          api.getPlans(),
          api.getBillingCatalog(),
          api.getReleases(),
        ])

        if (cancelled) {
          return
        }

        setData((current) => ({
          ...current,
          plans: plans.items,
          packages: catalog.packages,
          providers: catalog.providers,
          releases: releases.items,
          apiOnline: true,
        }))

        const preferredProvider = catalog.providers.find((item) => item.enabled)?.id
        if (preferredProvider) {
          setSelectedChannel(preferredProvider)
        }
      } catch (error) {
        console.error('Failed to load public cloud data.', error)
      }
    }

    void load()

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!authToken) {
      setProfile(null)
      setBillingNotice('')
      setInvoiceNotice('')
      return
    }

    let cancelled = false

    async function loadConsole() {
      try {
        const [sessionProfile, account, usage, pointPolicies, pointLedger, orders, invoices] = await Promise.all([
          api.getProfile(),
          api.getAccountSummary(),
          api.getUsageSummary(),
          api.getPointPolicies(),
          api.getPointLedger(),
          api.getBillingOrders(),
          api.getInvoiceRequests(),
        ])

        if (cancelled) {
          return
        }

        setProfile(sessionProfile)
        setData((current) => ({
          ...current,
          account,
          usage: usage.items,
          pointPolicies: pointPolicies.items,
          pointLedger: pointLedger.items,
          orders: orders.items,
          invoices: invoices.items,
          apiOnline: true,
        }))
        setIsInitializing(false)
      } catch (error) {
        console.error('Failed to load console data.', error)
        if (cancelled) {
          return
        }

        if (isAuthApiError(error)) {
          authStorage.clear()
          setAuthToken('')
          setProfile(null)
          setAuthError(error.message || '登录态已失效，请重新登录。')
          setIsInitializing(false)
          return
        }

        setAuthError(error instanceof Error ? error.message : '账户中心暂时不可用，请稍后重试。')
        setIsInitializing(false)
      }
    }

    void loadConsole()

    return () => {
      cancelled = true
    }
  }, [authToken])

  useEffect(() => {
    if (!authToken) return
    let cancelled = false
    let refreshing = false
    const refresh = async () => {
      if (cancelled || refreshing || document.visibilityState !== 'visible') return
      refreshing = true
      try {
        const [account, pointLedger] = await Promise.all([
          api.getAccountSummary(), api.getPointLedger(),
        ])
        if (!cancelled) {
          setData(current => ({
            ...current, account, pointLedger: pointLedger.items,
          }))
        }
      } catch (error) {
        console.error('Failed to refresh account balance.', error)
      } finally {
        refreshing = false
      }
    }
    const onFocus = () => { void refresh() }
    const timer = window.setInterval(onFocus, 15000)
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
    }
  }, [authToken])

  useEffect(() => {
    if (!authToken) {
      return
    }

    const pendingOrder = data.orders.find((order) => order.status === 'pending')
    if (!pendingOrder) {
      return
    }
    const pendingOrderId = pendingOrder.id

    let cancelled = false

    async function refreshPendingOrder() {
      try {
        const result = await api.getBillingOrder(pendingOrderId)
        if (cancelled) {
          return
        }

        setData((current) => ({
          ...current,
          orders: current.orders.map((item) => (item.id === result.order.id ? result.order : item)),
        }))

        if (result.order.status !== 'pending') {
          if (cancelled) {
            return
          }

          await refreshBillingAndPointSnapshot()

          setBillingNotice(
            result.order.status === 'paid'
              ? '支付已完成，积分余额与积分流水已自动更新。'
              : `订单状态已更新为${formatOrderStatus(result.order.status)}。`,
          )
        }
      } catch (error) {
        console.error('Failed to refresh pending payment order.', error)
      }
    }

    const timer = window.setInterval(() => {
      void refreshPendingOrder()
    }, 5000)

    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [authToken, data.orders])

  async function handleLogin(formData: FormData) {
    setAuthBusy(true)
    setAuthError('')

    try {
      const email = String(formData.get('email') ?? '')
      const result = await api.login({
        email,
        password: String(formData.get('password') ?? ''),
      })
      authStorage.setToken(result.token)
      setAuthToken(result.token)
      
      const adminEmails = ['admin', '972167580@qq.com']
      if (adminEmails.includes(email.toLowerCase())) {
        window.location.assign('/admin')
      } else {
        window.location.assign('/console')
      }
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : '登录失败。')
    } finally {
      setAuthBusy(false)
    }
  }

  async function handleRegister(formData: FormData) {
    setAuthBusy(true)
    setAuthError('')

    try {
      const result = await api.register({
        organizationName: String(formData.get('organizationName') ?? ''),
        ownerName: String(formData.get('ownerName') ?? ''),
        email: String(formData.get('email') ?? ''),
        password: String(formData.get('password') ?? ''),
        inviteCode: String(formData.get('inviteCode') ?? '').trim() || undefined,
      })
      authStorage.setToken(result.token)
      setAuthToken(result.token)
      window.location.assign('/console')
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : '注册失败。')
    } finally {
      setAuthBusy(false)
    }
  }

  async function handleLogout() {
    try {
      if (authToken) {
        await api.logout()
      }
    } catch {
      // 退出时即使请求失败，也要清掉本地登录态。
    }

    authStorage.clear()
    setAuthToken('')
    setProfile(null)
    window.location.assign('/')
  }

  async function refreshBillingAndPointSnapshot() {
    const [orders, account, usage, pointLedger] = await Promise.all([
      api.getBillingOrders(),
      api.getAccountSummary(),
      api.getUsageSummary(),
      api.getPointLedger(),
    ])

    setData((current) => ({
      ...current,
      orders: orders.items,
      account,
      usage: usage.items,
      pointLedger: pointLedger.items,
    }))
  }

  async function handleCreateOrder(packageId: string) {
    setBillingBusy(true)
    setBillingNotice('')

    try {
      const result = await api.createBillingOrder({
        packageId,
        channel: selectedChannel,
      })
      const refreshed = await Promise.all([
        api.getBillingOrders(),
        api.getAccountSummary(),
      ])

      setData((current) => ({
        ...current,
        providers: result.providers,
        packages: result.packages,
        orders: refreshed[0].items,
        account: refreshed[1],
      }))
      setBillingNotice(`订单 ${result.order.orderNo} 已创建，请使用${formatChannel(result.order.channel)}完成支付。`)
    } catch (error) {
      setBillingNotice(error instanceof Error ? error.message : '创建订单失败。')
    } finally {
      setBillingBusy(false)
    }
  }

  async function handleCompleteDevelopmentOrder(orderId: string) {
    setBillingBusy(true)
    setBillingNotice('')

    try {
      await api.completeBillingOrderForDevelopment(orderId)
      await refreshBillingAndPointSnapshot()
      setBillingNotice('开发环境模拟支付已完成，积分余额与积分流水已同步更新。')
    } catch (error) {
      setBillingNotice(error instanceof Error ? error.message : '模拟完成支付失败。')
    } finally {
      setBillingBusy(false)
    }
  }

  function handleInvoiceFormChange(field: keyof InvoiceFormValue, value: string) {
    setInvoiceForm((current) => ({
      ...current,
      [field]: value,
    }))
  }

  function handleToggleInvoiceForm() {
    setInvoiceFormOpen((current) => !current)
    setInvoiceNotice('')
  }

  async function handleCreateInvoiceRequest(payload: InvoiceFormValue) {
    setInvoiceBusy(true)
    setInvoiceNotice('')

    try {
      await api.createInvoiceRequest(payload)
      const refreshed = await api.getInvoiceRequests()
      setData((current) => ({
        ...current,
        invoices: refreshed.items,
      }))
      setInvoiceForm(emptyInvoiceForm)
      setInvoiceFormOpen(false)
      setInvoiceNotice('开票申请已提交，已进入审核队列。')
    } catch (error) {
      setInvoiceNotice(error instanceof Error ? error.message : '提交开票申请失败。')
    } finally {
      setInvoiceBusy(false)
    }
  }

  if (isInitializing) {
    return (
      <div className="page-shell">
        <header className="topbar">
          <a className="brand" href="/">LawVerify</a>
        </header>
        <main className="content-shell" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh', color: '#666' }}>
          正在加载账户信息...
        </main>
      </div>
    )
  }

  return (
    <div className={`page-shell ${route.startsWith('/admin') || route.startsWith('/console') ? 'workspace-site' : 'public-site'}`}>
      <a className="skip-link" href="#main-content">跳到主要内容</a>
      <header className="topbar">
        <a className="brand" href="/">LawVerify</a>
        <nav className="nav-row" aria-label="官网导航">
          {siteNav.map((item) => (
            <SiteLink key={item.href} item={item} current={route} />
          ))}
        </nav>
        <div className="nav-actions">
          {authToken ? (
            <>
              <a className="ghost-button" href="/console">账户中心</a>
              <button className="primary-button" type="button" onClick={() => void handleLogout()}>退出登录</button>
            </>
          ) : (
            <>
              <a className="ghost-button" href="/login">登录</a>
              <a className="primary-button" href="/register">注册</a>
            </>
          )}
        </div>
      </header>
      <main id="main-content" className={`content-shell${route.startsWith('/admin') ? ' admin-content-shell' : ''}`}>
        <Content
          route={route}
          data={data}
          profile={profile}
          authToken={authToken}
          authBusy={authBusy}
          authError={authError}
          billingBusy={billingBusy}
          billingNotice={billingNotice}
          invoiceBusy={invoiceBusy}
          invoiceNotice={invoiceNotice}
          invoiceForm={invoiceForm}
          invoiceFormOpen={invoiceFormOpen}
          selectedChannel={enabledProviders.some((item) => item.id === selectedChannel) ? selectedChannel : enabledProviders[0]?.id ?? 'alipay'}
          onSelectChannel={setSelectedChannel}
          onCreateOrder={handleCreateOrder}
          onCompleteDevelopmentOrder={handleCompleteDevelopmentOrder}
          onInvoiceFormChange={handleInvoiceFormChange}
          onToggleInvoiceForm={handleToggleInvoiceForm}
          onCreateInvoiceRequest={handleCreateInvoiceRequest}
          onLogin={handleLogin}
          onRegister={handleRegister}
        />
      </main>
      {!route.startsWith('/admin') && !route.startsWith('/console') && (
        <footer className="site-footer"><span>LawVerify</span><span>专注办案，有据可依。</span></footer>
      )}
    </div>
  )
}
