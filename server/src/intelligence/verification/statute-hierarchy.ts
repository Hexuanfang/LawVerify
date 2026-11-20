import type { CertificateParagraph } from '../../domain.js'
import type { StatuteDetailResult } from '../../integrations/legal-statute.js'
import type { Declaration } from './protocol.js'

type Detail = Extract<StatuteDetailResult, { outcome: 'found' }>['item']
type Check = NonNullable<Declaration['checks']['B5']>
const normTypes = ['宪法', '法律', '司法解释', '行政法规', '地方性法规', '部门规章', '地方政府规章', '规范性文件'] as const
type NormType = typeof normTypes[number]

const authorityPatterns = {
  legislature: /全国人民代表大会|全国人大常委会/u,
  council: /^(?:中华人民共和国)?国务院$/u,
  judiciary: /最高人民法院|最高人民检察院/u,
  localLegislature: /人民代表大会|人大常委会/u,
  localGovernment: /人民政府/u,
  ministry: /^(?:(?:中华人民共和国)?[\p{Script=Han}]+部|国家[\p{Script=Han}]+(?:总局|局|委员会)|中国人民银行)$/u,
}
const authorityFor: Partial<Record<NormType, keyof typeof authorityPatterns>> = {
  宪法: 'legislature', 法律: 'legislature', 司法解释: 'judiciary', 行政法规: 'council',
  地方性法规: 'localLegislature', 部门规章: 'ministry', 地方政府规章: 'localGovernment',
}
const province = /^(北京|天津|上海|重庆)市|^((?:河北|山西|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|海南|四川|贵州|云南|陕西|甘肃|青海|台湾)省|内蒙古自治区|广西壮族自治区|西藏自治区|宁夏回族自治区|新疆维吾尔自治区)/u

function regionOf(description: string) {
  const text = description.replace(/\s+/gu, '')
  const top = province.exec(text)?.[0]
  const city = text.slice(top?.length ?? 0).match(/^([\p{Script=Han}]{2,8}市)/u)?.[1]
  if (top || city) return { top, city, label: `${top ?? ''}${city ?? ''}` }
}

function assessRegion(scope: ReturnType<typeof regionOf>, facts: string[]): Check | undefined {
  const places = facts.flatMap(fact => [...fact.matchAll(/(?:发生在|发生于|履行地为|所在地为)([^。；，,\s]{2,24})/gu)]
    .flatMap(match => {
      const place = regionOf(match[1])
      return place ? [place] : []
    }))
  if (!scope || new Set(places.map(place => place.label)).size !== 1) {
    return { outcome: 'warn', reason: '地方规范的适用地域或本案已核地点尚待确认。' }
  }
  const place = places[0]
  if ((scope.top && place.top && scope.top !== place.top) || (scope.city && place.city && scope.city !== place.city)) {
    return { outcome: 'fail', reason: `已核地点为${place.label}，超出所引地方规范的${scope.label}适用范围。` }
  }
  if ((scope.top && !place.top) || (scope.city && !place.city)) return { outcome: 'warn', reason: '已核地点的行政区划层级不足以确认地方规范适用。' }
}

export function checkStatuteHierarchy(law: Declaration, paragraph: string, item: Detail, verifiedFacts: string[]): Check {
  const prefix = paragraph.slice(0, law.location.start)
  const declared = prefix.match(/(?:作为|依据|根据|依照|属于|是)\s*(宪法|地方政府规章|地方性法规|行政法规|部门规章|司法解释|规范性文件|法律)\s*$/u)?.[1]
  const actual = normTypes.find(type => item.doc_type?.trim() === type)
  if (!actual) return { outcome: 'pending', reason: '法源未明确规范类型，层级待核。' }
  if (declared && declared !== actual) return { outcome: 'fail', reason: `正文将${actual}标为${declared}。` }
  const suffix = paragraph.slice(law.location.end).split(/[。；！？]/u, 1)[0]
  if (actual === '规范性文件') {
    if (/^\s*(?:直接)?(?:作为|用作)(?:本案)?裁判依据/u.test(suffix) || /(?:作为|用作)(?:本案)?裁判依据的\s*$/u.test(prefix)) {
      return { outcome: 'fail', reason: '规范性文件被标为裁判依据。' }
    }
    return { outcome: 'warn', reason: '规范性文件仅作说理参考，须核对正式裁判依据。' }
  }
  const issuer = item.issuer?.replace(/\s+/gu, '') ?? ''
  const category = (Object.keys(authorityPatterns) as Array<keyof typeof authorityPatterns>).find(key => authorityPatterns[key].test(issuer))
  if (actual !== '地方性法规' && actual !== '地方政府规章' && !category) {
    return { outcome: 'pending', reason: '制定机关缺失或无法核实，规范层级待核。' }
  }
  if (category && category !== authorityFor[actual]) return { outcome: 'fail', reason: `法源所列制定机关${issuer}与${actual}的权限不符。` }
  if (actual === '地方性法规' || actual === '地方政府规章') {
    if (!category) return { outcome: 'pending', reason: '地方规范的制定机关待核。' }
    const scope = regionOf(item.region ?? issuer)
    const issue = assessRegion(scope, verifiedFacts)
    if (issue) return issue
  }
  if (/同位阶[^。；]{0,15}冲突/u.test(suffix)) return { outcome: 'warn', reason: '正文存在同位阶冲突主张，需核对特别法、新旧法或适用决定。' }
  return { outcome: 'pass', reason: `已核对${actual}的制定机关、规范类型及适用范围。` }
}

function superior(first: string | undefined, second: string | undefined) {
  if (!first || !second || first === second) return false
  if (first === '宪法') return true
  if (first === '法律') return ['行政法规', '地方性法规', '部门规章', '地方政府规章'].includes(second)
  return first === '行政法规' && ['地方性法规', '部门规章', '地方政府规章'].includes(second)
}

export function statuteConflictChecks(paragraphs: Array<Pick<CertificateParagraph, 'id' | 'text'>>, declarations: Declaration[],
  details: ReadonlyMap<string, Detail>) {
  const checks = new Map<string, Check>()
  const laws = declarations.filter(item => item.type === 'E-LAW' && item.checks.B5?.outcome === 'pass' && details.has(item.id))
  for (const paragraph of paragraphs) {
    const scoped = laws.filter(item => item.location.paragraphId === paragraph.id).sort((a, b) => a.location.start - b.location.start)
    if (scoped.length !== 2) continue
    const [first, second] = scoped
    if (first.location.sentenceIndex !== second.location.sentenceIndex) continue
    const tail = paragraph.text.slice(second.location.end).split(/[。；！？]/u, 1)[0]
    const between = paragraph.text.slice(first.location.end, second.location.start)
    if (!/冲突|抵触/u.test(between + tail)) continue
    const left = details.get(first.id)?.doc_type
    const right = details.get(second.id)?.doc_type
    const preferred = tail.match(/(?:^|[，,、：:]|(?:冲突|抵触)时?)\s*(?:因此|故)?\s*(?:应当|应|须|必须)?\s*(?:优先|先)适用\s*(前者|后者)/u)?.[1]
    if ((preferred === '前者' && superior(right, left)) || (preferred === '后者' && superior(left, right))) {
      checks.set((preferred === '前者' ? first : second).id, { outcome: 'fail', reason: '正文主张优先适用下位规范，与已核规范层级不符。' })
    } else if (left === right || !preferred || !(superior(left, right) || superior(right, left))) {
      const reason = left === right ? '两处引用属于同位阶规范，须核对特别法、新旧法或适用决定。' : '正文提出规范冲突，具体适用规则仍待核对。'
      for (const law of scoped) checks.set(law.id, { outcome: 'warn', reason })
    }
  }
  return checks
}
