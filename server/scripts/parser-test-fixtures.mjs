import { copyFileSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const project = path.resolve(import.meta.dirname, '../..')

export function fixturePython() {
  const bundled = path.join(project, 'app/.desktop/parser/python-runtime', process.platform === 'win32' ? 'python.exe' : 'bin/python3')
  return process.env.LAWVERIFY_TEST_PYTHON || (existsSync(bundled) ? bundled : undefined)
}

export function useParserWorkerFixture(env, directory) {
  const python = fixturePython()
  if (!python) throw new Error('请设置 LAWVERIFY_TEST_PYTHON 或先准备桌面解析资源')
  const workers = path.join(directory, 'python-workers')
  mkdirSync(workers, { recursive: true })
  copyFileSync(path.join(import.meta.dirname, 'fixtures/python-worker.py'), path.join(workers, 'worker.py'))
  for (const name of ['http-worker-pool.mjs', 'desktop-resources.mjs', 'python-workers.ts']) {
    copyFileSync(path.join(project, 'python-workers', name), path.join(workers, name))
  }
  Object.assign(env, { APP_RUNTIME_ROOT: path.join(directory, 'server'), LAWVERIFY_PYTHON: python, PARSER_BUNDLE_ROOT: undefined })
}

export function createParserFixtures(python = process.env.LAWVERIFY_TEST_PYTHON) {
  if (process.env.PARSER_TEST_SAMPLES) return path.resolve(process.env.PARSER_TEST_SAMPLES)
  if (!python) throw new Error('请设置 PARSER_TEST_SAMPLES，或用 LAWVERIFY_TEST_PYTHON 指定生成合成样本的 Python')
  const directory = mkdtempSync(path.join(project, 'tmp/parser-fixtures-'))
  const result = spawnSync(python, [path.join(project, 'server/scripts/fixtures/create-parser-samples.py')], {
    env: { ...process.env, PARSER_FIXTURE_DIR: directory, PYTHONUTF8: '1' }, encoding: 'utf8', windowsHide: true,
  })
  if (result.status !== 0) throw new Error(`测试样本生成失败 ${result.stderr || result.error}`)
  return path.join(directory, 'samples')
}
