const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { setTimeout: sleep } = require('node:timers/promises')

const transient = /NSURLErrorDomain Code=-(?:1001|1003|1004|1005|1006|1009)\b|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|network connection was lost|timed out|HTTP status code: (?:429|5\d\d)/i
const submissionId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function client({ env = process.env, execute = spawnSync } = {}) {
  const names = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']
  for (const name of names) {
    if (!env[name]?.trim()) throw new Error(`Mac notarization requires ${name}.`)
  }
  const redact = value => names.reduce((text, name) => text.split(env[name]).join('[redacted]'), String(value))
  const auth = ['--apple-id', env.APPLE_ID, '--password', env.APPLE_APP_SPECIFIC_PASSWORD, '--team-id', env.APPLE_TEAM_ID]
  return function request(args, timeout = 120_000) {
    const format = args[0] === 'log' ? [] : ['--output-format', 'json']
    const result = execute('xcrun', ['notarytool', ...args, ...auth, ...format], {
      env, encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024,
    })
    if (result.error || result.status !== 0) {
      const detail = redact(result.stderr || result.stdout || result.error?.message || 'Unknown error')
      const error = new Error(`Apple notarytool ${args[0]} failed: ${detail}`)
      error.transient = transient.test(detail) || transient.test(result.error?.code || '')
      throw error
    }
    try {
      return JSON.parse(result.stdout)
    } catch {
      throw new Error(`Apple notarytool ${args[0]} returned invalid JSON: ${redact(result.stdout)}`)
    }
  }
}

async function fileHash(file) {
  const hash = createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

async function retryRead(request, args, { delay = sleep, log = console.log } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return request(args)
    } catch (error) {
      if (!error.transient || attempt === 3) throw error
      log(`Apple status service network failure; retry ${attempt + 1}/3.`)
      await delay(5_000 * 2 ** attempt)
    }
  }
}

async function checkCredentials(options = {}) {
  await retryRead(client(options), ['history'], options)
  ;(options.log || console.log)('Apple notarization credentials verified.')
}

async function notarizeFile(file, options = {}) {
  const { delay = sleep, log = console.log, now = Date.now, waitMs = 120 * 60_000, pollMs = 60_000 } = options
  if (!Number.isFinite(waitMs) || waitMs <= 0 || !Number.isFinite(pollMs) || pollMs <= 0) {
    throw new Error('Notarization wait and poll intervals must be positive.')
  }
  const request = client(options)
  const stateFile = `${file}.notary.json`
  const sha256 = await fileHash(file)
  let state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : null
  const save = () => {
    const temporary = `${stateFile}.tmp`
    fs.writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n')
    fs.renameSync(temporary, stateFile)
  }
  if (state) {
    if (state.fileName !== path.basename(file)) {
      throw new Error(`Recovery file name does not match ${stateFile}.`)
    }
    if (state.sha256 !== sha256) {
      // Stapling changes a DMG's bytes. Only Apple's ticket validation can authorize reuse.
      if (state.status === 'Accepted' && submissionId.test(state.id || '') && options.validateAccepted) {
        await options.validateAccepted()
        log(`Apple ticket validated for previously accepted submission ${state.id}.`)
        return state
      }
      throw new Error(`Notarization payload changed. Restore the original file for ${stateFile}; do not reuse its submission.`)
    }
    if (!submissionId.test(state.id || '')) {
      throw new Error(`Previous upload has no submission ID. Query notarytool history before resubmitting ${path.basename(file)}.`)
    }
    log(`Resuming Apple submission ${state.id} for ${state.fileName}.`)
  } else {
    state = { fileName: path.basename(file), sha256, status: 'Uploading', startedAt: new Date(now()).toISOString() }
    save()
    log(`Uploading ${state.fileName} to Apple (upload timeout: 20 minutes).`)
    // Never blindly retry submit: Apple may have received an upload whose response was lost.
    try {
      const submitted = request(['submit', file], 20 * 60_000)
      if (!submissionId.test(submitted.id || '')) throw new Error('Apple returned no valid submission ID.')
      state.id = submitted.id
      state.status = submitted.status || 'In Progress'
      save()
    } catch (error) {
      state.lastError = error.message
      save()
      throw new Error(`${error.message} Upload state saved to ${stateFile}; query Apple history before any resubmission.`)
    }
    log(`Apple submission ID: ${state.id}. State saved to ${stateFile}.`)
  }
  const deadline = now() + waitMs
  for (;;) {
    const info = await retryRead(request, ['info', state.id], { delay, log })
    if (info.id !== state.id || !['In Progress', 'Accepted', 'Invalid', 'Rejected'].includes(info.status)) {
      throw new Error(`Unexpected Apple status response for submission ${state.id}.`)
    }
    state.status = info.status
    state.checkedAt = new Date(now()).toISOString()
    delete state.lastError
    save()
    log(`Apple submission ${state.id}: ${state.status}.`)
    if (state.status === 'Accepted') return state
    if (state.status !== 'In Progress') {
      const diagnosticsFile = `${file}.notary-log.json`
      try {
        const diagnostics = await retryRead(request, ['log', state.id], { delay, log })
        const env = options.env || process.env
        const sanitized = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'].reduce(
          (text, name) => text.split(env[name]).join('[redacted]'), JSON.stringify(diagnostics, null, 2))
        fs.writeFileSync(diagnosticsFile, sanitized + '\n')
      } catch (error) {
        log(`Could not retrieve Apple diagnostics: ${error.message}`)
      }
      throw new Error(`Apple ${state.status} submission ${state.id}. Check ${diagnosticsFile}; this is not a queue timeout.`)
    }
    const remaining = deadline - now()
    if (remaining <= 0) {
      state.lastError = 'Local wait budget exhausted; Apple submission is still In Progress.'
      save()
      throw new Error(`Apple submission ${state.id} is still In Progress after ${waitMs / 60_000} minutes. Resume from the saved recovery artifact; do not rebuild or resubmit.`)
    }
    await delay(Math.min(pollMs, remaining))
  }
}

module.exports = { checkCredentials, notarizeFile, fileHash }
