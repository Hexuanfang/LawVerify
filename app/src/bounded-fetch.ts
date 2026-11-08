// No automatic retry: a timed-out mutation may already have committed.
export function boundedFetch(input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = 120000) {
  const timeout = AbortSignal.timeout(timeoutMs)
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout
  return fetch(input, { ...init, signal })
}

// 流式请求用空闲超时：每收到一段数据就重新计时。
// 证据联动、生成文书这类任务可能跑十几分钟，总时长上限会把它误判成连接中断，
// 服务端其实一直在正常推进。
export function createStreamFetch(input: RequestInfo | URL, init: RequestInit = {}, idleMs = 60000) {
  const controller = new AbortController()
  const external = init.signal
  const abortFromExternal = () => controller.abort(external?.reason)
  external?.addEventListener('abort', abortFromExternal, { once: true })

  let timer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  const arm = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, idleMs)
  }
  arm()

  return {
    response: fetch(input, { ...init, signal: controller.signal }),
    noteActivity: arm,
    isTimedOut: () => timedOut,
    dispose: () => {
      if (timer) clearTimeout(timer)
      external?.removeEventListener('abort', abortFromExternal)
    },
  }
}

export async function readBoundedSource(response: Response, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  if (!response.ok || !response.body) throw new Error('原件暂时无法读取。')
  const length = Number(response.headers.get('content-length') ?? 0)
  if (length > maxBytes) {
    await response.body.cancel().catch(() => {})
    throw new Error('原件过大，请使用“打开原件”查看。')
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) throw new Error('原件过大，请使用“打开原件”查看。')
      chunks.push(value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    return bytes
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
