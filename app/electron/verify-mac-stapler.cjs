const { spawnSync } = require('node:child_process')
const { setTimeout: sleep } = require('node:timers/promises')

const networkFailure = /NSURLErrorDomain Code=-(?:1001|1003|1004|1005|1006|1009)\b|\b(?:ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH)\b|network connection was lost|could not connect to (?:the )?server/i

async function runStapler(action, target, { execute = spawnSync, delay = sleep, warn = console.warn } = {}) {
  if (!['validate', 'staple'].includes(action)) throw new Error('Unsupported stapler action')
  for (let attempt = 0; attempt <= 3; attempt++) {
    const result = execute('xcrun', ['stapler', action, target], {
      env: process.env, encoding: 'utf8', timeout: 120_000,
    })
    if (!result.error && result.status === 0) return result.stdout
    const detail = result.stderr || result.stdout || result.error?.message || 'Unknown stapler failure'
    const transient = networkFailure.test(detail) || networkFailure.test(result.error?.code || '')
    if (!transient || attempt === 3) {
      throw new Error(`Apple stapler ${action} failed: ${detail}`, { cause: result.error })
    }
    warn(`Apple ticket service network error; retrying ${action} (${attempt + 1}/3).`)
    await delay(5_000 * 2 ** attempt)
  }
}

module.exports = { runStapler }
