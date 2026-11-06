/**
 * 并发限流工具：把大量耗时任务按固定并发执行，避免一次性打满模型网关。
 * 顺序保持与输入一致，便于按页码/分块序号组装结果。
 */

export type SettledResult<R> =
  | { ok: true; value: R }
  | { ok: false; error: unknown }

/**
 * 顺序执行的映射：结果数组与输入顺序一致。
 * 单个任务失败不会中断其它任务，失败位置以 undefined 占位。
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<Array<R | undefined>> {
  const results = new Array<R | undefined>(items.length)
  if (!items.length) {
    return results
  }

  const effectiveLimit = Math.max(1, Math.min(limit, items.length))
  let cursor = 0

  const runners = Array.from({ length: effectiveLimit }, async () => {
    while (true) {
      const index = cursor
      cursor += 1
      if (index >= items.length) {
        return
      }
      try {
        results[index] = await worker(items[index], index)
      } catch {
        // 单个任务失败不影响其它任务，失败位置保持为 undefined 由调用方判断。
      }
    }
  })

  await Promise.all(runners)
  return results
}

/**
 * 顺序执行的映射：保留每个任务的失败原因，便于把真实错误透传给调用方。
 */
export async function mapSettledWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<Array<SettledResult<R>>> {
  const results = new Array<SettledResult<R>>(items.length)
  if (!items.length) {
    return results
  }

  const effectiveLimit = Math.max(1, Math.min(limit, items.length))
  let cursor = 0

  const runners = Array.from({ length: effectiveLimit }, async () => {
    while (true) {
      const index = cursor
      cursor += 1
      if (index >= items.length) {
        return
      }
      try {
        results[index] = { ok: true, value: await worker(items[index], index) }
      } catch (error) {
        results[index] = { ok: false, error }
      }
    }
  })

  await Promise.all(runners)
  return results
}
