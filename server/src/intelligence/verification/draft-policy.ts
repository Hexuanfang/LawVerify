import { AppError } from '../../core/app-error.js'
import type { RoleType } from '../../domain.js'
import type { CasePosition } from '../case-agent.js'

export function assertDraftPosition(position: CasePosition | undefined, role: RoleType, expectedVersion?: number) {
  if (expectedVersion !== undefined && (!position || position.role !== role || position.version !== expectedVersion)) {
    throw new AppError('起草期间代理立场已更新，请按新立场重新生成。', 409, 'DRAFT_POSITION_CHANGED')
  }
  if (!position?.confirmedAt || position.role !== role || (role !== 'plaintiff' && role !== 'defendant')) {
    throw new AppError('请先确认与起草请求一致的原告或被告代理立场。', 409, 'DRAFT_POSITION_REQUIRED')
  }
  return position.version
}
