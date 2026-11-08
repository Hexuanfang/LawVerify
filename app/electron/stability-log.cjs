const fs = require('node:fs/promises')
const path = require('node:path')

function createStabilityLog(directory) {
  let tail = Promise.resolve()
  let queued = 0
  const file = path.join(directory, 'stability.jsonl')
  return (event, details = {}) => {
    if (queued >= 64) return
    const record = { time: new Date().toISOString(), event: String(event).replace(/[^a-z0-9-]/gi, '').slice(0, 64) }
    for (const key of ['code', 'reason', 'duration', 'count', 'rssMB', 'version']) {
      const value = details[key]
      if (typeof value === 'number' && Number.isFinite(value)) record[key] = value
      else if (typeof value === 'string' && /^[a-z0-9_.-]{1,64}$/i.test(value)) record[key] = value
    }
    // 服务端的输出片段：只保留末尾若干字符，避免日志文件被单条输出撑爆。
    if (typeof details.text === 'string' && details.text.trim()) {
      record.text = details.text.replace(/\s+/g, ' ').trim().slice(0, 500)
    }
    queued++
    tail = tail.then(async () => {
      await fs.mkdir(directory, { recursive: true })
      const size = await fs.stat(file).then(stat => stat.size, () => 0)
      if (size > 1024 * 1024) {
        await fs.rm(`${file}.1`, { force: true })
        await fs.rename(file, `${file}.1`)
      }
      await fs.appendFile(file, `${JSON.stringify(record)}\n`, 'utf8')
    }).catch(() => {}).finally(() => { queued-- })
  }
}

module.exports = { createStabilityLog }
