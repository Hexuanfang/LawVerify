// 官网的配置项、统计埋点、渠道来源记录、系统识别和页面 SEO 信息。
// 所有配置都从 VITE_* 环境变量读取，没有配置时对应功能自动隐藏，不会报错。

const env = import.meta.env as Record<string, string | undefined>

function readEnv(key: string) {
  return (env[key] ?? '').trim()
}

export const siteConfig = {
  siteUrl: (readEnv('VITE_SITE_URL') || 'https://lawagent.zhijing.fun').replace(/\/$/, ''),
  // 公司正式全称拿到后，在 .env 里配置 VITE_COMPANY_NAME 替换。
  companyName: readEnv('VITE_COMPANY_NAME') || '北京智镜科技',
  // 百度统计 ID：没有配置时不加载统计脚本。
  baiduTongjiId: readEnv('VITE_BAIDU_TONGJI_ID'),
  // ICP 备案号：已备案，可用 VITE_ICP_NUMBER 覆盖。
  icpNumber: readEnv('VITE_ICP_NUMBER') || '京ICP备2026073156号-1',
  // 用户协议、隐私政策：正式页面上线前留空，页脚不放链接。
  termsUrl: readEnv('VITE_TERMS_URL'),
  privacyUrl: readEnv('VITE_PRIVACY_URL'),
}

/* ---------------- 统计埋点（百度统计） ---------------- */

type HmtQueue = unknown[][]

declare global {
  interface Window {
    _hmt?: HmtQueue
  }
}

let analyticsLoaded = false

export function loadAnalytics() {
  const id = siteConfig.baiduTongjiId
  if (!id || analyticsLoaded || typeof document === 'undefined') {
    return
  }
  analyticsLoaded = true
  try {
    window._hmt = window._hmt || []
    const script = document.createElement('script')
    script.async = true
    script.src = `https://hm.baidu.com/hm.js?${encodeURIComponent(id)}`
    document.head.appendChild(script)
  } catch {
    // 统计脚本加载失败不影响页面。
  }
}

export type TrackEvent =
  | 'hero_cta_click'
  | 'demo_sentence_click'
  | 'download_click'
  | 'copy_download_link'
  | 'register_start'
  | 'register_complete'
  | 'cocreate_apply_submit'
  | 'pricing_view'

export function track(event: TrackEvent, label = '') {
  if (!siteConfig.baiduTongjiId) {
    return
  }
  try {
    window._hmt = window._hmt || []
    window._hmt.push(['_trackEvent', 'official_site', event, label])
  } catch {
    // 忽略埋点异常。
  }
}

/* ---------------- 本地存储（容错） ---------------- */

function storageGet(key: string) {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function storageSet(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // 隐私模式等情况下写入失败，忽略。
  }
}

function storageRemove(key: string) {
  try {
    window.localStorage.removeItem(key)
  } catch {
    // 忽略。
  }
}

/* ---------------- 渠道来源（utm） ---------------- */

const SOURCE_KEY = 'lawverify-site-source'

export interface SiteSource {
  utmSource: string
  utmMedium: string
  utmCampaign: string
  referrer: string
  landingPath: string
  firstSeenAt: string
}

function getExternalReferrerHost() {
  try {
    if (!document.referrer) {
      return ''
    }
    const host = new URL(document.referrer).host
    return host && host !== window.location.host ? host : ''
  } catch {
    return ''
  }
}

// 每次进入官网时调用：链接里带 utm 参数就记下来；没有 utm 但来自外部网站，也记下来源域名。
export function captureSiteSource() {
  try {
    const params = new URLSearchParams(window.location.search)
    const utmSource = (params.get('utm_source') ?? '').trim().slice(0, 60)
    const utmMedium = (params.get('utm_medium') ?? '').trim().slice(0, 60)
    const utmCampaign = (params.get('utm_campaign') ?? '').trim().slice(0, 60)
    const referrer = getExternalReferrerHost()
    if (!utmSource && !utmMedium && !utmCampaign) {
      // 没有新的渠道参数时，不覆盖已经记录的渠道，只在完全没有记录时记下外部来源。
      if (referrer && !readSiteSource()) {
        saveSiteSource({ utmSource: '', utmMedium: '', utmCampaign: '', referrer, landingPath: window.location.pathname, firstSeenAt: new Date().toISOString() })
      }
      return
    }
    saveSiteSource({
      utmSource,
      utmMedium,
      utmCampaign,
      referrer,
      landingPath: window.location.pathname,
      firstSeenAt: new Date().toISOString(),
    })
  } catch {
    // 忽略。
  }
}

function saveSiteSource(source: SiteSource) {
  storageSet(SOURCE_KEY, JSON.stringify(source))
}

export function readSiteSource(): SiteSource | null {
  const raw = storageGet(SOURCE_KEY)
  if (!raw) {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as Partial<SiteSource>
    return {
      utmSource: String(parsed.utmSource ?? ''),
      utmMedium: String(parsed.utmMedium ?? ''),
      utmCampaign: String(parsed.utmCampaign ?? ''),
      referrer: String(parsed.referrer ?? ''),
      landingPath: String(parsed.landingPath ?? ''),
      firstSeenAt: String(parsed.firstSeenAt ?? ''),
    }
  } catch {
    return null
  }
}

export function clearSiteSource() {
  storageRemove(SOURCE_KEY)
}

export function describeSiteSource(source: SiteSource) {
  const parts = [
    source.utmSource ? `utm_source=${source.utmSource}` : '',
    source.utmMedium ? `utm_medium=${source.utmMedium}` : '',
    source.utmCampaign ? `utm_campaign=${source.utmCampaign}` : '',
    !source.utmSource && source.referrer ? `外部来源网站=${source.referrer}` : '',
  ].filter(Boolean)
  return [
    `注册来源：${parts.join('，') || '未知'}`,
    source.landingPath ? `落地页：${source.landingPath}` : '',
    source.firstSeenAt ? `首次带参访问：${source.firstSeenAt.replace('T', ' ').slice(0, 16)}（UTC）` : '',
  ].filter(Boolean).join('\n')
}

/* ---------------- 申请意向（共建律师 / 律所咨询） ---------------- */

const INTENT_KEY = 'lawverify-site-intent'
export type ApplyIntent = 'cocreate' | 'team'

// 链接里带 ?apply=cocreate 或 ?apply=team 时记下意向，注册或登录后在账户中心自动展开对应表单。
export function captureApplyIntent() {
  try {
    const value = new URLSearchParams(window.location.search).get('apply')
    if (value === 'cocreate' || value === 'team') {
      storageSet(INTENT_KEY, value)
    }
  } catch {
    // 忽略。
  }
}

export function readApplyIntent(): ApplyIntent | null {
  const value = storageGet(INTENT_KEY)
  return value === 'cocreate' || value === 'team' ? value : null
}

export function clearApplyIntent() {
  storageRemove(INTENT_KEY)
}

/* ---------------- 访客系统识别 ---------------- */

export type DownloadTarget = 'win32-x64' | 'darwin-arm64' | 'darwin-x64'

export function isMobileDevice() {
  try {
    const ua = navigator.userAgent
    if (/Android|iPhone|iPod|HarmonyOS|Mobile|MicroMessenger.*Mobile/i.test(ua)) {
      return true
    }
    // iPadOS 默认伪装成 Mac：有触屏的“Mac”按平板处理。
    return /Macintosh/i.test(ua) && navigator.maxTouchPoints > 1
  } catch {
    return false
  }
}

export function isMacDevice() {
  try {
    return /Macintosh|Mac OS X|MacIntel/i.test(`${navigator.userAgent} ${navigator.platform}`) && !isMobileDevice()
  } catch {
    return false
  }
}

// 同步判断：Windows 访客 → Windows；Mac 访客 → 默认 Apple 芯片（Intel 需要异步确认）。
export function detectDefaultTarget(): DownloadTarget {
  return isMacDevice() ? 'darwin-arm64' : 'win32-x64'
}

// 尽量识别 Intel Mac：Chromium 系浏览器可读 CPU 架构；其他浏览器看显卡信息里是否带 Intel。识别不了就保持 Apple 芯片。
export async function detectMacArch(): Promise<'arm64' | 'x64' | null> {
  if (!isMacDevice()) {
    return null
  }
  try {
    const uaData = (navigator as Navigator & {
      userAgentData?: { getHighEntropyValues?: (hints: string[]) => Promise<{ architecture?: string }> }
    }).userAgentData
    if (uaData?.getHighEntropyValues) {
      const values = await uaData.getHighEntropyValues(['architecture'])
      if (values.architecture === 'arm') return 'arm64'
      if (values.architecture === 'x86') return 'x64'
    }
  } catch {
    // 继续尝试下一种方式。
  }
  try {
    const canvas = document.createElement('canvas')
    const gl = canvas.getContext('webgl') as WebGLRenderingContext | null
    const info = gl?.getExtension('WEBGL_debug_renderer_info')
    const renderer = gl && info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : ''
    if (/Apple M\d|Apple GPU/i.test(renderer)) return 'arm64'
    if (/Intel|AMD|Radeon/i.test(renderer)) return 'x64'
  } catch {
    // 忽略。
  }
  return null
}

export function getDownloadPageUrl() {
  return `${siteConfig.siteUrl}/download`
}

export async function copyText(text: string) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // 回退到旧方法。
  }
  try {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.setAttribute('readonly', '')
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(textarea)
    return ok
  } catch {
    return false
  }
}

/* ---------------- 页面 SEO 信息 ---------------- */

export interface PageMeta {
  title: string
  description: string
  noindex?: boolean
}

const defaultDescription = '每一句话，都经得起质证。LawVerify 支持上千页的超大案卷材料，把文书里的每一句事实按语义对回证据原件，并逐条核对引用的法条和案例是否现行有效、是否真实存在。'

export const pageMeta: Record<string, PageMeta> = {
  '/': {
    title: 'LawVerify｜律师的核验台：超大材料、语义级证据核验、法条与案例核验',
    description: defaultDescription,
  },
  '/product': {
    title: '产品能力｜逐句证据核验、案件作战图、质证起草 — LawVerify',
    description: 'LawVerify 把文书逐句对照证据原件，标出支持、部分支持、矛盾、证据不足；先确认代理立场再生成案件作战图；围绕原件起草质证意见，法条可查看国家法律法规数据库官方原文。',
  },
  '/pricing': {
    title: '价格｜免费版、个人版、专业版与积分包 — LawVerify',
    description: 'LawVerify 注册即送体验积分，先用自己的真实案件试。个人版 ¥49/月，专业版 ¥199/月，也可单独购买积分包；每笔扣费明细可在账户中心查看。',
  },
  '/download': {
    title: '下载客户端｜Windows 与 Mac（Apple 芯片 / Intel）— LawVerify',
    description: '下载 LawVerify 桌面客户端，支持 Windows 和 Mac（Apple 芯片 / Intel）。安装后用官网账号登录，新建案件、关联证据文件夹，即可开始逐句核验。',
  },
  '/docs': {
    title: '快速上手｜LawVerify 使用帮助',
    description: 'LawVerify 快速上手：注册登录、新建案件并关联证据文件夹、确认代理立场生成案件作战图、起草或导入文书、逐句核验、导出 Word。',
  },
  '/faq': {
    title: '常见问题｜LawVerify 律师的核验台',
    description: 'LawVerify 常见问题：什么是逐句证据核验、核验结果怎么看、AI 会不会编造证据原文、支持哪些格式和系统、怎么收费、和通用 AI 写作工具有什么区别。',
  },
  '/verification': {
    title: '什么是逐句证据核验？签字前把每一句事实对回原件 — LawVerify',
    description: '逐句证据核验：把文书拆成一句句事实，逐句对照本案证据原件，判断支持、部分支持、矛盾或证据不足，并要求引文真实出现在原件中。',
  },
  '/ai-notice': {
    title: 'AI 使用说明 — LawVerify',
    description: 'LawVerify 的 AI 输出用于辅助审阅，不替代律师判断；法条和证据摘录仍需律师最终核对。',
  },
  '/login': { title: '登录 — LawVerify', description: defaultDescription, noindex: true },
  '/register': {
    title: '免费注册，领取体验积分 — LawVerify',
    description: '注册 LawVerify 账号，领取体验积分，在电脑上下载客户端用同一账号登录即可开始逐句核验。',
  },
}

function setMetaTag(attribute: 'name' | 'property', key: string, content: string) {
  let element = document.head.querySelector<HTMLMetaElement>(`meta[${attribute}="${key}"]`)
  if (!element) {
    element = document.createElement('meta')
    element.setAttribute(attribute, key)
    document.head.appendChild(element)
  }
  element.setAttribute('content', content)
}

function setCanonical(href: string) {
  let element = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]')
  if (!element) {
    element = document.createElement('link')
    element.rel = 'canonical'
    document.head.appendChild(element)
  }
  element.href = href
}

export function applyPageMeta(route: string) {
  try {
    const isPrivate = route.startsWith('/console') || route.startsWith('/admin')
    const meta = pageMeta[route] ?? (isPrivate
      ? { title: '账户中心 — LawVerify', description: defaultDescription, noindex: true }
      : pageMeta['/'])
    const url = `${siteConfig.siteUrl}${route === '/' ? '/' : route}`
    document.title = meta.title
    setMetaTag('name', 'description', meta.description)
    setMetaTag('name', 'robots', meta.noindex ? 'noindex, nofollow' : 'index, follow')
    setMetaTag('property', 'og:title', meta.title)
    setMetaTag('property', 'og:description', meta.description)
    setMetaTag('property', 'og:url', url)
    setMetaTag('name', 'twitter:title', meta.title)
    setMetaTag('name', 'twitter:description', meta.description)
    setCanonical(url)
  } catch {
    // 忽略。
  }
}

// 给某个页面挂结构化数据（JSON-LD），离开页面时移除。
export function setPageJsonLd(id: string, data: unknown | null) {
  try {
    const existing = document.getElementById(id)
    if (!data) {
      existing?.remove()
      return
    }
    const element = existing ?? document.createElement('script')
    element.id = id
    element.setAttribute('type', 'application/ld+json')
    element.textContent = JSON.stringify(data)
    if (!existing) document.head.appendChild(element)
  } catch {
    // 忽略。
  }
}
