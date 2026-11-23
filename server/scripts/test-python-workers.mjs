import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { test } from 'node:test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PythonWorkerPool } from '../../python-workers/python-workers.ts'
import { HttpWorkerPool } from '../../python-workers/http-worker-pool.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const python = process.env.LAWVERIFY_TEST_PYTHON
if (!python) throw new Error('请设置 LAWVERIFY_TEST_PYTHON 指向可执行 Python')
const options = { python, script: path.join(root, 'server/scripts/fixtures/python-worker.py'),
  size: 1, startupTimeoutMs: 5000, taskTimeoutMs: 3000, maxQueued: 8 }

test('常驻进程复用 PID，单文件错误后仍可继续', async () => {
  const pool = new PythonWorkerPool(options)
  try {
    const first = await pool.run({ value: 1 })
    await assert.rejects(pool.run({ action: 'error' }), /synthetic bad document/)
    const second = await pool.run({ value: 2 })
    assert.equal(first.pid, second.pid)
    assert.equal(second.value, 2)
  } finally { await pool.close() }
})

test('两个常驻进程同时接收任务，后续任务继续复用', async () => {
  const pool = new PythonWorkerPool({ ...options, size: 2 })
  try {
    const values = await Promise.all(Array.from({ length: 6 }, (_, value) => pool.run({ value, delay: 0.08 })))
    assert.equal(new Set(values.map(value => value.pid)).size, 2)
    assert.deepEqual(values.map(value => value.value), [0, 1, 2, 3, 4, 5])
  } finally { await pool.close() }
})

test('崩溃最多重试一次，后续任务可由新进程完成', async () => {
  const pool = new PythonWorkerPool(options)
  try {
    await assert.rejects(pool.run({ action: 'crash' }), /进程|中断/)
    assert.equal((await pool.run({ value: 'recovered' })).value, 'recovered')
  } finally { await pool.close() }
})

test('任务超时回收进程，后续任务恢复', async () => {
  const pool = new PythonWorkerPool({ ...options, taskTimeoutMs: 100 })
  try {
    await assert.rejects(pool.run({ delay: 1 }), /超时/)
    assert.equal((await pool.run({ value: 9 })).value, 9)
  } finally { await pool.close() }
})

test('队列过载及时拒绝，关闭后拒绝新任务', async () => {
  const pool = new PythonWorkerPool({ ...options, maxQueued: 1 })
  const first = pool.run({ delay: 0.1 })
  const queued = pool.run({ delay: 0.1 })
  try {
    await assert.rejects(pool.run({ delay: 0.1 }), /队列|任务较多/)
    await first
    await queued
  } finally { await pool.close() }
  await assert.rejects(pool.run({}), /关闭/)
})

test('HTTP 请求截止时间覆盖排队，执行中取消等待进程退出后恢复', async () => {
  const pool = new HttpWorkerPool(options)
  try {
    const warm = await pool.run({ value: 'warm' })
    const first = pool.run({ delay: 0.15, value: 'first' })
    const start = performance.now()
    await assert.rejects(pool.run({ value: 'expired' }, AbortSignal.timeout(30)))
    assert.ok(performance.now() - start < 140)
    assert.equal((await first).pid, warm.pid, '取消排队任务不影响执行中的任务')
    await assert.rejects(pool.run({ delay: 1 }, AbortSignal.timeout(30)))
    const recovered = await pool.run({ value: 'recovered' })
    assert.equal(recovered.value, 'recovered')
    assert.notEqual(recovered.pid, warm.pid)
  } finally { await pool.close() }
})

test('解析队列在两个账号间轮转，先到账号的第二件不抢占另一账号', async () => {
  const pool = new HttpWorkerPool(options)
  try {
    const order = []
    const submit = (account, value, delay = 0) => pool.run({ value, delay }, undefined, account)
      .then(result => order.push(result.value))
    await Promise.all([submit('A', 'A1', 0.15), submit('A', 'A2'), submit('B', 'B1'), submit('B', 'B2')])
    assert.deepEqual(order, ['A1', 'B1', 'A2', 'B2'])
  } finally { await pool.close() }
})

test('桌面解析先分派队列中的小文件，同大小保留入队顺序', async () => {
  const directory = await mkdtemp(path.join(root, 'tmp/parser-queue-size-'))
  const GiB = 1024 ** 3
  const pool = new HttpWorkerPool({ ...options, desktopResources: {
    sample: () => ({ cores: 8, totalBytes: 16 * GiB, freeBytes: 8 * GiB, cpuLoad: 0.1 }),
  } })
  try {
    const order = []
    const running = pool.run({ value: 'running', delay: 0.15 }).then(result => order.push(result.value))
    const submit = (name, sizeBytes) => pool.run({ action: 'parse', fileName: `${name}.txt`, sizeBytes,
      outputPath: path.join(directory, `${name}.json`),
    }).then(() => order.push(name))
    await Promise.all([running, submit('large', 1000), submit('small-first', 10), submit('small-second', 10)])
    assert.deepEqual(order, ['running', 'small-first', 'small-second', 'large'])
  } finally {
    await pool.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('大 PDF 可用内存恢复时升级到 3 GiB worker', async () => {
  const MiB = 1024 ** 2
  let freeBytes = 3584 * MiB
  const pool = new HttpWorkerPool({ ...options, desktopResources: {
    keepWarm: true, sample: () => ({ cores: 16, totalBytes: 16384 * MiB, freeBytes, cpuLoad: 0.1 }),
  } })
  try {
    const low = await pool.run({ action: 'resource-test', fileName: 'first.pdf' })
    assert.equal(low.memoryMB, 1536)
    freeBytes = 5120 * MiB
    const upgraded = await pool.run({ action: 'resource-test', fileName: 'large.pdf', pdfWhole: 'prefer' })
    assert.equal(upgraded.memoryMB, 3072)
    assert.notEqual(upgraded.pid, low.pid)
  } finally { await pool.close() }
})

test('低内存下实际任务越过预热并串行启动，可用内存恢复后按资源并发', async () => {
  const GiB = 1024 ** 3
  let freeBytes = GiB
  const pool = new HttpWorkerPool({ ...options, size: 4, desktopResources: {
    sample: () => ({ cores: 16, totalBytes: 32 * GiB, freeBytes, cpuLoad: 0.2 }),
    intervalMs: 20,
  } })
  try {
    const controller = new AbortController()
    const warmup = assert.rejects(pool.run({ action: 'warmup' }, controller.signal), { name: 'AbortError' })
    const submit = () => pool.run({ action: 'resource-test', fileName: 'scan.pdf', delay: 0.1, batchSize: 4 },
      AbortSignal.timeout(2000))
    const low = await Promise.all([submit(), submit()])
    assert.equal(low[0].pid, low[1].pid)
    assert.ok(low.every(result => result.threads === 1 && result.device === 'cpu' && result.diskBacked))
    controller.abort()
    await warmup
    freeBytes = 20 * GiB
    const results = await Promise.all([submit(), submit()])
    assert.notEqual(results[0].pid, results[1].pid, '资源充足时并行分派给两个进程')
  } finally { await pool.close() }
})

test('正常 CPU worker 内存超限后，实际任务改用单线程落盘 worker 重试', async () => {
  const MiB = 1024 ** 2
  const pool = new HttpWorkerPool({ ...options, desktopResources: {
    sample: () => ({ cores: 8, totalBytes: 16384 * MiB, freeBytes: 2304 * MiB, cpuLoad: 0.5 }),
  }, workerEnv: { LAWVERIFY_TEST_MIN_MEMORY_MB: '2048' } })
  try {
    const result = await pool.run({ action: 'pdf-info', fileName: 'scan.pdf' }, AbortSignal.timeout(2500))
    assert.deepEqual(result, { diskBacked: true, threads: 1 })
  } finally { await pool.close() }
})

test('单份复用四核常驻 worker，六份批量切到两个互不重叠的两核 worker', async t => {
  const GiB = 1024 ** 3
  let freeBytes = 20 * GiB
  const pool = new HttpWorkerPool({ ...options, size: 4, desktopResources: {
    keepWarm: true, sample: () => ({ cores: 16, totalBytes: 32 * GiB, freeBytes, cpuLoad: 0.1 }),
  } })
  try {
    const warm = await pool.run({ action: 'warmup' })
    const single = await pool.run({ action: 'resource-test', fileName: 'scan.pdf' })
    assert.equal(single.pid, warm.pid)
    assert.equal(single.threads, 4)
    const batch = await Promise.all(Array.from({ length: 6 }, (_, index) => pool.run({
      action: 'resource-test', fileName: `batch-${index}.pdf`, batchSize: 6, delay: 0.15,
    }, AbortSignal.timeout(4000))))
    assert.equal(new Set(batch.map(result => result.pid)).size, 2)
    assert.deepEqual([...new Set(batch.map(result => result.offset))].sort(), [0, 2])
    assert.ok(batch.every(result => result.threads === 2))
    const next = await pool.run({ action: 'resource-test', fileName: 'next.pdf' })
    assert.ok(batch.some(result => result.pid === next.pid), '批量结束后下一份直接复用已预热的 worker')
    const retire = t.mock.method(pool, 'retire')
    freeBytes = 9.5 * GiB
    const queued = await Promise.all([1, 4].map(batchSize => pool.run({
      action: 'resource-test', fileName: 'scan.pdf', batchSize, delay: 0.08,
    }, AbortSignal.timeout(4000))))
    assert.ok(queued.every(result => batch.some(previous => previous.pid === result.pid)))
    assert.equal(retire.mock.callCount(), 0, '余量短暂下降时不重启已经预热的备用 worker')
  } finally { await pool.close() }
})

test('内存只允许一份 OCR 时，批量仍由一个 worker 串行处理', async () => {
  const GiB = 1024 ** 3
  const pool = new HttpWorkerPool({ ...options, size: 4, desktopResources: {
    keepWarm: true, sample: () => ({ cores: 16, totalBytes: 16 * GiB, freeBytes: 4 * GiB, cpuLoad: 0.1 }),
  } })
  try {
    const batch = await Promise.all(Array.from({ length: 4 }, (_, index) => pool.run({
      action: 'resource-test', fileName: `scan-${index}.pdf`, batchSize: 4, delay: 0.06,
    }, AbortSignal.timeout(4000))))
    assert.equal(new Set(batch.map(result => result.pid)).size, 1)
    assert.ok(batch.every(result => result.memoryMB >= 1536))
  } finally { await pool.close() }
})

test('低于常规内存预留时，仍由一个 CPU worker 串行解析', async () => {
  const GiB = 1024 ** 3
  const pool = new HttpWorkerPool({ ...options, size: 4, desktopResources: {
    gpu: true, sample: () => ({ cores: 16, totalBytes: 32 * GiB, freeBytes: 2.25 * GiB, cpuLoad: 0.99 }),
  } })
  try {
    const parse = () => pool.run({ action: 'resource-test', fileName: 'material.pdf' }, AbortSignal.timeout(2500))
    const [first, second] = await Promise.all([parse(), parse()])
    assert.equal(first.device, 'cpu')
    assert.equal(first.threads, 1)
    assert.equal(first.pid, second.pid)
    assert.equal((await parse()).pid, first.pid, '在低内存下继续复用首个 CPU worker')
  } finally { await pool.close() }
})

test('常驻 CPU worker 超过空闲回收时间仍可复用', async t => {
  const GiB = 1024 ** 3
  const pool = new HttpWorkerPool({ ...options, desktopResources: {
    keepWarm: true, gpu: true, sample: () => ({ cores: 8, totalBytes: 16 * GiB, freeBytes: 8 * GiB, cpuLoad: 0.1 }),
  } })
  try {
    const first = await pool.run({ action: 'warmup' })
    const later = Date.now() + 61_000
    t.mock.method(Date, 'now', () => later)
    const next = await pool.run({ action: 'resource-test', fileName: 'material.pdf' })
    assert.equal(next.pid, first.pid)
    assert.equal(next.device, 'cpu')
  } finally { await pool.close() }
})

test('解析结束后空闲时释放模型，同一个常驻 worker 继续接单', async t => {
  const GiB = 1024 ** 3
  const directory = await mkdtemp(path.join(root, 'tmp/parser-idle-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const pool = new HttpWorkerPool({ ...options, desktopResources: {
    keepWarm: true, intervalMs: 20, sample: () => ({ cores: 8, totalBytes: 16 * GiB, freeBytes: 8 * GiB, cpuLoad: 0.1 }),
  } })
  try {
    const first = await pool.run({ action: 'warmup' })
    const parse = () => pool.run({ action: 'parse', fileName: 'scan.pdf', outputPath: path.join(directory, 'result.json') })
    assert.equal((await parse()).pid, first.pid)
    const resident = pool.residentSlot().pool
    assert.equal(resident.measuredMemoryMB, 1024, '保留模型以复用连续任务')
    const later = Date.now() + 16_000
    t.mock.method(Date, 'now', () => later)
    for (let attempt = 0; attempt < 25 && resident.measuredMemoryMB === 1024; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.equal(resident.measuredMemoryMB, 128, '空闲后应释放文档模型')
    assert.equal((await parse()).pid, first.pid, '释放模型后常驻进程仍可解析')
  } finally { await pool.close() }
})

test('常驻 CPU worker 异常退出后，在没有解析请求时重新预热', async t => {
  const GiB = 1024 ** 3
  const pool = new HttpWorkerPool({ ...options, desktopResources: {
    keepWarm: true, intervalMs: 20,
    sample: () => ({ cores: 8, totalBytes: 16 * GiB, freeBytes: 8 * GiB, cpuLoad: 0.1 }),
  } })
  try {
    const first = await pool.run({ action: 'warmup' })
    const run = t.mock.method(pool, 'run')
    process.kill(first.pid)
    for (let attempt = 0; attempt < 100 && !run.mock.callCount(); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.equal(run.mock.calls[0]?.arguments[0].action, 'warmup')
    const replacement = await run.mock.calls[0].result
    assert.notEqual(replacement.pid, first.pid)
    assert.equal((await pool.run({ action: 'resource-test', fileName: 'material.txt' })).pid, replacement.pid)
  } finally { await pool.close() }
})

test('扫描 PDF 获得高于低内存预热配置的预算', async () => {
  const GiB = 1024 ** 3
  const pool = new HttpWorkerPool({ ...options, desktopResources: {
    keepWarm: true, sample: () => ({ cores: 8, totalBytes: 16 * GiB, freeBytes: 3 * GiB, cpuLoad: 0.8 }),
  } })
  try {
    const warm = await pool.run({ action: 'resource-test', fileName: 'note.txt' })
    assert.equal(warm.memoryMB, 1024)
    const scan = await pool.run({ action: 'resource-test', fileName: 'scan.pdf' }, AbortSignal.timeout(2500))
    assert.ok(scan.memoryMB >= 1536, '扫描 PDF 应获得足够预算')
    assert.notEqual(scan.pid, warm.pid)
  } finally { await pool.close() }
})

test('GPU worker 达到内存上限后由 CPU 重试', async () => {
  const GiB = 1024 ** 3
  const pool = new HttpWorkerPool({ ...options, desktopResources: {
    gpu: true, sample: () => ({ cores: 8, totalBytes: 16 * GiB, freeBytes: 8 * GiB, cpuLoad: 0.2 }),
  } })
  try {
    const parsed = await pool.run({ action: 'resource-test', fileName: 'scan.pdf', gpuMemoryLimit: true })
    assert.equal(parsed.device, 'cpu')
  } finally { await pool.close() }
})

test('CPU 繁忙时下调线程预算，GPU 忙时将视觉任务交给 CPU', async () => {
  const GiB = 1024 ** 3
  let cpuLoad = 0.1
  let freeBytes = 8 * GiB
  const pool = new HttpWorkerPool({ ...options, size: 2, desktopResources: {
    gpu: true, sample: () => ({ cores: 8, totalBytes: 16 * GiB, freeBytes, cpuLoad }),
  } })
  try {
    const fast = await pool.run({ action: 'resource-test', fileName: 'plain.txt' })
    assert.equal(fast.device, 'cpu')
    assert.ok(fast.threads > 1 && fast.threads <= 4)
    cpuLoad = 0.95
    freeBytes = 4 * GiB
    const reduced = await pool.run({ action: 'resource-test', fileName: 'plain.txt' })
    assert.equal(reduced.threads, 1)
    assert.ok(reduced.memoryMB < fast.memoryMB)
    freeBytes = 8 * GiB
    const fallback = await pool.run({ action: 'resource-test', fileName: 'image.png', gpuBusy: true })
    assert.equal(fallback.device, 'cpu')
    const next = await pool.run({ action: 'resource-test', fileName: 'next.pdf' })
    assert.equal(next.device, 'cpu')
    assert.equal(next.pid, fallback.pid, '切换后继续复用 CPU 进程')
    await assert.rejects(pool.run({ action: 'resource-test', memoryLimit: true }), { code: 'PARSER_MEMORY_LIMIT' })
    const recovered = await pool.run({ action: 'resource-test' })
    assert.notEqual(recovered.pid, fallback.pid)
  } finally { await pool.close() }
})

test('资源充足时视觉任务可运行在 GPU worker，纯文本使用 CPU', async () => {
  const GiB = 1024 ** 3
  const pool = new HttpWorkerPool({ ...options, size: 2, desktopResources: {
    gpu: true, sample: () => ({ cores: 16, totalBytes: 32 * GiB, freeBytes: 20 * GiB, cpuLoad: 0.1 }),
  } })
  try {
    const image = await pool.run({ action: 'resource-test', fileName: 'image.png' })
    assert.equal(image.device, 'auto')
    assert.ok(image.threads <= 2)
    assert.equal((await pool.run({ action: 'resource-test', fileName: 'plain.txt' })).device, 'cpu')
  } finally { await pool.close() }
})
