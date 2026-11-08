import { getCurrentWorkspaceAccount } from '../store.js'

// 工作区是「整体快照写入」的：并发执行「读-改-写」会互相覆盖，
// 后写入的一方会把另一方刚写入的理解结果整体覆盖掉。
// 因此凡是会改写工作区的流程都要经过这把锁串行化，
// 而耗时的模型调用放在锁外执行，保证多份材料可以并发理解。
const mutationChains = new Map<string, Promise<unknown>>()

export function runExclusiveWorkspaceMutation<T>(task: () => Promise<T>): Promise<T> {
  const key = getCurrentWorkspaceAccount() ?? '__local__'
  const previous = mutationChains.get(key) ?? Promise.resolve()
  const next = previous.catch(() => {}).then(task)
  mutationChains.set(key, next)
  return next.finally(() => {
    if (mutationChains.get(key) === next) {
      mutationChains.delete(key)
    }
  })
}
