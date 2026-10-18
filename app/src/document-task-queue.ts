export function createDocumentTaskQueue() {
  let tail: Promise<unknown> = Promise.resolve()
  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      const result = tail.then(task)
      // A failed save must cancel the dependent analysis, not run it on stale text.
      tail = result
      return result
    },
    recover() {
      tail = tail.catch(() => undefined)
    },
  }
}
