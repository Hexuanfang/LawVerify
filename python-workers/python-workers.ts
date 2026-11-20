import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { totalmem, freemem, availableParallelism } from 'node:os'

interface PoolOptions {
  python: string
  script: string
  size?: number
  workerEnv?: NodeJS.ProcessEnv
  startupTimeoutMs?: number
  taskTimeoutMs?: number
  maxQueued?: number
  retryOnExit?: boolean
  onReady?: () => void
}

interface Job {
  id: number
  input: Record<string, unknown>
  attempts: number
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

interface Worker {
  child: ChildProcessWithoutNullStreams
  ready: boolean
  dead: boolean
  memoryMB?: number
  job?: Job
  timer?: ReturnType<typeof setTimeout>
}

function poolError(message: string, code: string) {
  return Object.assign(new Error(message), { code })
}

const pools = new Set<PythonWorkerPool>()
process.once('exit', () => { for (const pool of pools) pool.terminate() })

export class PythonWorkerPool {
  private options: PoolOptions
  private workers = new Set<Worker>()
  private exiting = new Set<Promise<void>>()
  private queue: Job[] = []
  private sequence = 0
  private closed = false
  private limit: number
  private detected = false

  constructor(options: PoolOptions) {
    this.options = options
    this.limit = options.size ?? 1
    pools.add(this)
  }

  get measuredMemoryMB() {
    return [...this.workers].reduce((sum, worker) => sum + (worker.memoryMB ?? 0), 0)
  }

  get hasWorker() {
    return this.workers.size > 0
  }

  run<T = { pid: number; value?: unknown }>(input: Record<string, unknown>): Promise<T> {
    if (this.closed) return Promise.reject(poolError('解析进程池已关闭。', 'PARSER_CLOSED'))
    if (this.queue.length >= (this.options.maxQueued ?? 64)) {
      return Promise.reject(poolError('解析队列任务较多，请稍后重试。', 'PARSER_QUEUE_FULL'))
    }
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ id: ++this.sequence, input, attempts: 0, resolve: value => resolve(value as T), reject })
      this.schedule()
    })
  }

  private schedule() {
    if (this.closed) return
    for (const worker of this.workers) {
      if (!this.queue.length) return
      if (worker.ready && !worker.job) {
        worker.job = this.queue.shift()
        this.send(worker)
      }
    }
    while (this.queue.length && this.workers.size + this.exiting.size < this.limit) this.start(this.queue.shift()!)
  }

  private start(job: Job) {
    const child = spawn(this.options.python, ['-u', this.options.script], {
      windowsHide: true, shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...this.options.workerEnv, PYTHONUTF8: '1', PYTHONUNBUFFERED: '1' },
    })
    const worker: Worker = { child, ready: false, dead: false, job }
    this.workers.add(worker)
    // 诊断输出单独排空，不能与 JSONL 协议混在 stdout，也不记录案件正文。
    child.stderr.on('data', () => {})
    const reader = createInterface({ input: child.stdout, crlfDelay: Infinity })
    reader.on('line', line => {
      if (worker.dead) return
      if (line.length > 65536) {
        this.fail(worker, poolError('解析进程返回了过大的协议消息。', 'PARSER_PROTOCOL'), false)
        return
      }
      try {
        const response = JSON.parse(line)
        if (Number.isInteger(response.memoryMB) && response.memoryMB >= 0) worker.memoryMB = response.memoryMB
        if (response.type === 'startup-error' && !worker.ready) {
          this.fail(worker, poolError(response.error, response.code), false)
          return
        }
        if (response.type === 'ready' && !worker.ready) {
          clearTimeout(worker.timer)
          worker.ready = true
          if (!this.detected && !this.options.size) {
            this.detected = true
            this.limit = response.device === 'gpu' || totalmem() < 12 * 1024 ** 3 || freemem() < 4 * 1024 ** 3
              ? 1 : Math.min(2, Math.max(1, Math.floor(availableParallelism() / 4)))
          }
          this.send(worker)
          this.options.onReady?.()
          this.schedule()
          return
        }
        if (!worker.job || response.id !== worker.job.id) {
          this.fail(worker, poolError('解析进程响应序号不匹配。', 'PARSER_PROTOCOL'), false)
          return
        }
        if (response.code === 'PARSER_MEMORY_LIMIT') {
          this.fail(worker, poolError(response.error, response.code), false)
          return
        }
        clearTimeout(worker.timer)
        const current = worker.job
        worker.job = undefined
        if (response.error) current.reject(poolError(String(response.error), String(response.code ?? 'PARSE_FAILED')))
        else current.resolve(response.result)
        this.schedule()
      } catch {
        this.fail(worker, poolError('解析进程协议无法读取。', 'PARSER_PROTOCOL'), false)
      }
    })
    child.once('error', () => this.fail(worker, poolError('Python 解析进程无法启动，请检查解析运行环境。', 'PARSER_START_FAILED'), false))
    child.once('exit', code => {
      reader.close()
      if (code === 75) this.fail(worker, poolError('材料解析已达到本机内存上限，请拆分后重试。', 'PARSER_MEMORY_LIMIT'), false)
      else this.fail(worker, poolError('解析进程中断，请重试。', 'PARSER_WORKER_EXIT'), this.options.retryOnExit !== false)
    })
    child.stdin.on('error', () => this.fail(worker, poolError('解析进程连接中断。', 'PARSER_WORKER_EXIT'), this.options.retryOnExit !== false))
    worker.timer = setTimeout(() => this.fail(worker, poolError('解析进程启动超时，请检查模型是否就绪。', 'PARSER_START_TIMEOUT'), false),
      this.options.startupTimeoutMs ?? 120000)
  }

  private send(worker: Worker) {
    if (!worker.job || worker.dead || !worker.ready) return
    worker.timer = setTimeout(() => this.fail(worker, poolError('材料解析超时，请拆分或人工审核。', 'PARSER_TIMEOUT'), false),
      this.options.taskTimeoutMs ?? 900000)
    worker.child.stdin.write(`${JSON.stringify({ ...worker.job.input, id: worker.job.id })}\n`)
  }

  private fail(worker: Worker, error: Error, retryable: boolean) {
    if (worker.dead) return
    worker.dead = true
    clearTimeout(worker.timer)
    this.workers.delete(worker)
    if (worker.child.exitCode === null && worker.child.signalCode === null) {
      const finished = new Promise<void>(resolve => worker.child.once('close', resolve))
      this.exiting.add(finished)
      void finished.then(() => {
        this.exiting.delete(finished)
        this.schedule()
      })
      worker.child.kill()
    }
    const job = worker.job
    worker.job = undefined
    if (job) {
      if (retryable && !this.closed && job.attempts < 1) {
        job.attempts++
        this.queue.unshift(job)
      } else job.reject(error)
    }
    this.schedule()
  }

  terminate() {
    this.closed = true
    for (const job of this.queue.splice(0)) job.reject(poolError('解析进程池已关闭。', 'PARSER_CLOSED'))
    for (const worker of this.workers) this.fail(worker, poolError('解析进程池已关闭。', 'PARSER_CLOSED'), false)
    pools.delete(this)
  }

  async close() {
    this.terminate()
    await Promise.all(this.exiting)
  }
}

