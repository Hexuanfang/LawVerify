// No automatic retry: a timed-out mutation may already have committed.
export function boundedFetch(input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = 120000) {
  const timeout = AbortSignal.timeout(timeoutMs)
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout
  return fetch(input, { ...init, signal })
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
