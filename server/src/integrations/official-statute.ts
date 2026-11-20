import mammoth from 'mammoth'
import { articleIndex } from '../intelligence/legal-verification.js'
import { calendarDay } from '../intelligence/verification/statute-effect.js'
import { createLegalStatuteAdapter } from './legal-statute.js'

const origin = 'https://flk.npc.gov.cn'
const attachmentHost = 'flkoss.obs-bj2.cucloud.cn'
const maxAttachmentBytes = 5_000_000
const articleHeading = /^[\t \u3000]*第([零〇一二三四五六七八九十百千万两\d]+)条(?:之([零〇一二三四五六七八九十百千万两\d]+))?(?=[\t \u3000]|$)/gmu
const lawTitle = (title: string) => title.replace(/<[^>]+>/gu, '').replace(/\s/gu, '').replace(/^中华人民共和国/u, '')
const articleKey = (number: string, suffix?: string) => `${articleIndex(number)}:${suffix ? articleIndex(suffix) : 0}`

type NpcEdition = { bbbs: string; title: string; sxrq?: string; gbrq?: string; sxx?: number; flxz?: string; zdjgName?: string;
  lsyg?: { bbbs: string; title: string }[] }

function editionDate(item: NpcEdition) { return calendarDay(item.sxrq) ?? Number.NEGATIVE_INFINITY }

function readArticles(text: string) {
  const headings = [...text.matchAll(articleHeading)]
  const articles = new Map<string, string[]>()
  for (const [index, heading] of headings.entries()) {
    const key = articleKey(heading[1], heading[2])
    const end = headings[index + 1]?.index ?? text.length
    const value = text.slice(heading.index + heading[0].length, end)
      .split(/\r?\n[\t \u3000]*第[零〇一二三四五六七八九十百千万两\d]+[编章节]/u, 1)[0].trim()
    if (value) articles.set(key, [...(articles.get(key) ?? []), value])
  }
  return articles
}

export function createNpcStatuteAdapter(fetcher: typeof fetch = fetch) {
  const editionsByLaw = new Map<string, Promise<NpcEdition[]>>()
  const articlesByEdition = new Map<string, Promise<ReturnType<typeof readArticles> | undefined>>()

  async function request(path: string, signal?: AbortSignal, init?: RequestInit) {
    const timeout = AbortSignal.timeout(8000)
    const response = await fetcher(`${origin}${path}`, { ...init, redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
    if (!response.ok) throw Object.assign(new Error('官方法源请求失败。'), { status: response.status })
    return response.json()
  }

  async function getEdition(id: string, signal?: AbortSignal) {
    const { data } = await request(`/law-search/search/flfgDetails?bbbs=${encodeURIComponent(id)}`, signal) as { data?: NpcEdition }
    return data?.bbbs === id ? data : undefined
  }

  async function listEditions(title: string, signal?: AbortSignal) {
    const { rows, code } = await request('/law-search/search/list', signal, {
      method: 'POST', headers: { 'Content-Type': 'application/json;charset=utf-8' },
      body: JSON.stringify({ searchRange: 1, searchType: 2, searchContent: title, sxx: [], sxrq: [], gbrq: [], pageNum: 1, pageSize: 10 }),
    }) as { rows?: NpcEdition[]; code?: number }
    if (code !== 200 || !Array.isArray(rows)) throw new Error('官方法源目录暂不可用。')
    const exact = rows.filter(row => row.bbbs && typeof row.title === 'string' && lawTitle(row.title) === title)
    if (!exact.length) return []
    const latest = await getEdition(exact[0].bbbs, signal)
    if (!latest || lawTitle(latest.title) !== title) return []
    const additional = (latest.lsyg ?? []).filter(item => item.bbbs && !exact.some(row => row.bbbs === item.bbbs) && lawTitle(item.title) === title)
    const history = await Promise.all(additional.slice(0, 12).map(item => getEdition(item.bbbs, signal)))
    return [...new Map([...exact, ...history.filter(item => item !== undefined), latest].map(item => [item.bbbs, item])).values()]
      .filter(item => lawTitle(item.title) === title && editionDate(item) > Number.NEGATIVE_INFINITY)
      .sort((left, right) => editionDate(right) - editionDate(left))
  }

  async function downloadArticles(edition: NpcEdition, signal?: AbortSignal) {
    const { data } = await request(`/law-search/download/pc?format=docx&bbbs=${encodeURIComponent(edition.bbbs)}`, signal) as { data?: { url?: string } }
    if (!data?.url || !URL.canParse(data.url)) return
    const url = new URL(data.url)
    if (url.protocol !== 'https:' || url.hostname !== attachmentHost || url.port || url.username || url.password) return
    const timeout = AbortSignal.timeout(8000)
    const response = await fetcher(url, { redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
    if (!response.ok || !response.body) return
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let bytes = 0
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        bytes += value.byteLength
        if (bytes > maxAttachmentBytes) return
        chunks.push(value)
      }
    } finally { await reader.cancel().catch(() => {}) }
    const { value } = await mammoth.extractRawText({ buffer: Buffer.concat(chunks) })
    const heading = value.trimStart().split(/\r?\n/u, 1)[0]
    return lawTitle(heading) === lawTitle(edition.title) ? readArticles(value) : undefined
  }

  return createLegalStatuteAdapter(async (query, signal) => {
    if (query.action !== 'article_detail' || 'id' in query) return { items: [] }
    const title = lawTitle(query.law_name)
    const number = /^第([零〇一二三四五六七八九十百千万两\d]+)条(?:之([零〇一二三四五六七八九十百千万两\d]+))?$/u.exec(query.article_number)
    if (!title || !number) return { outcome: 'unverified-detail' }
    let editions = editionsByLaw.get(title)
    if (!editions) {
      editions = listEditions(title, signal)
      editionsByLaw.set(title, editions)
    }
    const versions = await editions
    const fact = calendarDay(query.refer_date)
    const index = fact === undefined ? versions.findIndex(item => item.sxx === 3) : versions.findIndex(item => editionDate(item) <= fact)
    const selected = versions[index]
    if (!selected || versions.some(item => item !== selected && editionDate(item) === editionDate(selected))) return { outcome: 'unverified-detail' }
    const edition = await getEdition(selected.bbbs, signal)
    if (!edition || lawTitle(edition.title) !== title || editionDate(edition) !== editionDate(selected)) return { outcome: 'unverified-detail' }
    let reading = articlesByEdition.get(edition.bbbs)
    if (!reading) {
      reading = downloadArticles(edition, signal)
      articlesByEdition.set(edition.bbbs, reading)
    }
    const articles = await reading
    const values = articles?.get(articleKey(number[1], number[2]))
    if (!values && articles && !number[2]) {
      const main = [...articles.keys()].filter(key => key.endsWith(':0')).map(key => Number(key.split(':')[0])).sort((a, b) => a - b)
      if (main.length > 1 && main.every((value, index) => value === index + 1) && articleIndex(number[1]) > main.length) {
        return { outcome: 'authoritative-not-found' }
      }
    }
    if (values?.length !== 1) return { outcome: 'unverified-detail' }
    const validity = edition.sxx === 3 ? 'VALID' : edition.sxx === 2 ? 'AMENDED' : edition.sxx === 1 ? 'REPEALED' : 'UNCERTAIN'
    // 仅同法修订且存在下一明确版本时推断旧版停止适用日。废止日仍须明示。
    const repeal_date = validity === 'AMENDED' ? versions[index - 1]?.sxrq : undefined
    return { items: [{ id: `npc:${edition.bbbs}:${articleKey(number[1], number[2])}`, law_name: edition.title, article_number: query.article_number,
      text: values[0], url: `${origin}/detail2.html?bbbs=${encodeURIComponent(edition.bbbs)}`, validity, version: edition.bbbs,
      effective_date: edition.sxrq, repeal_date, publish_date: edition.gbrq, doc_type: edition.flxz, issuer: edition.zdjgName }] }
  }, { datedDetailByName: true })
}
