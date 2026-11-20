import type { StatuteDetailResult } from '../../integrations/legal-statute.js'
import type { CheckOutcome, StatuteValidity, StatuteVerification, StatuteVerificationTrack } from './protocol.js'

const validityAliases: Record<string, StatuteValidity> = {
  valid: 'VALID', effective: 'VALID', 现行有效: 'VALID', 有效: 'VALID',
  amended: 'AMENDED', 已修订: 'AMENDED', 已修正: 'AMENDED', 已被修改: 'AMENDED',
  partial: 'PARTIAL', 部分失效: 'PARTIAL',
  repealed: 'REPEALED', 已废止: 'REPEALED', 废止: 'REPEALED',
  expired: 'EXPIRED', 已失效: 'EXPIRED', 失效: 'EXPIRED',
  pending: 'PENDING', 尚未生效: 'PENDING', 未生效: 'PENDING',
}

export function normalizeStatuteValidity(value: string): StatuteValidity {
  const key = value.trim().toLowerCase()
  return Object.hasOwn(validityAliases, key) ? validityAliases[key] : 'UNCERTAIN'
}

export function calendarDay(value?: string) {
  const parts = value?.match(/^(\d{4})[年./-](\d{1,2})[月./-](\d{1,2})(?:日|T|$)/u)
  if (!parts) return undefined
  const [year, month, date] = parts.slice(1).map(Number)
  const result = new Date(Date.UTC(year, month - 1, date))
  return result.getUTCFullYear() === year && result.getUTCMonth() === month - 1 && result.getUTCDate() === date ? result.getTime() : undefined
}

export function isOfficialStatuteSource(url: string) {
  const host = new URL(url).hostname
  return ['flk.npc.gov.cn', 'xzfg.moj.gov.cn', 'www.moj.gov.cn', 'www.gov.cn', 'www.court.gov.cn', 'www.spp.gov.cn'].includes(host)
}

export function statuteTrack(result?: StatuteDetailResult): StatuteVerificationTrack | undefined {
  if (!result) return undefined
  if (result.outcome !== 'found') return { outcome: result.outcome, checkedAt: result.checkedAt }
  const { item } = result
  return { outcome: result.outcome, checkedAt: item.checked_at ?? result.checkedAt, url: item.url, version: item.version,
    validity: normalizeStatuteValidity(item.validity), publishDate: item.publish_date, effectiveDate: item.effective_date,
    repealDate: item.repeal_date, issuer: item.issuer, region: item.region, transitionNote: item.transition_note }
}

export function assessStatuteEffect(result: StatuteDetailResult, factDate: string | undefined, conflicted: boolean) {
  const track = statuteTrack(result)!
  let validity = conflicted ? 'UNCERTAIN' as const : track.validity ?? 'UNCERTAIN'
  let applicability: StatuteVerification['applicability'] = 'uncertain'
  let confidence: StatuteVerification['confidence'] = 'LOW'
  let outcome: CheckOutcome = 'warn'
  let reason = '事实日期、效力期间或过渡规则尚未确认。'
  if (result.outcome !== 'found') {
    if (['timeout', 'forbidden', 'unavailable', 'empty-response'].includes(result.outcome)) outcome = 'pending'
    reason = '缺少可核对的条文版本。'
    return { validity, applicability, confidence, outcome, reason, factDate, checkedAt: track.checkedAt }
  }
  const { item } = result
  const fact = calendarDay(factDate)
  const start = calendarDay(item.effective_date)
  const end = calendarDay(item.repeal_date)
  const checked = calendarDay(track.checkedAt)
  const official = isOfficialStatuteSource(item.url)
  const ended = validity === 'REPEALED' || validity === 'EXPIRED' || validity === 'AMENDED'
  if (start !== undefined && end !== undefined && end <= start) validity = 'UNCERTAIN'

  if (conflicted || item.transition_note) {
    reason = conflicted ? '数据库与官方记录冲突，版本或过渡适用尚待核实。' : '来源标明存在过渡规则，需复核其对本案事实的适用。'
  } else if (validity !== 'UNCERTAIN' && fact !== undefined && start !== undefined && checked !== undefined && fact <= checked) {
    if (ended && end !== undefined && fact >= end) {
      applicability = 'inapplicable'
      confidence = official ? 'HIGH' : 'MEDIUM'
      outcome = official ? 'fail' : 'warn'
      reason = '事实发生于所引版本停止适用之日或之后。'
    } else if (ended && end !== undefined && fact >= start) {
      applicability = 'applicable'
      confidence = official ? 'HIGH' : 'MEDIUM'
      reason = '事实时间落在所引旧版本的适用期间，保留当前效力状态并提交复核。'
    } else if (validity === 'VALID' && fact >= start && (end === undefined || fact < end)) {
      applicability = 'applicable'
      confidence = official ? 'HIGH' : 'MEDIUM'
      outcome = official ? 'pass' : 'warn'
      reason = '所引版本的有效期间覆盖事实日期。'
    } else if (validity === 'VALID' && fact < start) {
      applicability = 'inapplicable'
      confidence = official ? 'HIGH' : 'MEDIUM'
      outcome = official ? 'fail' : 'warn'
      reason = '事实发生于所引版本施行前。'
    }
  }
  return { validity, applicability, confidence, outcome, reason, factDate, checkedAt: track.checkedAt }
}
