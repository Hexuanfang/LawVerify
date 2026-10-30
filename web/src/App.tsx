import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import QRCode from 'qrcode'

import { api, authStorage, consumeDesktopTokenFromUrl, isAuthApiError } from './api'
import {
  applyPageMeta,
  captureApplyIntent,
  captureSiteSource,
  clearApplyIntent,
  clearSiteSource,
  describeSiteSource,
  detectDefaultTarget,
  detectMacArch,
  loadAnalytics,
  readApplyIntent,
  readSiteSource,
  setPageJsonLd,
  siteConfig,
  track,
  type ApplyIntent,
  type DownloadTarget,
} from './site'
import {
  CopyDownloadLinkButton,
  DownloadEntryButton,
  HeroBackdrop,
  HeroProductPreview,
  AudienceSection,
  CapabilityStory,
  CompareToggle,
  ImportPreview,
  SectionTitle,
  StatusBadge,
  DraftEditor,
  LegalCheckShowcase,
  MaterialsPanel,
  ProductNav,
  StrategyMap,
  VerifyDemo,
  WorkflowExplorer,
  useIsMobileDevice,
  verifyStatusMeta,
  type VerifyStatus,
} from './site-demos'

type SiteRoute =
  | '/'
  | '/product'
  | '/pricing'
  | '/download'
  | '/docs'
  | '/faq'
  | '/verification'
  | '/ai-notice'
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
  { label: '产品', href: '/product' },
  { label: '价格', href: '/pricing' },
  { label: '下载', href: '/download' },
  { label: '帮助', href: '/docs' },
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
      description: '注册即送，先用自己的真实案件试。',
      highlights: ['注册即送体验积分'],
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
    '/faq',
    '/verification',
    '/ai-notice',
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

function RegisterButton({ label = '免费注册', source, className = 'primary-button' }: { label?: string; source: string; className?: string }) {
  return (
    <a className={className} href="/register" onClick={() => track('hero_cta_click', `register:${source}`)}>
      {label}
    </a>
  )
}

function MobileRegisterHint() {
  const mobile = useIsMobileDevice()
  if (!mobile) return null
  return <p className="mobile-register-hint">注册后在电脑上下载客户端，用同一账号登录即可。</p>
}

function getPublicPlans(plans: SitePlan[]) {
  // 律所团队单独做咨询卡片，套餐列表只保留免费 / 个人版 / 专业版。
  return plans.filter((plan) => plan.billingCycle !== 'custom' && plan.id !== 'team-custom')
}

function getPlanDescription(plan: SitePlan) {
  if (plan.id.startsWith('free') || plan.priceLabel === '免费') {
    return '注册即送，先用自己的真实案件试。'
  }
  if (plan.id.startsWith('personal')) {
    return '适合个人律师持续办案。'
  }
  if (plan.id.startsWith('pro')) {
    return '适合高频办案、文书反复核验。'
  }
  return plan.description
}

function getPlanPointsLabel(plan: SitePlan) {
  if (plan.points <= 0) return ''
  return plan.billingCycle === 'monthly'
    ? `每月 ${plan.points.toLocaleString()} 积分`
    : `${plan.points.toLocaleString()} 积分`
}

function PricingList({ plans, packages }: { plans: SitePlan[]; packages: BillingPackage[] }) {
  const publicPlans = getPublicPlans(plans)
  const pointPackages = packages.filter(isPointPackage)
  return (
    <div className="plist">
      <div className="plist-rows">
        {publicPlans.map((plan) => {
          const isFree = plan.id.startsWith('free') || plan.priceLabel === '免费'
          return (
            <a
              key={plan.id}
              className={`plist-row${plan.recommended ? ' is-rec' : ''}`}
              href={isFree ? '/register' : '/console/billing'}
              onClick={() => track('hero_cta_click', `pricing_row:${plan.id}`)}
            >
              <span className="plist-name">
                <b>{plan.name}</b>
                {plan.recommended ? <em>推荐</em> : null}
              </span>
              <span className="plist-desc">
                {getPlanDescription(plan)}
                {getPlanPointsLabel(plan) ? <small>{getPlanPointsLabel(plan)}</small> : null}
              </span>
              <span className="plist-price">{plan.priceLabel}</span>
              <span className="plist-go" aria-hidden="true">→</span>
            </a>
          )
        })}
        <a className="plist-row plist-team" href="/console?apply=team#cocreate">
          <span className="plist-name"><b>律所团队</b></span>
          <span className="plist-desc">团队需求按需沟通<small>注册后在账户中心提交咨询</small></span>
          <span className="plist-price">按需沟通</span>
          <span className="plist-go" aria-hidden="true">→</span>
        </a>
        <p className="plist-points">
          不想升级套餐，也可以单独补充积分
          {pointPackages.length ? `：${pointPackages.map((item) => `${item.points.toLocaleString()} 积分 ${formatCurrency(item.amountFen)}`).join(' · ')}` : ''}。
          <a href="/pricing">查看完整价格 →</a>
        </p>
      </div>
      <figure className="plist-photo">
        <img src="/media/files-box.jpg" alt="律师从文件箱中取出案卷材料" loading="lazy" />
        <figcaption><b>注册即送体验积分</b>先用自己的真实案件试</figcaption>
      </figure>
    </div>
  )
}

function HomePage({ plans, packages }: { plans: SitePlan[]; packages: BillingPackage[] }) {
  return (
    <div className="public-page-stack site-v2 home-v4">
      <section className="home-hero" aria-labelledby="home-hero-title">
        <HeroBackdrop />
        <div className="home-hero-inner">
          <div className="home-hero-copy">
            <span className="home-hero-kicker">LawVerify · 律师的 AI 核验台</span>
            <h1 id="home-hero-title">
              <span>每一句话，</span>
              <span><mark>都经得起质证。</mark></span>
            </h1>
            <p className="home-hero-lead">支持超大文件材料处理，从语义上把每一句陈述对回证据原件，并核验文书中引用的法条与案例。</p>
            <div className="hero-actions">
              <RegisterButton label="免费注册，领体验积分" source="hero" />
              <DownloadEntryButton source="hero" />
            </div>
            <p className="home-hero-meta"><span>支持 Windows、Mac（Apple 芯片 / Intel）</span><span>注册送体验积分</span></p>
            <MobileRegisterHint />
            <ul className="home-hero-feats" aria-label="产品特点">
              <li><b>超大文件材料处理</b><span>单份最大 100MB</span></li>
              <li><b>语义级证据核验</b><span>每句陈述对回原件</span></li>
              <li><b>案例法条核验</b><span>核对官方来源</span></li>
            </ul>
          </div>
          <HeroProductPreview />
        </div>
      </section>

      <CapabilityStory />

      <section className="site-block" aria-labelledby="workflow-title">
        <SectionTitle kicker="典型工作流" title="从材料到文书，顺着思路走。">
          链接材料、理解原件、确认代理立场、撰写文书、逐句核验，再导出 Word。点任意一步看看它在做什么。
        </SectionTitle>
        <WorkflowExplorer />
      </section>

      <section className="site-block" aria-labelledby="audience-title">
        <SectionTitle kicker="适用人群" title="独立执业、律所团队、企业法务，都用得上。">
          按自己的办案方式选：一个人用个人套餐；团队需求，注册后联系我们沟通。
        </SectionTitle>
        <AudienceSection />
      </section>

      <section className="site-block" aria-labelledby="compare-title">
        <SectionTitle kicker="和通用 AI 的区别" title="不只是写出来，还要核得住。">
          同一段质证意见：通用 AI 写完就交给你；LawVerify 先确认代理立场，再把每句陈述对回证据原件、核对引用的法条。切换看看差别。
        </SectionTitle>
        <CompareToggle />
      </section>

      <section className="site-block" aria-labelledby="pricing-summary-title">
        <SectionTitle kicker="订阅套餐" title="先从免费版体验，再按办案强度升级。">
          注册即送体验积分；不想升级套餐时，也可以单独补充积分。按实际使用扣积分，每笔扣费明细都能在账户中心查看。
        </SectionTitle>
        <PricingList plans={plans} packages={packages} />
      </section>

      <section className="cocreate" id="cocreate-section" aria-labelledby="cocreate-title">
        <div className="cc-main">
          <span className="section-kicker">共建计划</span>
          <h2 id="cocreate-title">招募 <mark>30</mark> 位共建律师</h2>
          <a className="primary-button" href="/register?apply=cocreate" onClick={() => track('hero_cta_click', 'register:cocreate')}>
            注册并申请
          </a>
        </div>
        <ul className="cc-points">
          <li><b>民商事诉讼律师优先</b><span>名额共 30 位</span></li>
          <li><b>共建期间赠送专业版额度</b><span>具体额度与期限，在确认参与时说明</span></li>
          <li><b>反馈直接进入产品迭代</b><span>你提的问题和需求会被持续跟进</span></li>
        </ul>
      </section>

    </div>
  )
}

function StatusLegend() {
  const statuses: VerifyStatus[] = ['support', 'partial', 'insufficient', 'conflict']
  return (
    <ul className="status-legend" aria-label="核验状态说明">
      {statuses.map((status) => (
        <li key={status}>
          <StatusBadge status={status} />
          <span>{verifyStatusMeta[status].description}</span>
        </li>
      ))}
    </ul>
  )
}

function PricingPage({ plans, packages }: { plans: SitePlan[]; packages: BillingPackage[] }) {
  useEffect(() => {
    track('pricing_view')
  }, [])

  const pricingFaqs = [
    {
      question: '积分怎么扣？',
      answer: '积分是 LawVerify 的统一使用额度，按实际使用的功能扣减。每一笔扣费明细，都可以在账户中心的「使用情况」页查看。',
    },
    {
      question: '免费版和月度套餐有什么区别？',
      answer: '免费版注册即送体验积分，适合先用自己的真实案件试；月度套餐每月发放更多积分，适合持续办案。',
    },
    {
      question: '积分包什么时候用？',
      answer: '不想升级套餐、只是某段时间用得多时，可以单独补充积分，不改变当前套餐。',
    },
    {
      question: '能开发票吗？',
      answer: '可以。在账户中心「发票管理」提交开票信息即可申请。',
    },
  ]

  return (
    <div className="public-page-stack site-v2">
      <header className="page-intro page-hero" style={{ ['--page-bg' as string]: 'url(/media/files-box.jpg)' }}>
        <span className="section-kicker">价格</span>
        <h1>先免费试，再按办案强度选。</h1>
        <p>注册即送体验积分，先用自己的真实案件试。按实际使用扣积分，每笔扣费明细都能在账户中心查看。</p>
      </header>

      <section className="site-block" aria-label="套餐">
        <PricingList plans={plans} packages={packages} />
      </section>

      <section className="site-block" aria-labelledby="pricing-faq-title">
        <SectionTitle kicker="常见问题" title="关于价格" />
        <dl className="faq-list">
          {pricingFaqs.map((item) => (
            <div key={item.question} className="faq-item">
              <dt>{item.question}</dt>
              <dd>{item.answer}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  )
}

const firstSteps = [
  { title: '用官网账号登录', detail: '打开客户端，用在官网注册的账号登录。' },
  { title: '新建案件，关联证据文件夹', detail: '选择电脑上存放这个案件证据的文件夹，材料会增量同步。' },
  { title: '起草或导入文书，点任意一句开始核验', detail: '起草质证意见，或导入已写好的 Word，点任意一句查看对应原件。' },
]

function DownloadIcon({ kind }: { kind: 'desktop' | 'laptop' }) {
  // 通用电脑图标（不使用任何厂商标志）
  return kind === 'desktop' ? (
    <svg className="dl-icon" viewBox="0 0 48 48" aria-hidden="true">
      <rect x="5" y="8" width="38" height="25" rx="3" fill="none" stroke="currentColor" strokeWidth="2.4" />
      <path d="M19 40h10M24 33v7" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  ) : (
    <svg className="dl-icon" viewBox="0 0 48 48" aria-hidden="true">
      <rect x="10" y="10" width="28" height="20" rx="2.5" fill="none" stroke="currentColor" strokeWidth="2.4" />
      <path d="M4 36h40l-3 3H7z" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinejoin="round" />
    </svg>
  )
}

const downloadColumns: Array<{ value: DownloadTarget; name: string; sub: string; full: string; icon: 'desktop' | 'laptop'; how: string }> = [
  { value: 'win32-x64', name: 'Windows', sub: 'Windows 电脑', full: 'Windows 版', icon: 'desktop', how: '下载后双击安装包，按提示完成安装。' },
  { value: 'darwin-arm64', name: 'Mac', sub: 'Apple 芯片（M 系列）', full: 'Mac Apple 芯片版', icon: 'laptop', how: '打开 DMG，把 LawVerify 拖进“应用程序”。' },
  { value: 'darwin-x64', name: 'Mac', sub: 'Intel 芯片', full: 'Mac Intel 版', icon: 'laptop', how: '打开 DMG，把 LawVerify 拖进“应用程序”。' },
]

function DownloadPage({ releases, releasesStatus }: { releases: ReleaseItem[]; releasesStatus: 'loading' | 'ready' | 'error' }) {
  const mobile = useIsMobileDevice()
  const [showAll, setShowAll] = useState(false)
  const [recommended, setRecommended] = useState<DownloadTarget>(() => detectDefaultTarget())

  // Mac 访客：尽量识别出 Intel 芯片；识别不了就保持 Apple 芯片。只用于“推荐”，三个版本始终都能直接下载。
  useEffect(() => {
    let cancelled = false
    void detectMacArch().then((arch) => {
      if (!cancelled && arch) setRecommended(arch === 'x64' ? 'darwin-x64' : 'darwin-arm64')
    })
    return () => {
      cancelled = true
    }
  }, [])

  const releasesFor = (target: DownloadTarget) => releases.filter((release) => `${release.platform ?? 'win32'}-${release.arch ?? 'x64'}` === target)
  const latestOf = (target: DownloadTarget) => releasesFor(target)[0]
  const historical = downloadColumns.flatMap((column) => releasesFor(column.value).slice(1).map((release) => ({ column, release })))
  const checksums = downloadColumns
    .map((column) => ({ column, release: latestOf(column.value) }))
    .filter((item) => item.release && /^[a-f0-9]{64}$/i.test(item.release.sha256))
  const formatDate = (value: string) => (value ? value.slice(0, 10) : '')

  return (
    <div className="public-page-stack site-v2 download-v3">
      <header className="page-intro page-hero page-hero-compact" style={{ ['--page-bg' as string]: 'url(/media/bg-light.jpg)' }}>
        <span className="section-kicker">下载</span>
        <h1>下载 LawVerify 客户端</h1>
        <p>支持 Windows 和 Mac（Apple 芯片 / Intel）。安装后用官网账号登录即可。</p>
      </header>

      {mobile ? (
        <div className="mobile-download-note">
          <p>手机上无法安装客户端。复制下载页链接，在电脑上打开下载；也可以先用手机注册账号。</p>
          <div className="hero-actions">
            <CopyDownloadLinkButton className="primary-button" source="download_mobile" />
            <a className="ghost-button" href="/register">免费注册</a>
          </div>
        </div>
      ) : null}

      <section className="dl-grid" aria-label="选择安装包" aria-live="polite">
        {downloadColumns.map((column) => {
          const release = latestOf(column.value)
          const isRec = !mobile && recommended === column.value
          return (
            <div key={column.value} className={`dl-col${isRec ? ' is-rec' : ''}`}>
              <span className="dl-rec">{isRec ? <mark>推荐你下载这个</mark> : null}</span>
              <DownloadIcon kind={column.icon} />
              <h2 className="dl-name">{column.name}<small>{column.sub}</small></h2>
              {release ? (
                <>
                  <p className="dl-version">
                    LawVerify {release.version}
                    {release.channel && release.channel !== 'stable' ? <span className="dl-beta">测试版</span> : null}
                  </p>
                  <p className="dl-meta">
                    {[formatDate(release.publishedAt) ? `${formatDate(release.publishedAt)} 发布` : '', release.platform === 'darwin' ? 'DMG 安装包' : 'EXE 安装包', release.sizeLabel].filter(Boolean).join(' · ')}
                  </p>
                  <a
                    className={isRec ? 'primary-button dl-btn' : 'ghost-button dl-btn'}
                    href={release.downloadUrl}
                    onClick={() => track('download_click', `${column.value}:${release.version}`)}
                  >
                    下载 {column.full}
                  </a>
                  <p className="dl-how">{column.how}</p>
                </>
              ) : releasesStatus === 'loading' ? (
                <p className="dl-meta">正在获取最新版本…</p>
              ) : releasesStatus === 'error' ? (
                <>
                  <p className="dl-meta">暂时无法获取版本信息</p>
                  <button type="button" className="ghost-button dl-btn" onClick={() => window.location.reload()}>刷新重试</button>
                </>
              ) : (
                <p className="dl-meta">这个版本暂未开放下载，请稍后再来。</p>
              )}
            </div>
          )
        })}
      </section>

      <p className="dl-chip-hint">
        <b>不确定是哪种 Mac？</b>点击屏幕左上角苹果菜单 → 关于本机，看“芯片”或“处理器”一栏：写着 Apple M 系列选 Apple 芯片，写着 Intel 选 Intel。
      </p>

      <section className="site-block dl-after" aria-labelledby="first-steps-title">
        <SectionTitle kicker="安装之后" title="第一步做什么？" />
        <ol className="dl-steps">
          {firstSteps.map((step, index) => (
            <li key={step.title}>
              <span className="dl-step-num">{index + 1}</span>
              <span>
                <strong>{step.title}</strong>
                <span>{step.detail}</span>
              </span>
            </li>
          ))}
        </ol>
        <div className="block-footer">
          <a className="text-link" href="/docs">查看完整的快速上手 →</a>
        </div>
      </section>

      {checksums.length || historical.length ? (
        <section className="dl-extra" aria-label="校验与历史版本">
          {checksums.length ? (
            <details className="dl-details">
              <summary>安装包完整性校验</summary>
              <p className="muted">下载完成后再运行安装包。校验值不一致时，请重新下载。</p>
              {checksums.map(({ column, release }) => (
                <div key={column.value} className="dl-sum">
                  <span>{column.full} {release.version}</span>
                  <code>{release.sha256}</code>
                  {release.checksumUrl ? <a className="text-link" href={release.checksumUrl}>下载 SHA256 校验文件</a> : null}
                </div>
              ))}
            </details>
          ) : null}
          {historical.length ? (
            <details className="dl-details" open={showAll} onToggle={(event) => setShowAll((event.target as HTMLDetailsElement).open)}>
              <summary>历史版本（{historical.length}）</summary>
              {historical.map(({ column, release }) => (
                <div key={release.id} className="dl-hist">
                  <strong>{column.full} {release.version}</strong>
                  <span>{[formatDate(release.publishedAt), release.sizeLabel].filter(Boolean).join(' · ')}</span>
                  <a className="text-link" href={release.downloadUrl} onClick={() => track('download_click', `${column.value}:${release.version}:history`)}>下载</a>
                </div>
              ))}
            </details>
          ) : null}
        </section>
      ) : null}
    </div>
  )
}

const productChapters = [
  { id: 'verify', label: '逐句核验' },
  { id: 'materials', label: '超大材料' },
  { id: 'strategy', label: '案件作战图' },
  { id: 'legal', label: '法条与案例' },
  { id: 'import', label: '导入已有文书' },
  { id: 'draft', label: '起草与导出' },
]

function FeatureChapter({
  id,
  kicker,
  title,
  lead,
  points,
  bg,
  layout = 'split',
  children,
}: {
  id: string
  kicker: string
  title: string
  lead: string
  points: string[]
  bg: string
  layout?: 'split' | 'flip' | 'wide'
  children: ReactNode
}) {
  return (
    <section id={id} className={`pf-chapter is-${layout}`} aria-labelledby={`${id}-title`}>
      <div className="pf-copy">
        <span className="section-kicker">{kicker}</span>
        <h2 id={`${id}-title`}>{title}</h2>
        <p>{lead}</p>
        <ul>
          {points.map((point) => <li key={point}>{point}</li>)}
        </ul>
      </div>
      <div className="pf-stage">
        <div className="pf-stage-photo" style={{ backgroundImage: `url(${bg})` }} aria-hidden="true" />
        <div className="pf-stage-inner">{children}</div>
      </div>
    </section>
  )
}

function ProductPage() {
  return (
    <div className="public-page-stack site-v2 product-v3">
      <header className="page-intro page-hero page-hero-lg" style={{ ['--page-bg' as string]: 'url(/media/files-cases.jpg)' }}>
        <span className="section-kicker">产品</span>
        <h1>不做 AI 律师，做签字前的那道核验。</h1>
        <p>支持超大文件材料处理，把文书里的每一句事实按语义对回证据原件，核验引用的法条与案例；先确认代理立场，再看这个案子怎么打。</p>
        <div className="hero-actions">
          <RegisterButton label="免费注册" source="product_hero" />
          <DownloadEntryButton source="product_hero" />
        </div>
        <MobileRegisterHint />
      </header>

      <ProductNav items={productChapters} />

      <FeatureChapter
        id="verify"
        layout="wide"
        kicker="逐句证据核验"
        title="点任意一句，打开它的证据原件。"
        lead="文书逐句对照本案证据原件，每句给出支持、部分支持、证据不足或矛盾，并锚定到具体证据和页码。"
        points={['AI 摘录的引文必须真实出现在原件里，否则不予关联', '看过原件后，可以按自己的判断确认或调整结论']}
        bg="/media/bg-glass.jpg"
      >
        <VerifyDemo />
      </FeatureChapter>

      <FeatureChapter
        id="materials"
        kicker="超大文件材料处理"
        title="整个案卷文件夹，直接关联。"
        lead="同一案件可以关联多个本地文件夹，材料增量导入、分批处理；单份材料最大 100MB。"
        points={['支持 Word、PDF、图片、文本', '从原件提取证明目的、关键事实、金额、时间与证明局限', '材料变更后可以重新梳理']}
        bg="/media/files-binder.jpg"
      >
        <MaterialsPanel />
      </FeatureChapter>

      <FeatureChapter
        id="strategy"
        layout="flip"
        kicker="案件作战图"
        title="接案前 10 分钟，看清这个案子怎么打。"
        lead="先确认代理立场，再按主张梳理成立要件、举证责任、有利与不利证据、补证缺口，以及对方可能的反驳和我方应对。"
        points={['站在你这一边，但不报喜不报忧', '不利证据和对方反驳单独标出']}
        bg="/media/bg-scales.jpg"
      >
        <StrategyMap />
      </FeatureChapter>

      <FeatureChapter
        id="legal"
        kicker="法条与案例核验"
        title="引用的法条和案号，都回到官方来源核对。"
        lead="文书中的法条自动识别并核对国家法律法规数据库，已废止、已修订的条文直接标红；案号回到法院官方页面核对，查不到的如实提示“未能核实”。"
        points={['法条可以查看官方原文', '只有官方正文对得上，案号才显示已核实']}
        bg="/media/bg-gavel.jpg"
      >
        <LegalCheckShowcase />
      </FeatureChapter>

      <FeatureChapter
        id="import"
        layout="flip"
        kicker="导入已有文书"
        title="已经写好的文书，也能核。"
        lead="自己写的、助理写的、用其他 AI 写的代理词或起诉状（Word），导入后和本案证据逐句对照。"
        points={['助理起草、律师复核', '对不上的句子提前看到、提前改']}
        bg="/media/bg-light.jpg"
      >
        <ImportPreview />
      </FeatureChapter>

      <FeatureChapter
        id="draft"
        kicker="质证意见起草"
        title="围绕证据原件起草，改完导出 Word。"
        lead="接近 Word 的连续文稿体验，边生成边审阅；选中一句就能定向改写，完成后导出 Word 继续打磨。"
        points={['每句陈述都能点回证据原件', '法条可查看官方原文']}
        bg="/media/bg-writing.jpg"
      >
        <DraftEditor />
      </FeatureChapter>

      <section className="pf-specs" aria-label="规格">
        <div><strong>100<small>MB</small></strong><span>单份材料上限</span></div>
        <div><strong>4<small>种</small></strong><span>Word、PDF、图片、文本</span></div>
        <div><strong>3<small>个</small></strong><span>Windows / Mac Apple 芯片 / Mac Intel 安装包</span></div>
        <div><strong>4<small>种</small></strong><span>逐句核验结果</span></div>
      </section>
    </div>
  )
}

const quickStartSteps: Array<{ title: string; body: ReactNode }> = [
  {
    title: '注册与登录',
    body: <>在官网<a href="/register">免费注册</a>（手机上也能注册）。然后在电脑上<a href="/download">下载客户端</a>，用同一个账号登录。</>,
  },
  {
    title: '新建案件，关联文件夹，导入证据',
    body: '在客户端新建案件，选择电脑上存放这个案件材料的文件夹。文件夹里的材料会增量同步，支持 Word、PDF、图片、文本。',
  },
  {
    title: '确认代理立场，生成案件作战图',
    body: '先确认代理方、诉求、认可事实和争议事实，再生成办案策略：主张、成立要件、举证责任、有利与不利证据、补证缺口、对方可能的反驳和我方应对。',
  },
  {
    title: '起草质证意见，或导入已有文书',
    body: '可以围绕证据原件起草质证意见；已经写好的代理词、起诉状（Word），也可以直接导入。',
  },
  {
    title: '逐句核验',
    body: (
      <>
        文书会被逐句对照证据原件，每句给出一种结果：
        <ul className="docs-status-list">
          <li><StatusBadge status="support" />证据原件中找到了对应的原文。</li>
          <li><StatusBadge status="partial" />原件只能支持其中一部分，其余部分没有找到依据。</li>
          <li><StatusBadge status="conflict" />原件记载与这句话不一致。</li>
          <li><StatusBadge status="insufficient" />没有找到足以支持这句话的原文。</li>
        </ul>
        点击任意一句，侧边会打开对应的原件。看过原件后，可以按自己的判断确认或调整这句的核验结果，最终以律师判断为准。
      </>
    ),
  },
  {
    title: '导出 Word',
    body: '核验完成后导出 Word，继续打磨。',
  },
]

const docsFaqs = [
  { question: '积分在哪看？', answer: '登录账户中心，首页显示积分余额；「使用情况」页可以看到每一笔扣费明细。' },
  { question: 'Mac 芯片怎么选？', answer: '点击屏幕左上角苹果菜单 → 关于本机：“芯片”一栏写着 Apple M 系列，选 Apple 芯片版；“处理器”一栏写着 Intel，选 Intel 版。' },
  { question: '能处理录音和视频吗？', answer: '目前不支持录音和视频。支持的格式是 Word、PDF、图片和文本。' },
]

function DocsPage() {
  return (
    <div className="public-page-stack site-v2 docs-v2">
      <header className="page-intro page-hero" style={{ ['--page-bg' as string]: 'url(/media/files-binder.jpg)' }}>
        <span className="section-kicker">帮助</span>
        <h1>快速上手</h1>
        <p>从注册到导出 Word，六步走完一份文书的核验。</p>
      </header>

      <ol className="quickstart-list">
        {quickStartSteps.map((step, index) => (
          <li key={step.title} className="quickstart-item">
            <span className="workflow-index">{index + 1}</span>
            <div>
              <h2>{step.title}</h2>
              <div className="quickstart-body">{step.body}</div>
            </div>
          </li>
        ))}
      </ol>

      <section className="site-block" aria-labelledby="docs-faq-title">
        <SectionTitle kicker="常见问题" title="使用中常问的三件事" />
        <dl className="faq-list">
          {docsFaqs.map((item) => (
            <div key={item.question} className="faq-item">
              <dt>{item.question}</dt>
              <dd>{item.answer}</dd>
            </div>
          ))}
        </dl>
        <div className="block-footer">
          <a className="text-link" href="/faq">更多常见问题 →</a>
        </div>
      </section>

      <section className="docs-links" aria-label="更多帮助">
        <a href="/download"><strong>下载客户端</strong><span>Windows 与 Mac 安装包</span></a>
        <a href="/console"><strong>账户中心</strong><span>积分、订单与发票</span></a>
        <a href="/verification"><strong>什么是逐句证据核验</strong><span>四种核验结果怎么理解</span></a>
        <a href="/ai-notice"><strong>AI 使用说明</strong><span>能做什么、不能做什么</span></a>
      </section>
    </div>
  )
}

/* ---------------- GEO / SEO 页面：常见问题、逐句证据核验说明、AI 使用说明 ---------------- */

const siteFaqs: Array<{ question: string; answer: string }> = [
  {
    question: 'LawVerify 是什么？',
    answer: 'LawVerify 是北京智镜科技面向律师的桌面端 AI 产品，定位是“律师的核验台”：不做 AI 律师，做签字前的那道核验。它把文书里的每一句事实对回本案证据原件，逐句标出支持、部分支持、矛盾和证据不足。',
  },
  {
    question: '什么是逐句证据核验？',
    answer: '把代理词、起诉状、质证意见等文书拆成一句句事实，逐句对照本案的证据原件，判断这句话在原件里是否有依据，并给出对应证据和页码。点任意一句，侧边就会打开对应的原件。',
  },
  {
    question: '核验结果有哪几种？',
    answer: '四种：支持（原件中找到了对应原文）、部分支持（只能支持其中一部分）、矛盾（原件记载与这句话不一致）、证据不足（没有找到足以支持这句话的原文）。',
  },
  {
    question: 'AI 会不会编造证据原文？',
    answer: 'LawVerify 要求 AI 摘录的证据原文必须真实出现在证据原件里，否则不予关联。核验结果仍需律师最终核对。',
  },
  {
    question: '已经写好的文书可以核吗？',
    answer: '可以。自己写的、助理写的、用其他 AI 写的代理词或起诉状（Word），导入 LawVerify 后，会和本案证据逐句对照。',
  },
  {
    question: '案件作战图是什么？',
    answer: '先确认代理立场（代理方、诉求、认可事实、争议事实），再生成办案策略：主张、成立要件、举证责任、有利与不利证据、补证缺口、对方可能的反驳和我方应对。它站在你这一边，但会把不利证据和对方的反驳一并列出来。',
  },
  {
    question: '能起草质证意见吗？',
    answer: '可以。LawVerify 围绕证据原件生成质证意见，可以改写，也可以导出 Word 继续打磨。',
  },
  {
    question: '能处理多大的案卷材料？',
    answer: '单份材料最大 100MB，支持 Word、PDF、图片和文本，暂不支持录音、视频。材料较多时会排队分批处理，超过上限的文件需要拆分后再导入。扫描件的识别效果受清晰度影响，关键内容请核对原件。',
  },
  {
    question: '能核对文书里引用的法条和案例吗？',
    answer: '可以。文书中的法条会被自动识别，已废止、已修订的条文直接标红提示，并可查看国家法律法规数据库的官方原文；引用的案号会到法院官网核对，只有官方正文里能对上才显示为已核实，查不到或查询失败时如实提示“未能核实”。',
  },
  {
    question: '支持哪些文件格式？能处理录音、视频吗？',
    answer: '支持 Word、PDF、图片和文本。目前不支持录音和视频。',
  },
  {
    question: '支持哪些电脑系统？',
    answer: '支持 Windows 和 Mac，Mac 分 Apple 芯片和 Intel 两个版本；下载页会自动识别你的系统。',
  },
  {
    question: '怎么收费？',
    answer: '注册即送体验积分；个人版 ¥49/月，专业版 ¥199/月，也可以单独购买积分包。按实际使用扣积分，每笔扣费明细都能在账户中心查看。',
  },
  {
    question: '和通用 AI 写作工具有什么区别？',
    answer: '通用 AI 写作默认中立、根据你的描述来写，出了错要自己逐句去查；LawVerify 先确认代理立场，每句事实都能点回证据原件，对不上、有矛盾、证据不足会逐句标出，法条可以查看官方原文。',
  },
  {
    question: 'LawVerify 能替代律师判断吗？',
    answer: '不能。AI 输出用于辅助审阅，不替代律师判断；法条和证据摘录仍需律师最终核对。',
  },
  {
    question: '适合哪些律师？',
    answer: '适合需要围绕证据出文书的个人律师和律所团队。',
  },
]

function FaqPage() {
  useEffect(() => {
    setPageJsonLd('faq-jsonld', {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: siteFaqs.map((item) => ({
        '@type': 'Question',
        name: item.question,
        acceptedAnswer: { '@type': 'Answer', text: item.answer },
      })),
    })
    return () => setPageJsonLd('faq-jsonld', null)
  }, [])

  return (
    <div className="public-page-stack site-v2 docs-v2">
      <header className="page-intro page-hero" style={{ ['--page-bg' as string]: 'url(/media/bg-writing.jpg)' }}>
        <span className="section-kicker">常见问题</span>
        <h1>关于 LawVerify，律师常问的问题</h1>
        <p>没找到答案？注册后在账户中心提交反馈。</p>
      </header>
      <dl className="faq-list faq-list-page">
        {siteFaqs.map((item) => (
          <div key={item.question} className="faq-item">
            <dt><h2>{item.question}</h2></dt>
            <dd>{item.answer}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

function VerificationPage() {
  useEffect(() => {
    setPageJsonLd('article-jsonld', {
      '@context': 'https://schema.org',
      '@type': 'Article',
      headline: '什么是逐句证据核验？',
      about: '律师文书逐句对照证据原件的核验方法',
      publisher: { '@type': 'Organization', name: siteConfig.companyName },
      mainEntityOfPage: `${siteConfig.siteUrl}/verification`,
    })
    return () => setPageJsonLd('article-jsonld', null)
  }, [])

  return (
    <article className="public-page-stack site-v2 docs-v2 article-v2">
      <header className="page-intro page-hero" style={{ ['--page-bg' as string]: 'url(/media/bg-glass.jpg)' }}>
        <span className="section-kicker">方法</span>
        <h1>什么是逐句证据核验？</h1>
        <p>签字之前，把文书里的每一句事实，对回本案的证据原件。</p>
      </header>

      <section className="article-section">
        <h2>一句话定义</h2>
        <p>逐句证据核验，是把代理词、起诉状、质证意见等文书拆成一句句事实，逐句对照本案的证据原件，判断每一句在原件里是否有依据，并标出对应的证据和页码。</p>
      </section>

      <section className="article-section">
        <h2>为什么要在签字前做</h2>
        <p>文书里一句和证据对不上的事实，可能被对方抓住、被法官质疑。签字之前逐句核一遍，对不上、有矛盾、证据不足的地方，提前看到、提前补。</p>
      </section>

      <section className="article-section">
        <h2>四种核验结果</h2>
        <StatusLegend />
      </section>

      <section className="article-section">
        <h2>看一个例子</h2>
        <p>下面是一份虚构案件的质证意见节选。点击任意一句，右侧会打开对应的证据原件，并高亮引文。</p>
        <VerifyDemo />
      </section>

      <section className="article-section">
        <h2>引文必须真实存在于原件</h2>
        <p>在 LawVerify 中，AI 摘录的证据原文必须真实出现在证据原件里，否则不予关联。这样每一条“有依据”的结论，都能点开原件核对。</p>
      </section>

      <section className="article-section">
        <h2>和“引用跳转”有什么不同</h2>
        <p>常见的引用溯源，跳转的是外部的法律资料；逐句证据核验对照的是你手上这个案子的证据原件——合同、送货单、转账回单——核的是文书里的事实本身。</p>
      </section>

    </article>
  )
}

function AiNoticePage() {
  return (
    <article className="public-page-stack site-v2 docs-v2 article-v2">
      <header className="page-intro page-hero" style={{ ['--page-bg' as string]: 'url(/media/bg-scales.jpg)' }}>
        <span className="section-kicker">AI 使用说明</span>
        <h1>AI 使用说明</h1>
        <p>使用 LawVerify 前，请了解 AI 在其中做什么、不做什么。</p>
      </header>
      <section className="article-section">
        <h2>AI 输出的定位</h2>
        <p>LawVerify 的 AI 输出用于辅助审阅，不替代律师判断；法条和证据摘录仍需律师最终核对。</p>
        <p>核验结果、案件作战图、质证意见草稿，都是供律师参考和修改的材料，最终由律师确认。</p>
      </section>
      <section className="article-section">
        <h2>引文规则</h2>
        <p>AI 摘录的证据原文必须真实出现在证据原件里，否则不予关联。</p>
      </section>
      <section className="article-section">
        <h2>法条</h2>
        <p>文书中的法条自动识别，可以查看国家法律法规数据库的官方原文。引用前请律师核对条文内容与适用情况。</p>
      </section>
      <section className="article-section">
        <h2>目前不支持</h2>
        <ul className="article-list">
          <li>录音、视频文件（目前支持 Word、PDF、图片、文本）。</li>
        </ul>
      </section>
    </article>
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
  const title = mode === 'login' ? '登录 LawVerify' : '免费注册，领取体验积分'
  const actionLabel = mode === 'login' ? '登录' : '免费注册'
  const [started, setStarted] = useState(false)

  return (
    <section className="auth-shell auth-split">
      <figure className="auth-visual" aria-hidden="true">
        <img src={mode === 'login' ? '/images/scene-legal.jpg' : '/images/scene-solo.jpg'} alt="" />
        <figcaption>
          <b>每一句话，<br />都经得起质证。</b>
          <span>超大文件材料处理 · 语义级证据核验 · 案例法条核验</span>
        </figcaption>
      </figure>
      <form
        className="card auth-card"
        onFocusCapture={() => {
          if (mode === 'register' && !started) {
            setStarted(true)
            track('register_start')
          }
        }}
        onSubmit={(event) => {
          event.preventDefault()
          void onSubmit(new FormData(event.currentTarget))
        }}
      >
        <h2>{title}</h2>
        <p className="muted">
          {mode === 'login'
            ? '和客户端使用同一个账号。登录后可以查看积分、订单和发票。'
            : '注册后在电脑上下载客户端，用这个账号登录即可。'}
        </p>

        {mode === 'register' ? (
          <>
            <label>
              律所 / 单位名称
              <input name="organizationName" placeholder="例如：北京市某某律师事务所" required minLength={2} autoComplete="organization" />
            </label>
            <label>
              负责人姓名
              <input name="ownerName" placeholder="请输入姓名" required autoComplete="name" />
            </label>
          </>
        ) : null}

        <label>
          邮箱
          <input name="email" type="text" inputMode="email" placeholder="请输入邮箱" required autoComplete="email" />
        </label>
        <label>
          密码
          <input name="password" type="password" placeholder="至少 6 位密码" required minLength={6} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
        </label>

        {errorMessage ? <div className="form-error">{errorMessage}</div> : null}

        <button className="primary-button wide-button" type="submit" disabled={busy}>
          {busy ? '提交中...' : actionLabel}
        </button>
        <div className="auth-switch">
          {mode === 'login' ? (
            <a href="/register">还没有账号？免费注册</a>
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
        {route === '/admin/usage' ? <AdminUsagePage /> : null}
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
        <h1>{title.split('\n').map((line) => <span className="hero-v2-line" key={line}>{line}</span>)}</h1>
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

function WelcomeCard() {
  const [visible, setVisible] = useState(() => {
    try {
      return new URLSearchParams(window.location.search).get('welcome') === '1'
    } catch {
      return false
    }
  })
  const mobile = useIsMobileDevice()
  if (!visible) return null
  return (
    <section className="card welcome-card">
      <div>
        <span className="section-kicker">注册成功</span>
        <h3>在电脑上下载客户端，用这个账号登录。</h3>
        <p className="muted">登录后新建案件、关联存放证据的文件夹，起草或导入文书，点任意一句开始核验。</p>
      </div>
      <div className="hero-actions">
        {mobile ? null : <a className="primary-button" href="/download" onClick={() => track('download_click', 'welcome')}>下载客户端</a>}
        <CopyDownloadLinkButton className={mobile ? 'primary-button' : 'ghost-button'} source="welcome" />
        <button type="button" className="text-link" onClick={() => {
          setVisible(false)
          try {
            const url = new URL(window.location.href)
            url.searchParams.delete('welcome')
            window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`)
          } catch {
            // 忽略。
          }
        }}>知道了</button>
      </div>
    </section>
  )
}

const practiceAreas = ['合同', '借贷', '公司股权', '劳动', '其他']

function CocreateApplyCard() {
  const [intent, setIntent] = useState<ApplyIntent>(() => readApplyIntent() ?? 'cocreate')
  const [open, setOpen] = useState(() => Boolean(readApplyIntent()) || window.location.hash === '#cocreate')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)
  const cardRef = useRef<HTMLElement>(null)

  useEffect(() => {
    if (open && (readApplyIntent() || window.location.hash === '#cocreate')) {
      cardRef.current?.scrollIntoView({ block: 'start' })
    }
    // 只在首次进入时滚动。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function handleSubmit(form: HTMLFormElement) {
    const formData = new FormData(form)
    const years = String(formData.get('years') ?? '')
    const areas = formData.getAll('areas').map(String)
    const caseload = String(formData.get('caseload') ?? '')
    const contact = String(formData.get('contact') ?? '').trim()
    const extra = String(formData.get('extra') ?? '').trim()
    if (!contact) {
      setNotice({ tone: 'error', text: '请填写微信或手机号，方便我们联系你。' })
      return
    }
    const typeLabel = intent === 'team' ? '律所团队咨询' : '共建律师申请'
    const content = [
      `申请类型：${typeLabel}`,
      `执业年限：${years || '未填写'}`,
      `主要业务领域：${areas.length ? areas.join('、') : '未填写'}`,
      `每月案件量：${caseload || '未填写'}`,
      `联系方式：${contact}`,
      extra ? `补充说明：${extra.slice(0, 600)}` : '',
    ].filter(Boolean).join('\n')

    setBusy(true)
    setNotice(null)
    try {
      await api.submitFeedback({
        feedbackType: 'other',
        title: `官网${typeLabel}`,
        content,
        contact: contact.slice(0, 80),
        clientPlatform: 'web',
        pageContext: '官网账户中心',
      })
      clearApplyIntent()
      track('cocreate_apply_submit', intent)
      form.reset()
      setNotice({ tone: 'success', text: '已提交，我们会通过你留下的联系方式联系你。' })
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : '提交失败，请稍后重试。' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section ref={cardRef} id="cocreate" className="card cocreate-card">
      <div className="section-head">
        <div>
          <h3>申请成为共建律师 / 律所团队咨询</h3>
          <span className="muted">共建律师：民商事诉讼律师优先，共建期间赠送专业版额度，你的反馈直接进入产品迭代。律所团队：说明团队规模和需求，我们会联系你沟通。</span>
        </div>
        {!open ? <button type="button" className="primary-button" onClick={() => setOpen(true)}>填写申请</button> : null}
      </div>
      {open ? (
        <form className="cocreate-form" onSubmit={(event) => {
          event.preventDefault()
          void handleSubmit(event.currentTarget)
        }}>
          <fieldset className="cocreate-type">
            <legend>申请类型</legend>
            <label><input type="radio" name="intent" checked={intent === 'cocreate'} onChange={() => setIntent('cocreate')} />申请成为共建律师</label>
            <label><input type="radio" name="intent" checked={intent === 'team'} onChange={() => setIntent('team')} />律所团队咨询</label>
          </fieldset>
          <label>
            执业年限
            <select name="years" className="streamlined-case-select" defaultValue="">
              <option value="">请选择</option>
              <option>3 年以下</option>
              <option>3–5 年</option>
              <option>5–10 年</option>
              <option>10 年以上</option>
            </select>
          </label>
          <fieldset className="cocreate-areas">
            <legend>主要业务领域（可多选）</legend>
            {practiceAreas.map((area) => (
              <label key={area}><input type="checkbox" name="areas" value={area} />{area}</label>
            ))}
          </fieldset>
          <label>
            每月案件量
            <select name="caseload" className="streamlined-case-select" defaultValue="">
              <option value="">请选择</option>
              <option>5 件以下</option>
              <option>5–10 件</option>
              <option>10–20 件</option>
              <option>20 件以上</option>
            </select>
          </label>
          <label>
            联系方式（微信或手机）
            <input name="contact" required maxLength={80} placeholder="微信号或手机号" />
          </label>
          <label className="cocreate-extra">
            补充说明（选填）
            <textarea name="extra" rows={3} maxLength={600} placeholder={intent === 'team' ? '团队人数、希望怎么协作等' : '你最希望 LawVerify 帮你核什么'} />
          </label>
          {notice ? <div className={notice.tone === 'success' ? 'form-success' : 'form-error'}>{notice.text}</div> : null}
          <div className="hero-actions">
            <button className="primary-button" type="submit" disabled={busy}>{busy ? '提交中...' : '提交申请'}</button>
          </div>
        </form>
      ) : null}
    </section>
  )
}

function ConsoleHome({ data }: { data: DashboardData }) {
  return (
    <div className="stack">
      <WelcomeCard />
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
      <CocreateApplyCard />
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

function SiteFooter() {
  const year = new Date().getFullYear()
  return (
    <footer className="site-footer-v3">
      <div className="sf-inner">
        <div className="sf-cta">
          <div>
            <h2>每一句话，都经得起质证。</h2>
            <p>下一份文书，试试更顺手的方式。注册即送体验积分。</p>
          </div>
          <a className="sf-cta-button" href="/register" onClick={() => track('hero_cta_click', 'register:footer')}>免费注册 →</a>
        </div>
        <div className="sf-main">
          <div className="sf-brand">
            <img src="/brand/lawverify-wordmark-on-dark.svg" alt="LawVerify" width="140" height="40" />
            <p>面向律师的案件分析、证据联动与文书核验工作台。专注办案，有据可依。</p>
          </div>
          <nav className="sf-links" aria-label="页脚导航">
            <div>
              <strong>产品</strong>
              <a href="/product">产品能力</a>
              <a href="/verification">什么是逐句证据核验</a>
              <a href="/pricing">价格</a>
              <a href="/download">下载客户端</a>
            </div>
            <div>
              <strong>帮助</strong>
              <a href="/docs">快速上手</a>
              <a href="/faq">常见问题</a>
              <a href="/ai-notice">AI 使用说明</a>
              {siteConfig.termsUrl ? <a href={siteConfig.termsUrl}>用户协议</a> : null}
              {siteConfig.privacyUrl ? <a href={siteConfig.privacyUrl}>隐私政策</a> : null}
            </div>
            <div>
              <strong>合作</strong>
              <a href="/register?apply=cocreate">申请成为共建律师</a>
              <a href="/console?apply=team#cocreate">律所团队咨询</a>
            </div>
          </nav>
        </div>
        <div className="sf-legal">
          <span>© {year} {siteConfig.companyName}</span>
          {siteConfig.icpNumber ? (
            <a href="https://beian.miit.gov.cn/" target="_blank" rel="noreferrer">{siteConfig.icpNumber}</a>
          ) : null}
          <span className="sf-notice">LawVerify 是律师的辅助工作台，不替代专业判断。材料相关不等于证明成立，模型生成不等于事实认定；证据原件、法条效力、案例出处与适用条件仍需律师核对。<a href="/ai-notice">AI 使用说明</a></span>
        </div>
      </div>
    </footer>
  )
}

const BANNER_KEY = 'lawverify-cocreate-banner-closed'

function CocreateBanner() {
  const [closed, setClosed] = useState(() => {
    try {
      return window.localStorage.getItem(BANNER_KEY) === '1'
    } catch {
      return false
    }
  })
  if (closed) return null
  return (
    <div className="cocreate-banner" role="region" aria-label="共建律师招募">
      <p>
        <b>正在招募 30 位共建律师</b>
        <span>民商事诉讼律师优先，共建期间赠送专业版额度</span>
      </p>
      <a href="/register?apply=cocreate" onClick={() => track('hero_cta_click', 'register:banner')}>立即申请 →</a>
      <button
        type="button"
        aria-label="关闭招募通知"
        onClick={() => {
          setClosed(true)
          try {
            window.localStorage.setItem(BANNER_KEY, '1')
          } catch {
            // 忽略。
          }
        }}
      >
        ×
      </button>
    </div>
  )
}

function Content({
  route,
  data,
  releasesStatus,
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
  releasesStatus: 'loading' | 'ready' | 'error'
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
    return <DownloadPage releases={data.releases} releasesStatus={releasesStatus} />
  }

  if (route === '/product') {
    return <ProductPage />
  }

  if (route === '/docs') {
    return <DocsPage />
  }

  if (route === '/faq') {
    return <FaqPage />
  }

  if (route === '/verification') {
    return <VerificationPage />
  }

  if (route === '/ai-notice') {
    return <AiNoticePage />
  }

  return <HomePage plans={data.plans} packages={data.packages} />
}

export default function App() {
  const route = normalizeRoute(window.location.pathname)
  const [atPageTop, setAtPageTop] = useState(() => window.scrollY < 40)
  useEffect(() => {
    const onScroll = () => setAtPageTop(window.scrollY < 40)
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])
  const topbarOverHero = route === '/' && atPageTop
  const [data, setData] = useState<DashboardData>(fallbackData)
  const [profile, setProfile] = useState<SessionProfile | null>(null)
  const [authToken, setAuthToken] = useState(() => consumeDesktopTokenFromUrl() || authStorage.getToken())
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
  const [releasesStatus, setReleasesStatus] = useState<'loading' | 'ready' | 'error'>('loading')

  // 官网通用：记录渠道来源和申请意向、加载统计脚本（未配置 ID 时不加载）、设置页面标题与描述。
  useEffect(() => {
    captureSiteSource()
    captureApplyIntent()
    loadAnalytics()
  }, [])

  useEffect(() => {
    applyPageMeta(route)
  }, [route])

  const enabledProviders = useMemo(
    () => data.providers.filter((item) => item.enabled),
    [data.providers],
  )

  useEffect(() => {
    let cancelled = false

    // 下载版本单独加载：不再被套餐、支付接口拖慢或拖垮；加载完成前下载页显示“正在获取”，而不是“暂无可下载版本”。
    async function loadReleases() {
      try {
        const releases = await api.getReleases()
        if (cancelled) {
          return
        }
        setData((current) => ({ ...current, releases: releases.items }))
        setReleasesStatus('ready')
      } catch (error) {
        console.error('Failed to load releases.', error)
        if (!cancelled) {
          setReleasesStatus('error')
        }
      }
    }

    async function load() {
      try {
        const [plans, catalog] = await Promise.all([
          api.getPlans(),
          api.getBillingCatalog(),
        ])

        if (cancelled) {
          return
        }

        setData((current) => ({
          ...current,
          plans: plans.items,
          packages: catalog.packages,
          providers: catalog.providers,
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

    void loadReleases()
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
      })
      authStorage.setToken(result.token)
      track('register_complete')
      await recordRegisterSource()
      setAuthToken(result.token)
      window.location.assign('/console?welcome=1')
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : '注册失败。')
    } finally {
      setAuthBusy(false)
    }
  }

  // 带渠道参数（或从外部网站）进入官网的访客注册后，把来源作为一条反馈记下来，管理后台 /admin/feedback 可见。
  // 最多等 2.5 秒，失败也不影响注册。
  async function recordRegisterSource() {
    const source = readSiteSource()
    if (!source) {
      return
    }
    try {
      await Promise.race([
        api.submitFeedback({
          feedbackType: 'other',
          title: '注册来源记录',
          content: describeSiteSource(source),
          clientPlatform: 'web',
          pageContext: '官网注册',
        }),
        new Promise((resolve) => window.setTimeout(resolve, 2500)),
      ])
      clearSiteSource()
    } catch (error) {
      console.error('Failed to record register source.', error)
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
          <a className="brand brand-logo" href="/" aria-label="LawVerify 首页"><img src="/brand/lawverify-wordmark.svg" alt="LawVerify" width="146" height="42" /></a>
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
      {!route.startsWith('/admin') && !route.startsWith('/console') ? <CocreateBanner /> : null}
      <header className={`topbar${topbarOverHero ? ' topbar-over' : ''}`}>
        <a className="brand brand-logo" href="/" aria-label="LawVerify 首页">
          <img className="logo-default" src="/brand/lawverify-wordmark.svg" alt="LawVerify" width="146" height="42" />
          <img className="logo-on-dark" src="/brand/lawverify-wordmark-on-dark.svg" alt="" aria-hidden="true" width="146" height="42" />
        </a>
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
              <a className="primary-button" href="/register" onClick={() => track('hero_cta_click', 'register:nav')}>免费注册</a>
            </>
          )}
        </div>
      </header>
      <main id="main-content" className={`content-shell${route.startsWith('/admin') ? ' admin-content-shell' : ''}`}>
        <Content
          route={route}
          data={data}
          releasesStatus={releasesStatus}
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
        <SiteFooter />
      )}
    </div>
  )
}
