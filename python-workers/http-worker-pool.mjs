import { PythonWorkerPool } from './python-workers.ts'
import { allocateWorker, createResourceSampler, fitsWorker, resourceBudget, singleWorkerBudget } from './desktop-resources.mjs'

const minImageMemoryMB = 1536
const diskWorkerMemoryMB = 3072
const batchThreshold = 4
const desktopIdleMs = 15_000

function visualJob(input) {
  return /\.(pdf|png|jpe?g|webp|bmp|tiff?|gif)$/i.test(input.fileName || '')
}

function workerProfile(slot) {
  return { ...slot.profile, usedMB: Math.min(slot.profile.memoryMB, slot.pool.measuredMemoryMB) }
}

// 每个槽位复用一个既有进程池，使 HTTP 取消只终止对应的在途任务。
export class HttpWorkerPool {
  constructor(options) {
    this.options = { ...options, size: 1 }
    this.closed = false
    this.queue = []
    this.owners = new Map()
    this.turn = 0
    this.resources = options.desktopResources
    this.sample = this.resources && (this.resources.sample ?? createResourceSampler())
    this.gpuRetryAt = 0
    const size = options.size || 1
    this.slots = Array.from({ length: this.resources ? Math.min(size, 2) : size }, () => ({
      pool: this.resources ? null : new PythonWorkerPool(this.options), active: null, idleSince: 0,
    }))
  }

  run(input, signal, account = Symbol()) {
    if (this.closed) return Promise.reject(new Error('解析进程池已关闭'))
    if (signal?.aborted) return Promise.reject(signal.reason)
    if (this.queue.length >= (this.options.maxQueued ?? Infinity)) {
      return Promise.reject(Object.assign(new Error('解析队列任务较多，请稍后重试。'), { code: 'PARSER_QUEUE_FULL' }))
    }
    const owner = this.owners.get(account) ?? { turn: this.turn - 1, pending: 0, active: false }
    this.owners.set(account, owner)
    owner.pending++
    return new Promise((resolve, reject) => {
      const job = { input, signal, account, owner, resolve, reject, slot: null, stopping: null,
        diskBacked: input.pdfDiskBacked === true }
      job.abort = () => {
        if (job.slot) job.stopping ??= job.slot.pool.close()
        else this.removeQueued(job, signal.reason)
      }
      this.queue.push(job)
      signal?.addEventListener('abort', job.abort, { once: true })
      this.schedule()
    })
  }

  release(job) {
    job.signal?.removeEventListener('abort', job.abort)
    if (--job.owner.pending === 0) this.owners.delete(job.account)
  }

  removeQueued(job, error) {
    this.queue.splice(this.queue.indexOf(job), 1)
    this.release(job)
    job.reject(error)
  }

  residentSlot() {
    return this.slots.find(slot => slot.profile?.resident && !slot.retiring)
  }

  schedule() {
    if (this.closed) return
    const budget = this.sample && resourceBudget(this.sample())
    if (budget) {
      const inFlight = this.slots.filter(slot => slot.job && slot.job.input.action !== 'warmup').length
      if (!this.queue.length && !inFlight) this.batch = false
      if (this.slots.length > 1 && (this.queue.length + inFlight >= batchThreshold
        || this.queue.some(job => job.input.batchSize >= batchThreshold))) this.batch = true
      this.maintain(budget)
    }
    while (this.queue.length) {
      // 桌面解析优先分派小文件，HTTP 服务继续按账号轮转。
      const job = this.queue.reduce((best, item) => {
        if (item.owner.active) return best
        if (!best) return item
        if (this.resources && (item.input.action === 'warmup' || best.input.action === 'warmup')
          && item.input.action !== best.input.action) return item.input.action === 'warmup' ? best : item
        if (this.resources && item.input.action === 'parse' && best.input.action === 'parse') {
          return (item.input.sizeBytes ?? Infinity) < (best.input.sizeBytes ?? Infinity) ? item : best
        }
        return best.owner.turn <= item.owner.turn ? best : item
      }, null)
      if (!job) break
      const slot = budget ? this.chooseSlot(job, budget) : this.slots.find(item => !item.active)
      if (!slot) break
      this.queue.splice(this.queue.indexOf(job), 1)
      job.owner.active = true
      job.owner.turn = ++this.turn
      job.slot = slot
      slot.job = job
      slot.active = this.execute(slot, job)
    }
  }

  maintain(budget) {
    const fallbackBudget = singleWorkerBudget(budget)
    const resident = this.residentSlot()
    const keepCpu = budget.freeMB < 384 && this.slots.find(slot => !slot.retiring && slot.profile?.device === 'cpu'
      && !slot.profile.diskBacked && fitsWorker(fallbackBudget, [], workerProfile(slot)))
    const poolIdle = !this.queue.length && !this.slots.some(slot => slot.active)
    for (const slot of this.slots) {
      if (!slot.pool || slot.active || slot.retiring) continue
      const idleMs = Date.now() - slot.idleSince
      if (slot.profile.diskBacked) {
        // PDF 分段之间复用基础 OCR，空闲后释放整个落盘进程。
        if (idleMs >= desktopIdleMs) this.retire(slot)
        continue
      }
      if (slot === resident && fallbackBudget.freeMB >= 0) {
        if (poolIdle && slot.hasParsed && (budget.freeMB < 384 || idleMs >= desktopIdleMs)) {
          // 常驻进程保留基础 OCR，空闲时归还文档推理模型占用的内存。
          slot.hasParsed = false
          slot.active = slot.pool.run({ action: 'release-models' }).catch(() => {}).finally(() => {
            slot.active = null
            this.schedule()
          })
        }
        continue
      }
      const maxIdle = slot.profile.device === 'auto' || this.resources.keepWarm ? desktopIdleMs : 60_000
      if ((budget.freeMB < 384 && slot !== keepCpu) || idleMs >= maxIdle) this.retire(slot)
    }
    if (!this.resources.keepWarm && !this.queue.length && this.slots.every(slot => !slot.pool)) {
      clearInterval(this.maintenance)
      this.maintenance = undefined
      return
    }
    this.maintenance ??= setInterval(() => {
      this.schedule()
      if (this.resources.keepWarm && !this.queue.length && !this.residentSlot()?.pool.hasWorker
        && !this.slots.some(slot => slot.active || slot.retiring || slot.profile?.diskBacked)) {
        // 每个维护周期最多尝试一次，资源不足时由现有队列等待。
        void this.run({ action: 'warmup' }, AbortSignal.timeout(this.options.startupTimeoutMs ?? 120000)).catch(() => {})
      }
    }, this.resources.intervalMs ?? 2000)
    if (this.queue.length) this.maintenance.ref()
    else this.maintenance.unref()
  }

  retire(slot) {
    slot.retiring = slot.pool.close().finally(() => {
      slot.pool = null
      slot.profile = undefined
      slot.retiring = undefined
      this.schedule()
    })
  }

  chooseSlot(job, budget) {
    const active = this.slots.filter(slot => slot.active || slot.retiring).map(workerProfile)
    const idle = this.slots.filter(slot => !slot.active && !slot.retiring)
    const resident = this.residentSlot()
    if (job.diskBacked) return active.length ? undefined : this.chooseDiskSlot(idle)
    if (job.input.pdfWhole === 'prefer' && !active.length) {
      const whole = idle.find(slot => slot.profile?.device === 'cpu' && !slot.profile.diskBacked && slot.profile.memoryMB >= 3072
        && fitsWorker(budget, active, workerProfile(slot)))
      if (whole) return whole
      const profile = allocateWorker(budget, active, 'cpu', 3072)
      if (profile) {
        const empty = idle.find(slot => !slot.pool)
        if (empty) return this.configure(empty, { ...profile, resident: this.resources.keepWarm && !resident }, resident)
        const replacement = idle.find(slot => slot !== resident) ?? resident
        if (replacement) this.retire(replacement)
        return undefined
      }
    }
    if (this.batch && budget.threads === 4 && job.input.action !== 'warmup') {
      const batchSlot = this.chooseBatchSlot(budget, active, idle, resident)
      if (batchSlot || active.length || idle.some(slot => slot.retiring)) return batchSlot
    }
    if (active.length) return undefined

    // PDF 和图片会加载版面及 OCR 模型，空闲预热所需的预算无法覆盖这个峰值。
    const minimumMB = visualJob(job.input) ? minImageMemoryMB : 1024
    const cpuSlots = idle.filter(slot => slot.profile?.device === 'cpu' && !slot.profile.diskBacked
      && slot.profile.memoryMB >= minimumMB)
    const existing = resident && cpuSlots.includes(resident) && fitsWorker(budget, active, workerProfile(resident))
      ? resident : cpuSlots.find(slot => fitsWorker(budget, active, workerProfile(slot)))
    if (existing === resident && existing && !this.resources.preferGpu) return existing
    if (this.resources.gpu && !job.skipGpu && visualJob(job.input) && Date.now() >= this.gpuRetryAt
      && !active.some(profile => profile.device === 'auto')) {
      const existing = idle.find(slot => slot.profile?.device === 'auto')
      if (existing && fitsWorker(budget, active, workerProfile(existing))) return existing
      const profile = allocateWorker(budget, active, 'auto')
      const empty = idle.find(slot => !slot.pool)
      if (profile && existing) {
        this.retire(existing)
        return undefined
      }
      if (profile && empty) return this.configure(empty, profile)
      const replacement = idle.find(slot => slot !== resident)
      if (profile && replacement && !active.length) {
        this.retire(replacement)
        return undefined
      }
    }
    if (existing) return existing
    const makeResident = this.resources.keepWarm && !resident
    let profile = allocateWorker(budget, active, 'cpu', minimumMB)
    if (!profile && !active.length) {
      budget = singleWorkerBudget(budget)
      const fallback = cpuSlots.find(slot => fitsWorker(budget, active, workerProfile(slot)))
      if (fallback) return fallback
      profile = allocateWorker(budget, active, 'cpu', minimumMB)
    }
    if (!profile) {
      if (job.input.action !== 'warmup' && idle.some(slot => slot.profile?.diskBacked)) return this.chooseDiskSlot(idle)
      // 已缓存的模型也占用物理内存。回收后如果能启动更小的 worker，就立即腾出这些内存。
      const cached = idle.filter(slot => slot.pool && !slot.profile.diskBacked)
        .sort((a, b) => b.pool.measuredMemoryMB - a.pool.measuredMemoryMB)
      const reclaimedMB = cached.reduce((sum, slot) => sum + slot.pool.measuredMemoryMB, 0)
      if (reclaimedMB && allocateWorker({ ...budget, freeMB: budget.freeMB + reclaimedMB }, active, 'cpu', minimumMB)) {
        this.retire(cached[0])
        return undefined
      }
      return job.input.action === 'warmup' ? undefined : this.chooseDiskSlot(idle)
    }
    const empty = idle.find(slot => !slot.pool)
    if (empty) return this.configure(empty, { ...profile, resident: makeResident })
    const replacement = idle.find(slot => slot !== resident) ?? idle[0]
    if (replacement) this.retire(replacement)
    return undefined
  }

  chooseDiskSlot(idle) {
    const existing = idle.find(slot => slot.profile?.diskBacked)
    if (existing) return existing
    const cached = idle.filter(slot => slot.pool)
    if (cached.length) {
      for (const slot of cached) this.retire(slot)
      return undefined
    }
    // 此处仅有一个任务运行，暂时超出物理内存预算的部分可由操作系统换页。
    if (idle[0]) return this.configure(idle[0], { device: 'cpu', threads: 1, offset: 0, memoryMB: diskWorkerMemoryMB, diskBacked: true })
  }

  chooseBatchSlot(budget, active, idle, resident) {
    if (active.some(profile => profile.threads !== 2)) return undefined
    const batchBudget = { ...budget, workerThreads: 2 }
    // 首次分配给第二份 OCR 留出预算，避免首个 worker 先用完整个内存余量。
    if (!active.length && !idle.some(slot => slot.profile?.threads === 2 && slot.profile.device === 'cpu')) {
      const available = Math.min(budget.freeMB, budget.memoryMB)
      if (available < 2 * minImageMemoryMB) return undefined
      batchBudget.workerMemoryMB = Math.min(3072, available / 2)
    }
    const existing = idle.find(slot => slot.profile?.device === 'cpu' && slot.profile.threads === 2
      && slot.profile.memoryMB >= minImageMemoryMB && fitsWorker(batchBudget, active, workerProfile(slot)))
    if (existing) return existing
    const profile = allocateWorker(batchBudget, active, 'cpu', minImageMemoryMB)
    if (profile?.threads !== 2) return undefined
    const empty = idle.find(slot => !slot.pool)
    if (!empty) {
      const replacement = idle.find(slot => slot !== resident)
      // 仍有 worker 在处理任务时，保留可复用的双核进程，等内存余量恢复。
      const reusable = active.length && replacement?.profile.device === 'cpu'
        && replacement.profile.threads === 2 && replacement.profile.offset === profile.offset
      if (replacement && !reusable) this.retire(replacement)
      return undefined
    }
    const replaces = idle.includes(resident) && resident.profile.threads !== 2 ? resident : undefined
    return this.configure(empty, { ...profile, resident: this.resources.keepWarm && !resident }, replaces)
  }

  configure(slot, profile, replaces) {
    slot.profile = profile
    slot.hasParsed = false
    slot.pool = new PythonWorkerPool({ ...this.options, retryOnExit: profile.device === 'cpu', onReady: () => {
      if (replaces && this.residentSlot() === replaces && !replaces.active) {
        profile.resident = true
        this.retire(replaces)
      }
    }, workerEnv: {
      ...this.options.workerEnv, MINERU_MODEL_ONNX_DEVICE: profile.device,
      LAWVERIFY_PARSER_THREADS: String(profile.threads), LAWVERIFY_PARSER_CPU_OFFSET: String(profile.offset),
      LAWVERIFY_PARSER_MEMORY_MB: String(profile.memoryMB),
      LAWVERIFY_PARSER_DISK_BACKED: profile.diskBacked ? '1' : '0',
    } })
    return slot
  }

  async execute(slot, job) {
    let retry = false
    try {
      const result = await slot.pool.run(job.input)
      if (this.resources && job.input.pdfRange && !job.signal?.aborted && !this.closed) {
        // 每段释放文档模型，保留基础 OCR 会话供后续任务复用。
        try {
          await slot.pool.run({ action: 'release-models' })
          if (slot.pool.measuredMemoryMB >= slot.profile.memoryMB / 2) job.stopping ??= slot.pool.close()
        }
        catch { job.stopping ??= slot.pool.close() }
        await job.stopping
      }
      if (job.signal?.aborted) throw job.signal.reason
      job.resolve(result)
    } catch (error) {
      if (this.resources && error.code === 'PARSER_MEMORY_LIMIT') {
        job.stopping ??= slot.pool.close()
        if (slot.profile.device === 'cpu' && slot.profile.memoryMB < diskWorkerMemoryMB
          && ['parse', 'pdf-info'].includes(job.input.action)) {
          job.diskBacked = true
          retry = true
        }
      }
      if (slot.profile?.device === 'auto' && !job.signal?.aborted && !this.closed
        && ['PARSER_GPU_BUSY', 'PARSER_GPU_FAILED', 'PARSER_WORKER_EXIT', 'PARSER_START_TIMEOUT', 'PARSER_MEMORY_LIMIT'].includes(error.code)) {
        this.gpuRetryAt = Date.now() + 60_000
        job.skipGpu = true
        job.stopping ??= slot.pool.close()
        retry = true
      }
      // 等原进程退出后才让 HTTP 层删除文件。
      await job.stopping
      if (job.signal?.aborted || this.closed) retry = false
      if (!retry) job.reject(job.signal?.aborted ? job.signal.reason : error)
    } finally {
      if (job.stopping && this.resources) {
        slot.pool = null
        slot.profile = undefined
      } else if (job.stopping && !this.closed) slot.pool = new PythonWorkerPool(this.options)
      if (slot.profile?.resident && job.input.action === 'parse') slot.hasParsed = !job.input.pdfRange
      slot.active = null
      slot.job = null
      slot.idleSince = Date.now()
      job.slot = null
      job.owner.active = false
      if (retry) {
        job.stopping = null
        this.queue.unshift(job)
      }
      else this.release(job)
      this.schedule()
    }
  }

  async close() {
    this.closed = true
    clearInterval(this.maintenance)
    while (this.queue.length) this.removeQueued(this.queue[0], new Error('解析进程池已关闭'))
    const active = this.slots.map(slot => slot.active)
    await Promise.all(this.slots.map(slot => {
      if (!slot.job) return slot.retiring ?? slot.pool?.close()
      return slot.job.stopping ??= slot.pool.close()
    }))
    await Promise.all(active)
  }
}
