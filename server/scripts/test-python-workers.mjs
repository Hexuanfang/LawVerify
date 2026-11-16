import assert from 'node:assert/strict'
import { test } from 'node:test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PythonWorkerPool } from '../src/infrastructure/python-workers.ts'

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
