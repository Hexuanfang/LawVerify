import { availableParallelism, cpus, freemem, totalmem } from 'node:os'
import { execFileSync } from 'node:child_process'

const MiB = 1024 ** 2
const minimumWorkerMB = 1024

export function availableMacMemory(statistics, fallback, totalBytes) {
  const pageSize = Number(/page size of (\d+) bytes/.exec(statistics)?.[1])
  const pages = ['free', 'inactive', 'speculative'].map(name =>
    Number(new RegExp(`^Pages ${name}:\\s*(\\d+)\\.`, 'm').exec(statistics)?.[1]))
  if (!Number.isSafeInteger(pageSize) || pageSize <= 0
    || pages.some(value => !Number.isSafeInteger(value) || value < 0)) return fallback
  const available = pages.reduce((sum, value) => sum + value, 0) * pageSize
  if (!Number.isSafeInteger(available) || available > totalBytes) return fallback
  return Math.max(fallback, available)
}

function cpuTimes() {
  let idle = 0
  let total = 0
  for (const { times } of cpus()) {
    idle += times.idle
    total += times.user + times.nice + times.sys + times.idle + times.irq
  }
  return { idle, total }
}

export function createResourceSampler() {
  let previous = cpuTimes()
  let sampledAt = performance.now()
  let cpuLoad = 0.65
  let memorySampledAt = -Infinity
  let macMemory
  return () => {
    const now = performance.now()
    if (now - sampledAt >= 500) {
      const current = cpuTimes()
      const elapsed = current.total - previous.total
      if (elapsed > 0) cpuLoad = Math.max(0, Math.min(1, 1 - (current.idle - previous.idle) / elapsed))
      previous = current
      sampledAt = now
    }
    const totalBytes = totalmem()
    const freeBytes = freemem()
    if (process.platform === 'darwin' && now - memorySampledAt >= 5000) {
      // 空闲页不含可回收缓存；读取系统计数并缓存，失败时保守回退。
      try {
        macMemory = availableMacMemory(execFileSync('/usr/bin/vm_stat', [], {
          encoding: 'utf8', timeout: 1000,
        }), freeBytes, totalBytes)
      } catch {
        macMemory = undefined
      }
      memorySampledAt = now
    }
    return { cores: availableParallelism(), totalBytes,
      freeBytes: process.platform === 'darwin' ? Math.max(freeBytes, macMemory ?? 0) : freeBytes, cpuLoad }
  }
}

export function resourceBudget({ cores, totalBytes, freeBytes, cpuLoad }) {
  const totalMB = Math.floor(totalBytes / MiB)
  const reserveMB = Math.max(2048, Math.min(8192, Math.ceil(totalMB / 8)))
  return {
    freeMB: Math.floor(freeBytes / MiB) - reserveMB,
    reserveMB,
    memoryMB: Math.min(12 * 1024, Math.floor(totalMB * 0.45)),
    threads: Math.max(1, Math.min(4, Math.floor(cores / 2), Math.floor(cores * (1 - cpuLoad) / 2))),
  }
}

export function singleWorkerBudget(budget) {
  // 首个 CPU worker 可以借用常规预留，但仍给系统留出最低余量。
  return { ...budget, freeMB: budget.freeMB + budget.reserveMB - 512, threads: 1 }
}

export function fitsWorker(budget, active, worker) {
  const usedMB = active.reduce((sum, item) => sum + item.memoryMB, 0)
  const growthMB = [...active, worker].reduce((sum, item) => sum + item.memoryMB - (item.usedMB ?? 0), 0)
  return budget.freeMB >= Math.max(384, growthMB) && usedMB + worker.memoryMB <= budget.memoryMB
    && worker.offset + worker.threads <= budget.threads
    && active.every(item => item.offset + item.threads <= worker.offset || worker.offset + worker.threads <= item.offset)
}

export function allocateWorker(budget, active, device, minimumMB = minimumWorkerMB) {
  const usedMB = active.reduce((sum, item) => sum + item.memoryMB, 0)
  const growthMB = active.reduce((sum, item) => sum + item.memoryMB - (item.usedMB ?? 0), 0)
  const memoryMB = Math.floor(Math.min(budget.workerMemoryMB ?? 3072, budget.freeMB - growthMB, budget.memoryMB - usedMB) / 128) * 128
  if (memoryMB < minimumMB || (device === 'auto' && memoryMB < 2048)) return undefined
  for (let offset = 0; offset < budget.threads; offset++) {
    const remaining = budget.threads - offset
    for (let threads = Math.min(budget.workerThreads ?? (device === 'auto' ? 2 : 4), remaining); threads > 0; threads--) {
      const worker = { offset, threads, memoryMB, device }
      if (fitsWorker(budget, active, worker)) return worker
    }
  }
  return undefined
}
