const fs = require('node:fs')
const path = require('node:path')

function prepareParserResources(serverRoot, targetRoot, options = {}) {
  const runtime = options.runtime || process.env.LAWVERIFY_PARSER_RUNTIME_SOURCE || path.join(serverRoot, 'python', '.runtime')
  const models = options.models || process.env.LAWVERIFY_PARSER_MODELS_SOURCE || path.join(serverRoot, 'python', '.models')
  const executable = process.platform === 'win32' ? 'python.exe' : 'bin/python3'
  if (!fs.existsSync(path.join(runtime, executable)) || fs.existsSync(path.join(runtime, 'pyvenv.cfg'))) {
    throw new Error('缺少可搬移的 Python 解析运行环境，请先运行 server/scripts/prepare-parser-runtime.py。')
  }
  if (!fs.existsSync(path.join(models, 'models', 'MinerU-4_models_onnx'))) {
    throw new Error('缺少 MinerU ONNX 模型，请准备对应平台的解析资源。')
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(runtime, 'lawverify-runtime.json'), 'utf8'))
  if (manifest.platform !== process.platform) throw new Error('Python 解析运行环境与构建平台不匹配。')
  const normalizedArch = value => ({ AMD64: 'x64', x86_64: 'x64', aarch64: 'arm64' }[value] || value)
  const targetArch = options.arch || process.env.LAWVERIFY_PARSER_TARGET_ARCH || process.arch
  if (normalizedArch(manifest.architecture) !== normalizedArch(targetArch)) throw new Error('Python 解析运行环境与目标架构不匹配，请按架构分别构建。')
  fs.cpSync(path.join(serverRoot, 'python'), path.join(targetRoot, 'python'), {
    recursive: true, filter: source => !['.runtime', '.models', '.venv', '__pycache__'].includes(path.basename(source)),
  })
  fs.cpSync(runtime, path.join(targetRoot, 'python-runtime'), { recursive: true })
  fs.cpSync(models, path.join(targetRoot, 'mineru-home'), { recursive: true })
}

module.exports = { prepareParserResources }
