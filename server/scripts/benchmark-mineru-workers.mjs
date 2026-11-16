import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { PythonWorkerPool } from '../src/infrastructure/python-workers.ts'
import { createParserFixtures } from './parser-test-fixtures.mjs'

const root = path.resolve(import.meta.dirname, '../..')
const directory = await mkdtemp(path.join(root, 'tmp/mineru-benchmark-'))
const python = process.env.LAWVERIFY_TEST_PYTHON || path.join(root, 'server/python/.runtime', ...(process.platform === 'win32' ? ['python.exe'] : ['bin/python3']))
const samples = createParserFixtures(python)
const modelHome = path.join(root, 'server/python/.models')
const inputs = ['scan.pdf', 'mixed.pdf', 'table.pdf', 'scan.pdf', 'mixed.pdf', 'table.pdf', 'scan.pdf', 'mixed.pdf']
const outcomes = []

function memory(pids) {
  if (process.platform !== 'win32') return null
  const ids = [...new Set(pids)].filter(Number.isInteger).join(',')
  try {
    const text = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      `Get-Process -Id ${ids} | Select-Object Id,WorkingSet64 | ConvertTo-Json -Compress`], { encoding: 'utf8', windowsHide: true })
    const items = JSON.parse(text)
    return (Array.isArray(items) ? items : [items]).map(item => ({ pid: item.Id, residentMB: Math.round(item.WorkingSet64 / 1024 ** 2) }))
  } catch { return null }
}

for (const size of [1, 2]) {
  const pool = new PythonWorkerPool({ python, script: path.join(root, 'server/python/worker.py'), size,
    workerEnv: { LAWVERIFY_PARSER_ROOT: directory, LAWVERIFY_MINERU_HOME: modelHome, MINERU_MODEL_ONNX_DEVICE: 'cpu' } })
  try {
    const warmStart = performance.now()
    const warm = await Promise.all(Array.from({ length: size }, (_, i) => pool.run({ action: 'parse',
      inputPath: path.join(samples, 'text.pdf'), outputPath: path.join(directory, `warm-${size}-${i}.json`) })))
    const warmupSeconds = (performance.now() - warmStart) / 1000
    const start = performance.now()
    const events = []
    const values = await Promise.all(inputs.map(async (name, index) => {
      const parsed = await pool.run({ action: 'parse', inputPath: path.join(samples, name),
        outputPath: path.join(directory, `result-${size}-${index}.json`) })
      const result = JSON.parse(await readFile(parsed.outputPath, 'utf8'))
      if (!result.text.includes('123456.78')) throw new Error(`样本未正确识别 ${name}`)
      events.push({ index, elapsedSeconds: (performance.now() - start) / 1000, pid: parsed.pid })
      return parsed
    }))
    const item = { workers: size, files: inputs.length, warmupSeconds, seconds: (performance.now() - start) / 1000,
      distinctPids: [...new Set(values.map(value => value.pid))], memorySamples: memory(warm.map(value => value.pid)), events }
    outcomes.push(item)
    console.log(JSON.stringify(item))
  } finally { await pool.close() }
}
const result = { directory, inputs, runs: outcomes, throughputRatio: outcomes[0].seconds / outcomes[1].seconds,
  caveats: ['单次测量', '预热后吞吐', '内存只采样主解析进程，非峰值且未包含渲染子进程'] }
await writeFile(path.join(directory, 'benchmark.json'), JSON.stringify(result, null, 2))
console.log(`报告 ${path.join(directory, 'benchmark.json')}`)
