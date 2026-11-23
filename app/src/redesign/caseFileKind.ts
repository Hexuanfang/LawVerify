export const documentFileAccept = '.doc,.docx,.txt,.md,.markdown'

export function supportsDocumentFile(name: string) {
  return /\.(docx?|txt|md|markdown)$/i.test(name)
}

const priorProceeding = /前审|原审|一审|二审|再审裁判|生效裁判|判决书|裁定书|调解书|仲裁裁决|庭审笔录/
const evidenceCategories = [
  ['合同协议', /合同|协议|借条|欠条|借据|担保书|保证书|承诺书/],
  ['资金往来', /资金|流水|转账|付款|支付|收据|回单|发票|收款|交易明细|账户明细|汇款|对账单|账单/],
  ['沟通记录', /沟通|聊天|微信|短信|邮件|通话|对话|催收|函件/],
  ['身份主体', /身份|户籍|户口|营业执照|工商登记|主体资格|组织机构|授权委托/],
  ['前审文书', priorProceeding],
] as const

const categoryPriority = [...evidenceCategories].reverse()
const documentTitle = /起诉状|答辩状|反诉状|上诉状|申诉状|再审申请书|执行申请书|证据清单|质证意见|代理(?:词|意见)|辩护(?:词|意见)|法律意见书|待核验文书/
const evidenceTitle = /证据(?:目录|材料)|佐证|附件|原件|复印件|扫描件|截图/

export const evidenceCategoryOrder = [...evidenceCategories.map(([category]) => category), '其他'] as const
export type EvidenceCategory = typeof evidenceCategoryOrder[number]
export type CaseFileKind = 'document' | 'evidence'

export function evidenceCategoryKey(account: string, caseId: string) {
  return `lawverify-evidence-categories:${JSON.stringify([account.trim().toLowerCase(), caseId])}`
}

export function readEvidenceCategories(key: string) {
  const overrides = new Map<string, EvidenceCategory>()
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(key) ?? 'null')
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      for (const [id, value] of Object.entries(saved)) {
        const category = evidenceCategoryOrder.find(item => item === value)
        if (category) overrides.set(id, category)
      }
    }
  } catch {
    // 本机存储不可用时，仍按自动分类显示证据。
  }
  return overrides
}

function categoryFor(name: string) {
  return categoryPriority.find(([, pattern]) => pattern.test(name))?.[0]
}

export function evidenceCategory(name: string, folders: string[] = []) {
  return categoryFor(name) ?? folders.slice().reverse().map(categoryFor).find(Boolean) ?? '其他'
}

function canImportAsDocument(file: File) {
  return supportsDocumentFile(file.name) && file.size <= 20 * 1024 ** 2
}

export async function detectCaseFileKind(file: File): Promise<CaseFileKind> {
  if (!canImportAsDocument(file)) return 'evidence'
  const name = file.name.replace(/\.[^.]+$/, '')
  if (priorProceeding.test(name) || evidenceTitle.test(name) && documentTitle.test(name)) return 'evidence'
  if (documentTitle.test(name)) return 'document'
  if (categoryFor(name) || !/\.(txt|md|markdown)$/i.test(file.name)) return 'evidence'
  const start = await file.slice(0, 4096).text().catch(() => '')
  const heading = start.trimStart().split(/\r?\n/, 1)[0].replace(/^#+\s*/, '').replace(/\s/g, '')
  return heading.length <= 42 && documentTitle.test(heading) && !priorProceeding.test(heading) && !evidenceTitle.test(heading)
    ? 'document' : 'evidence'
}
