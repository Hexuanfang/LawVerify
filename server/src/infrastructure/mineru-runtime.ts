import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { env } from '../config/env.js'
import { getWorkspaceDataDir, getRuntimeRoot } from '../config/paths.js'
import { PythonWorkerPool } from './python-workers.js'

let pool: PythonWorkerPool | undefined

export function parserRoot() {
  return path.join(getWorkspaceDataDir(), 'parsing')
}

function unpacked(value: string) {
  return value.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2')
}

export function getMineruPool() {
  if (pool) return pool
  const serverRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
  const script = [path.join(getRuntimeRoot(), 'python', 'worker.py'), path.join(serverRoot, 'python', 'worker.py')]
    .map(unpacked).find(existsSync)
  const executable = process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python3']
  const python = env.LAWVERIFY_PYTHON?.trim() || [
    path.join(getRuntimeRoot(), 'python-runtime', ...(process.platform === 'win32' ? ['python.exe'] : ['bin', 'python3'])),
    path.join(serverRoot, 'python', '.runtime', ...(process.platform === 'win32' ? ['python.exe'] : ['bin', 'python3'])),
    path.join(serverRoot, 'python', '.venv', ...executable),
  ].map(unpacked).find(existsSync)
  if (!python || !script) {
    throw Object.assign(new Error('本机解析环境尚未就绪，请配置 LAWVERIFY_PYTHON 和 MinerU 模型后重试，或人工录入正文并审核。'),
      { code: 'PARSER_NOT_CONFIGURED' })
  }
  pool = new PythonWorkerPool({ python, script, size: env.PARSER_WORKERS || undefined,
    taskTimeoutMs: env.PARSER_TIMEOUT_MS,
    workerEnv: { LAWVERIFY_PARSER_ROOT: parserRoot(), LAWVERIFY_MINERU_HOME: env.LAWVERIFY_MINERU_HOME ||
      [path.join(getRuntimeRoot(), 'mineru-home'), path.join(serverRoot, 'python', '.models')].map(unpacked).find(existsSync) || path.join(parserRoot(), 'mineru'),
      MINERU_MODEL_ONNX_DEVICE: env.PARSER_DEVICE, LAWVERIFY_PARSER_BUNDLED: process.env.LAWVERIFY_DESKTOP === '1' ? '1' : '0' },
  })
  return pool
}
