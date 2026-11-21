import { AppError } from '../../core/app-error.js'
import type { RoleType } from '../../domain.js'
import type { CasePosition } from '../case-agent.js'
import { caseRoleLabels } from '../case-roles.js'
import { docKeys, profile } from './profile.js'

export function assertDraftPosition(position: CasePosition | undefined, role: RoleType, expectedVersion?: number) {
  if (expectedVersion !== undefined && (!position || position.role !== role || position.version !== expectedVersion)) {
    throw new AppError('起草期间代理立场已更新，请按新立场重新生成。', 409, 'DRAFT_POSITION_CHANGED')
  }
  if (!position?.confirmedAt || position.role !== role || !Object.hasOwn(caseRoleLabels, role)) {
    throw new AppError('请先在「案件记忆」中确认与起草请求一致的代理立场。', 409, 'DRAFT_POSITION_REQUIRED')
  }
  return position.version
}

export function inferDraftDocKey(request: string) {
  const form = docKeys.find(key => request.includes(profile.profiles[key].name))
  if (form) return form
  if (/再审申请/u.test(request)) return 'zs'
  if (/答辩意见/u.test(request)) return 'db'
  if (/质证书/u.test(request)) return 'zz'
  if (/申请书|申请答复|程序申请|第三人意见/u.test(request)) return 'proc'
}
