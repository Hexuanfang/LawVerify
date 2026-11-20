import { mkdtemp, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createParserTestClient } from './parser-test-client.mjs'
import { createParserFixtures } from './parser-test-fixtures.mjs'

const root = path.resolve(import.meta.dirname, '../..')
const { parseFile } = createParserTestClient()
const samples = createParserFixtures()
const directory = await mkdtemp(path.join(root, 'tmp/mineru-benchmark-'))
const inputs = ['scan.pdf', 'mixed.pdf', 'table.pdf', 'scan.pdf', 'mixed.pdf', 'table.pdf', 'scan.pdf', 'mixed.pdf']
const runs = []

await parseFile(path.join(samples, 'text.pdf'))
for (const concurrency of [1, 2]) {
  const start = performance.now()
  const events = []
  let next = 0
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < inputs.length) {
      const index = next++
      const name = inputs[index]
      const result = await parseFile(path.join(samples, name))
      if (!result.text.includes('123456.78')) throw new Error(`样本未正确识别 ${name}`)
      events[index] = { index, fileName: name, elapsedSeconds: (performance.now() - start) / 1000 }
    }
  }))
  const run = { clientConcurrency: concurrency, files: inputs.length, seconds: (performance.now() - start) / 1000, events }
  runs.push(run)
  console.log(JSON.stringify(run))
}
const result = { directory, inputs, runs, throughputRatio: runs[0].seconds / runs[1].seconds,
  caveats: ['单次测量', 'HTTP 耗时含鉴权、上传和下载', '客户端并发数由测试控制，服务端调度由实例配置决定'] }
await writeFile(path.join(directory, 'benchmark.json'), JSON.stringify(result, null, 2))
console.log(`报告 ${path.join(directory, 'benchmark.json')}`)
