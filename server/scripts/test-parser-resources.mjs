import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { ensureParserResources, downloadedParserRoot } from '../src/infrastructure/parser-resources.ts'

const project = path.resolve(import.meta.dirname, '../..')

async function fixture() {
  const root = await mkdtemp(path.join(project, 'tmp/parser-resources-'))
  const runtime = path.join(root, 'runtime')
  const source = path.join(root, 'source')
  const cache = path.join(root, 'cache')
  await mkdir(runtime, { recursive: true })
  await mkdir(path.join(source, 'python-runtime'), { recursive: true })
  await mkdir(path.join(source, 'mineru-home/models/MinerU-4_models_onnx'), { recursive: true })
  await writeFile(path.join(source, 'python-runtime/python.exe'), 'python fixture')
  await writeFile(path.join(source, 'mineru-home/models/MinerU-4_models_onnx/model.onnx'), 'model fixture')
  await writeFile(path.join(source, 'python-runtime/lawverify-runtime.json'), JSON.stringify({ platform: process.platform, architecture: process.arch, engineVersion: '4.2.2' }))
  const archive = path.join(root, 'resource.tar.gz')
  execFileSync('tar.exe', ['-czf', archive, '-C', source, 'python-runtime', 'mineru-home'])
  const data = await readFile(archive)
  const manifest = {
    schemaVersion: 1, platform: process.platform, arch: process.arch, engineVersion: '4.2.2',
    size: data.length, sha256: createHash('sha256').update(data).digest('hex'),
    url: 'https://lawverify.zhijing.fun/api/web/parser-resources/fixture.tar.gz',
  }
  await writeFile(path.join(runtime, 'parser-resource.json'), JSON.stringify(manifest))
  return { root, runtime, source, cache, data, manifest }
}

test('首次下载和校验后启用，同进程并发共享初始化，缓存可复用', async () => {
  const f = await fixture()
  let requests = 0
  const options = { fetch: async () => { requests++; return new Response(f.data) } }
  const results = await Promise.all(Array.from({ length: 5 }, () => ensureParserResources(f.runtime, f.cache, options)))
  assert.equal(requests, 1)
  assert.ok(results.every(result => result === results[0]))
  assert.equal(await readFile(path.join(results[0], 'python-runtime/python.exe'), 'utf8'), 'python fixture')
  assert.equal(downloadedParserRoot(f.runtime, f.cache), results[0])
  await ensureParserResources(f.runtime, f.cache, { fetch: () => { throw new Error('缓存命中时不得下载') } })
})

test('SHA256 错误不得启用，下一次调用可以重新下载', async () => {
  const f = await fixture()
  const bad = Buffer.from(f.data)
  bad[0] ^= 1
  await assert.rejects(ensureParserResources(f.runtime, f.cache, { fetch: async () => new Response(bad) }), /校验/)
  assert.equal(downloadedParserRoot(f.runtime, f.cache), undefined)
  const target = await ensureParserResources(f.runtime, f.cache, { fetch: async () => new Response(f.data) })
  assert.ok((await stat(path.join(target, 'python-runtime/python.exe'))).isFile())
})

test('下载失败和超长响应不会形成就绪缓存', async () => {
  const f = await fixture()
  await assert.rejects(ensureParserResources(f.runtime, f.cache, { fetch: async () => new Response('missing', { status: 404 }) }), /404/)
  await assert.rejects(ensureParserResources(f.runtime, f.cache, { fetch: async () => new Response(Buffer.concat([f.data, f.data])) }), /大小|长度/)
  assert.equal(downloadedParserRoot(f.runtime, f.cache), undefined)
})

test('无清单的旧离线环境无需下载，拒绝不匹配的架构及非法清单', async () => {
  const f = await fixture()
  await writeFile(path.join(f.runtime, 'parser-resource.json'), JSON.stringify({ ...f.manifest, arch: 'wrong' }))
  await assert.rejects(ensureParserResources(f.runtime, f.cache), /架构|平台/)
  await writeFile(path.join(f.runtime, 'parser-resource.json'), JSON.stringify({ ...f.manifest, sha256: '../escape' }))
  await assert.rejects(ensureParserResources(f.runtime, f.cache), /清单/)
  const legacy = path.join(f.root, 'legacy')
  await mkdir(legacy)
  assert.equal(await ensureParserResources(legacy, f.cache), undefined)
})

test('归档包含清单以外的目录时拒绝解压', async () => {
  const f = await fixture()
  await writeFile(path.join(f.source, 'unexpected.txt'), 'unexpected')
  const archive = path.join(f.root, 'invalid.tar.gz')
  execFileSync('tar.exe', ['-czf', archive, '-C', f.source, 'unexpected.txt'])
  const data = await readFile(archive)
  await writeFile(path.join(f.runtime, 'parser-resource.json'), JSON.stringify({
    ...f.manifest, size: data.length, sha256: createHash('sha256').update(data).digest('hex'),
  }))
  await assert.rejects(ensureParserResources(f.runtime, f.cache, { fetch: async () => new Response(data) }), /路径/)
  assert.equal(downloadedParserRoot(f.runtime, f.cache), undefined)
})

test('截断或超时下载不会启用缓存，损坏的已安装环境可以重新获取', async () => {
  const f = await fixture()
  await assert.rejects(ensureParserResources(f.runtime, f.cache, { fetch: async () => new Response(f.data.subarray(0, 10)) }), /校验/)
  await assert.rejects(ensureParserResources(f.runtime, f.cache, {
    fetch: async () => new Response(new ReadableStream({ start() {} })), totalTimeoutMs: 50,
  }), /超时/)
  const target = await ensureParserResources(f.runtime, f.cache, { fetch: async () => new Response(f.data) })
  await unlink(path.join(target, 'python-runtime/python.exe'))
  assert.equal(downloadedParserRoot(f.runtime, f.cache), undefined)
  const repaired = await ensureParserResources(f.runtime, f.cache, { fetch: async () => new Response(f.data) })
  assert.equal(downloadedParserRoot(f.runtime, f.cache), repaired)
  await writeFile(path.join(repaired, 'mineru-home/models/MinerU-4_models_onnx/model.onnx'), 'bad')
  const repairedModel = await ensureParserResources(f.runtime, f.cache, { fetch: async () => new Response(f.data) })
  assert.equal(await readFile(path.join(repairedModel, 'mineru-home/models/MinerU-4_models_onnx/model.onnx'), 'utf8'), 'model fixture')
})

test('多个进程修复同一缓存时通过独立目录安全发布', async () => {
  const f = await fixture()
  const target = path.join(f.cache, f.manifest.sha256.slice(0, 24))
  await mkdir(target, { recursive: true })
  const module = pathToFileURL(path.resolve(import.meta.dirname, '../src/infrastructure/parser-resources.ts')).href
  const code = `import {readFile} from 'node:fs/promises';
    import {ensureParserResources} from ${JSON.stringify(module)};
    const data=await readFile(${JSON.stringify(path.join(f.root, 'resource.tar.gz'))});
    await ensureParserResources(${JSON.stringify(f.runtime)},${JSON.stringify(f.cache)},{fetch:async()=>new Response(data)});`
  await Promise.all(Array.from({ length: 3 }, () => promisify(execFile)(process.execPath,
    ['--experimental-strip-types', '--input-type=module', '-e', code], { windowsHide: true, timeout: 30000 })))
  const active = downloadedParserRoot(f.runtime, f.cache)
  assert.equal(path.dirname(active), target)
  assert.equal(await readFile(path.join(active, 'python-runtime/python.exe'), 'utf8'), 'python fixture')
})
