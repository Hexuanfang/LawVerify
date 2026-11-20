import { judgmentSections } from '../integrations/legal-case.js'
import { articleIndex, extractStatuteCitations, isOfficialCaseUrl, normalizeCaseNumber } from './legal-verification.js'
import { calendarDay } from './verification/statute-effect.js'

function allowedUrl(value: string) {
  if (!isOfficialCaseUrl(value)) return false
  const url = new URL(value)
  return !url.username && !url.password && !url.port
}

async function readJudgmentPage(url: string, fetcher: typeof fetch, signal?: AbortSignal) {
  if (!allowedUrl(url)) return { outcome: 'unverified-detail' } as const
  const timeout = AbortSignal.timeout(10000)
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
  const response = await fetcher(url, { signal: requestSignal, redirect: 'error' })
  if (!response.ok || !response.body) return { outcome: response.status === 401 || response.status === 403 ? 'forbidden' : 'unavailable' } as const
  const reader = response.body.getReader()
  let bytes = 0
  const chunks: Uint8Array[] = []
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > 2_000_000) return { outcome: 'unverified-detail' } as const
      chunks.push(value)
    }
  } finally { await reader.cancel().catch(() => {}) }
  const text = judgmentPlainText(Buffer.concat(chunks).toString('utf8'))
  return text ? { outcome: 'found', text } as const : { outcome: 'empty-response' } as const
}

export function judgmentPlainText(content: string) {
  return content
    .replace(/<!--[\s\S]*?-->/gu, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<\/?(?:p|div|section|article|h[1-6]|tr|li)\b[^>]*>|<br\s*\/?>/giu, '\n')
    .replace(/<[^>]*>/gu, '').replace(/&nbsp;|&#160;/giu, ' ').replace(/&quot;|&#34;/giu, '"').replace(/&amp;/giu, '&')
    .replace(/\n[ \t\r]*\n+/gu, '\n').trim()
}

export async function checkOfficialJudgment(url: string, number: string, fetcher: typeof fetch = fetch) {
  const page = await readJudgmentPage(url, fetcher)
  if (page.outcome !== 'found') return false
  const { text } = page
  return normalizeCaseNumber(text).includes(normalizeCaseNumber(number))
    && /判决书|裁定书|裁判文书/.test(text)
}

function officialDate(value?: string) {
  const numeric = calendarDay(value)
  if (numeric !== undefined) return new Date(numeric).toISOString().slice(0, 10)
  const parts = value?.match(/^([零〇○一二三四五六七八九]{4})年([一二三四五六七八九十]{1,3})月([一二三四五六七八九十]{1,3})日$/u)
  if (!parts) return undefined
  const year = [...parts[1].replace(/[〇○]/gu, '零')].map(character => '零一二三四五六七八九'.indexOf(character)).join('')
  const day = calendarDay(`${year}-${articleIndex(parts[2])}-${articleIndex(parts[3])}`)
  if (day !== undefined) return new Date(day).toISOString().slice(0, 10)
}

function caseFeatures(reasoning: string) {
  const unique = (items: string[]) => [...new Set(items)]
  const roles = '出借人|借款人|出卖人|买受人|用人单位|劳动者|侵权人|被侵权人'
  const party_roles = unique([...reasoning.matchAll(new RegExp(roles, 'gu'))].map(item => item[0]))
  const key_facts = unique([...reasoning.matchAll(/借条原件|银行转账|借款交付|货物交付|收货确认|货款结算|劳动合同|解除通知|损害结果|医疗费/gu)]
    .map(item => item[0]))
  const issues = unique([...reasoning.matchAll(/争议焦点(?:在于|是|为|[：:])\s*([^。；\n]+)/gu)].map(item => item[1].trim()))
  const rules = unique([...reasoning.matchAll(new RegExp(`(${roles})(?:依法|应当|应)?(?:承担|负有|负担)举证责任`, 'gu'))]
    .map(item => `${item[1]}举证`).concat([...reasoning.matchAll(/裁判规则[：:]\s*([^。；\n]+)/gu)].map(item => item[1].trim())))
  return { party_roles, key_facts, issues, rules }
}

export async function readOfficialCaseDetail(url: string, number: string, signal?: AbortSignal, fetcher: typeof fetch = fetch) {
  const page = await readJudgmentPage(url, fetcher, signal)
  if (page.outcome !== 'found') return page
  return readCaseJudgmentText(page.text, number)
}

export function readCaseJudgmentText(body: string, number: string) {
  const opening = body.search(/本院认为|原告诉称|上诉人诉称|上诉人上诉请求|判决如下|裁定如下/u)
  if (opening < 0) return { outcome: 'unverified-detail' } as const
  const head = body.slice(0, Math.min(opening, 1000))
  const lines = head.split('\n').map(line => line.trim()).filter(Boolean)
  const formal = lines.findIndex(line => /^(?:民事|刑事|行政)?(?:判决书|裁定书|裁判文书)$/u.test(line))
  const caseNumber = formal >= 0 && lines.slice(formal + 1, formal + 4)
    .find(line => /^[（(]\s*\d{4}[）)]\s*[^\s。；]{3,24}号$/u.test(line))
  if (!caseNumber) return { outcome: 'unverified-detail' } as const
  if (normalizeCaseNumber(caseNumber) !== normalizeCaseNumber(number)) return { outcome: 'identity-mismatch' } as const
  const label = (name: string) => lines.find(line => line.startsWith(`${name}：`) || line.startsWith(`${name}:`))?.slice(name.length + 1).trim()
  const court = lines.slice(0, formal).reverse().find(line => /^[\p{Script=Han}]{2,45}人民法院$/u.test(line))
  const sections = judgmentSections(body)
  const operative = sections.find(section => section.kind === 'operative')?.text ?? ''
  const signatureStart = [...body.matchAll(/\n[\t \u3000]*审\s*判\s*[长员]/gu)].at(-1)?.index
  const signature = signatureStart === undefined ? [] : body.slice(signatureStart).split('\n').map(line => line.trim())
  const dates = [...new Set(signature.map(officialDate).filter(value => value !== undefined))]
  const judgment_date = officialDate(label('裁判日期')) ?? (dates.length === 1 ? dates[0] : undefined)
  const effect = /(?:^|[\n。；])[\t \u3000]*本(?:判决|裁定)为终审(?:判决|裁定)。?(?=[\t \u3000]*(?:\r?\n|$))/u.test(operative) ? 'effective' : 'unknown'
  const procedure = /[民刑行]终/u.test(caseNumber) ? '二审' : /[民刑行]初/u.test(caseNumber) ? '一审' : /[民刑行]再/u.test(caseNumber) ? '再审' : undefined
  const reasoning = sections.find(section => section.kind === 'reasoning')?.text ?? ''
  const referenced_statutes = [...new Set(extractStatuteCitations(reasoning).filter(item => item.number).map(item => item.raw))]
  const priorCasePattern = /(?:上诉人|再审申请人)[^。；\n]{0,35}不服[^。；\n]{0,50}([（(]\d{4}[）)][^\s。；]{3,24}号)[^。；\n]{0,15}(?:判决|裁定)[^。；\n]{0,40}(?:提起上诉|提出上诉|向本院上诉|申请再审|提起再审)/gu
  const history = body.split(/本院认为|本院查明|经审理查明/u, 1)[0]
  const laterCasePattern = /(?:本案|原案)[^。；\n]{0,25}(二审|上诉|再审)[^。；\n]{0,20}([（(]\d{4}[）)][^\s。；]{3,24}号)[^。；\n]{0,10}(?:判决|裁定)/gu
  const related_cases = [
    ...[...history.matchAll(priorCasePattern)].map(item => ({ case_number: item[1], relation: 'prior' as const })),
    ...[...body.matchAll(laterCasePattern)].map(item => ({ case_number: item[2], relation: item[1] === '再审' ? 'retrial' as const : 'appeal' as const })),
  ]
  return { outcome: 'found', item: { case_number: caseNumber, body, name: label('案件名称') ?? label('案名'), court, judgment_date,
    effect, procedure, cause: label('案由'), level: label('案件类型'), referenced_statutes, related_cases, ...caseFeatures(reasoning),
  } } as const
}
