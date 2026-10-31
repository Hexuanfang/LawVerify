let importing = false
export async function importWordContent(file: File) {
  if (importing) throw new Error('正在读取文稿，请稍候。')
  if (file.size > 20 * 1024 * 1024) throw new Error('Word 文稿超过20MB，请拆分后导入。')
  importing = true
  let worker: Worker | undefined
  try {
    const buffer = await file.arrayBuffer()
    worker = new Worker(new URL('./word-import.worker.ts', import.meta.url), { type: 'module' })
    const running = worker
    return await new Promise<{ text: string; html: string }>((resolve, reject) => {
      const timer = setTimeout(() => { running.terminate(); reject(new Error('文稿读取超时，请检查文件后重试。')) }, 30000)
      running.onmessage = ({ data }) => {
        clearTimeout(timer)
        if (data.failed) reject(new Error('文稿无法读取或内容过大，请检查文件后重试。'))
        else resolve(data)
      }
      running.onerror = () => { clearTimeout(timer); reject(new Error('文稿读取失败，请重试。')) }
      running.postMessage(buffer, [buffer])
    })
  } finally {
    worker?.terminate()
    importing = false
  }
}
