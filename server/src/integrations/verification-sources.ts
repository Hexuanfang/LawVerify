import type { WorkspaceState } from '../domain.js'
import { readOfficialCaseDetail } from '../intelligence/official-case-verification.js'
import { createNpcStatuteAdapter } from './official-statute.js'
import { createWorkspaceCaseAdapter } from './workspace-case.js'
import { createYuandianCaseAdapter } from './yuandian-case.js'
import { createYuandianToolCaller } from './yuandian-mcp.js'
import { createYuandianStatuteAdapter } from './yuandian-statute.js'

export function createVerificationSources(workspace: Pick<WorkspaceState, 'knowledgeCases'>, caseDeadline?: AbortSignal) {
  const callYuandian = createYuandianToolCaller()
  const localCases = createWorkspaceCaseAdapter(workspace.knowledgeCases, (url, number, signal) => readOfficialCaseDetail(url, number,
    caseDeadline && signal ? AbortSignal.any([caseDeadline, signal]) : caseDeadline ?? signal))
  if (!callYuandian) return { caseAdapter: localCases }
  const vendorCases = createYuandianCaseAdapter(callYuandian)
  const localIds = new Set(workspace.knowledgeCases.map(item => item.id))
  const caseAdapter: typeof localCases = {
    async search(request, signal) {
      const local = await localCases.search(request, signal)
      if (request.action === 'keyword' && local.items.length) return local
      const external = await vendorCases.search(request, signal)
      if (!local.items.length) return external
      if (!external.items.length) return local
      return { ...external, items: [...external.items, ...local.items] }
    },
    async detail(locator, signal) {
      if (!locator.id || localIds.has(locator.id)) {
        const local = await localCases.detail(locator, signal)
        if (local.outcome === 'found') return local
        // 工作区 ID 不属于供应商。按原案号获取额外详情时保留服务方实际 ID。
        return vendorCases.detail({ case_number: locator.case_number }, signal)
      }
      return vendorCases.detail(locator, signal)
    },
  }
  return { statuteAdapter: createYuandianStatuteAdapter(callYuandian), officialStatuteAdapter: createNpcStatuteAdapter(), caseAdapter }
}
