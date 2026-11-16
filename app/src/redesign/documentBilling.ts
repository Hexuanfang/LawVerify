type DocumentBilling = {
  charge: () => Promise<{ entry: { id: string; description: string } }>
  refund: (entryId: string, operationKey: string, note: string) => Promise<unknown>
  refresh: () => void
}

export async function runDocumentAction<T>(
  options: { cloudBilling: boolean; token: string | null; operationKey: string; isCurrent?: () => boolean },
  billing: DocumentBilling,
  task: () => Promise<T>,
): Promise<T> {
  if (!options.token?.trim()) throw new Error('请先使用官网账户登录，再执行文书起草或改写。')
  const assertSession = () => {
    if (options.isCurrent && !options.isCurrent()) throw new Error('账号会话已变化，已停止本次文书操作。')
  }
  assertSession()
  try {
    if (options.cloudBilling) return await task()
    const consumed = await billing.charge()
    try {
      assertSession()
      return await task()
    } catch (cause) {
      try {
        await billing.refund(consumed.entry.id, `${options.operationKey}:refund`, `${consumed.entry.description}失败补回`)
      } catch {
        // 退款请求失败时保留原任务错误，随后刷新云端账本。
      }
      throw cause
    }
  } finally {
    billing.refresh()
  }
}
