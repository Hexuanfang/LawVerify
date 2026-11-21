import assert from 'node:assert/strict'
import { test } from 'node:test'
import { availableMacMemory, allocateWorker, resourceBudget, singleWorkerBudget } from '../../python-workers/desktop-resources.mjs'

const MiB = 1024 ** 2
const totalBytes = 7 * 1024 ** 3
const statistics = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               17650.
Pages active:                            177730.
Pages inactive:                          177687.
Pages speculative:                        11528.
Pages wired down:                         55764.
Pages purgeable:                            175.
File-backed pages:                       239598.
Pages occupied by compressor:             17273.`

test('macOS 可用内存计入 inactive 缓存，不重复计算活动页和 purgeable 页', () => {
  assert.equal(availableMacMemory(statistics, 420839424, totalBytes), (17650 + 177687 + 11528) * 16384)
  const changed = statistics.replace('177730.', '277730.').replace('175.', '100000.')
  assert.equal(availableMacMemory(changed, 420839424, totalBytes), availableMacMemory(statistics, 420839424, totalBytes))
})

test('缺少计数、页大小或异常计数时保守回退', () => {
  const fallback = 128 * MiB
  for (const invalid of ['', statistics.replace('Pages inactive:', 'Inactive:'),
    statistics.replace('16384 bytes', 'unknown bytes'), statistics.replace('177687.', '99999999999999999.')]) {
    assert.equal(availableMacMemory(invalid, fallback, totalBytes), fallback)
  }
})

test('过期或格式不同的计数不能把可用内存降低到当前空闲值以下', () => {
  const newerFree = 4 * 1024 ** 3
  assert.equal(availableMacMemory(statistics, newerFree, totalBytes), newerFree)
  const fourKiB = statistics.replace('16384 bytes', '4096 bytes')
  assert.equal(availableMacMemory(fourKiB, 0, totalBytes), (17650 + 177687 + 11528) * 4096)
})

test('复现 Mac runner 的 PDF 队列阻塞，修正采样后可分配 CPU worker', () => {
  const measured = { cores: 3, totalBytes, freeBytes: 420839424, cpuLoad: 0.65 }
  const before = singleWorkerBudget(resourceBudget(measured))
  assert.equal(allocateWorker(before, [], 'cpu', 1536), undefined)
  const after = singleWorkerBudget(resourceBudget({
    ...measured, freeBytes: availableMacMemory(statistics, measured.freeBytes, totalBytes),
  }))
  const worker = allocateWorker(after, [], 'cpu', 1536)
  assert.ok(worker)
  assert.equal(worker.threads, 1)
  assert.ok(worker.memoryMB >= 1536)
  assert.ok(worker.memoryMB <= after.memoryMB)
  assert.ok(worker.memoryMB + 512 <= (17650 + 177687 + 11528) * 16384 / MiB)
})

test('真实低内存仍不允许启动 PDF worker', () => {
  const limited = statistics.replace('177687.', '0.').replace('11528.', '0.')
  const budget = singleWorkerBudget(resourceBudget({
    cores: 3, totalBytes, freeBytes: availableMacMemory(limited, 128 * MiB, totalBytes), cpuLoad: 0,
  }))
  assert.equal(allocateWorker(budget, [], 'cpu', 1536), undefined)
})
