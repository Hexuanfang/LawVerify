import { fork, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { AppError } from '../core/app-error.js'

const MAX_ACTIVE = 2
const MAX_QUEUED = 16
let active = 0
const queue: Array<() => void> = []
async function acquire() {
  if (active < MAX_ACTIVE) { active++; return }
  if (queue.length >= MAX_QUEUED) throw new AppError('材料处理任务较多，请稍后重试。', 429, 'DOCUMENT_QUEUE_FULL')
  await new Promise<void>((resolve, reject) => {
    const resume = () => { clearTimeout(timer); resolve() }
    const timer = setTimeout(() => {
      queue.splice(queue.indexOf(resume), 1)
      reject(new AppError('等待材料处理超时，请稍后重试。', 503, 'DOCUMENT_QUEUE_TIMEOUT'))
    }, 60000)
    queue.push(resume)
  })
}
function release() {
  const next = queue.shift()
  if (next) next()
  else active--
}

export interface DocumentSession {
  request<T>(action: 'word' | 'info' | 'text' | 'page', page?: number): Promise<T>
}

export async function withDocumentSession<T>(buffer: Buffer, operation: (session: DocumentSession) => Promise<T>) {
  if (buffer.byteLength > 100 * 1024 * 1024) throw new AppError('材料超过100MB，请拆分后处理。', 413, 'DOCUMENT_TOO_LARGE')
  await acquire()
  let worker: ChildProcess | undefined
  let lifetimeTimer: ReturnType<typeof setTimeout> | undefined
  try {
    const builtWorker = new URL('./document-worker.js', import.meta.url)
    // Native PDF/canvas modules cannot safely unload in Windows worker_threads.
    worker = fork(existsSync(builtWorker) ? builtWorker : new URL('./document-worker.ts', import.meta.url), [], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true, serialization: 'advanced',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      execArgv: [...process.execArgv.filter(arg => !arg.startsWith('--inspect')), '--max-old-space-size=256'],
    })
    worker.send({ type: 'initialize', bytes: buffer })
    const runningWorker = worker
    let sequence = 0
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
    let terminalError: Error | undefined
    const fail = (error: Error) => {
      terminalError = error
      for (const task of pending.values()) { clearTimeout(task.timer); task.reject(error) }
      pending.clear()
    }
    runningWorker.on('message', (message: unknown) => {
      const { id, result, failed } = message as { id: number; result?: unknown; failed?: boolean }
      const task = pending.get(id)
      if (!task) return
      pending.delete(id)
      clearTimeout(task.timer)
      if (failed) task.reject(new AppError('材料无法解析或超出安全处理范围，请检查原件并拆分后重试。', 400, 'DOCUMENT_PARSE_FAILED'))
      else task.resolve(result)
    })
    runningWorker.on('error', () => fail(new AppError('材料处理进程异常，原件会保留，请重试。', 503, 'DOCUMENT_WORKER_FAILED')))
    runningWorker.on('exit', () => fail(new AppError('材料处理已中断，请重试。', 503, 'DOCUMENT_WORKER_EXIT')))
    lifetimeTimer = setTimeout(() => {
      fail(new AppError('材料处理超过15分钟，请拆分后重试。', 408, 'DOCUMENT_TIMEOUT'))
      runningWorker.kill()
    }, 15 * 60 * 1000)
    return await operation({
      request<R>(action: 'word' | 'info' | 'text' | 'page', page?: number) {
        if (terminalError) return Promise.reject(terminalError)
        return new Promise<R>((resolve, reject) => {
          const id = ++sequence
          const timer = setTimeout(() => {
            fail(new AppError('材料解析超时，请检查原件并拆分后重试。', 408, 'DOCUMENT_TIMEOUT'))
            runningWorker.kill()
          }, 60000)
          pending.set(id, { resolve: value => resolve(value as R), reject, timer })
          runningWorker.send({ id, action, page }, error => {
            if (error) fail(new AppError('材料处理连接中断，请重试。', 503, 'DOCUMENT_WORKER_EXIT'))
          })
        })
      },
    })
  } finally {
    clearTimeout(lifetimeTimer)
    if (worker && worker.exitCode === null && worker.signalCode === null) {
      await new Promise<void>(resolve => {
        worker!.once('exit', () => resolve())
        worker!.kill()
      })
    }
    release()
  }
}

export function extractWordText(buffer: Buffer) {
  return withDocumentSession(buffer, session => session.request<string>('word'))
}
