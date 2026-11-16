import { mkdtempSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

export function createParserFixtures(python) {
  const project = path.resolve(import.meta.dirname, '../..')
  const directory = mkdtempSync(path.join(project, 'tmp/parser-fixtures-'))
  const result = spawnSync(python, [path.join(project, 'server/scripts/fixtures/create-parser-samples.py')], {
    env: { ...process.env, PARSER_FIXTURE_DIR: directory, PYTHONUTF8: '1' }, encoding: 'utf8', windowsHide: true,
  })
  if (result.status !== 0) throw new Error(`测试样本生成失败 ${result.stderr || result.error}`)
  return path.join(directory, 'samples')
}
