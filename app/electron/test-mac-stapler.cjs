const test = require('node:test')
const assert = require('node:assert/strict')
const { runStapler } = require('./verify-mac-stapler.cjs')

function harness(results) {
  const calls = []
  const waits = []
  const warnings = []
  return {
    calls, waits, warnings,
    options: {
      execute(command, args, options) {
        calls.push({ command, args, options })
        return results[Math.min(calls.length - 1, results.length - 1)]
      },
      delay: async ms => { waits.push(ms) },
      warn: message => { warnings.push(message) },
    },
  }
}

test('valid tickets pass without retrying and use bounded subprocess timeouts', async () => {
  const h = harness([{ status: 0, stdout: 'The validate action worked!', stderr: '' }])
  assert.equal(await runStapler('validate', '/app/LawVerify.app', h.options), 'The validate action worked!')
  assert.deepEqual(h.calls[0].args, ['stapler', 'validate', '/app/LawVerify.app'])
  assert.equal(h.calls[0].options.timeout, 120_000)
  assert.deepEqual(h.waits, [])
})

test('CloudKit connection loss retries and still requires successful validation', async () => {
  const h = harness([
    { status: 68, stderr: 'Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost."' },
    { status: 0, stdout: 'Validated' },
  ])
  assert.equal(await runStapler('validate', '/app/LawVerify.app', h.options), 'Validated')
  assert.equal(h.calls.length, 2)
  assert.deepEqual(h.waits, [5_000])
})

test('repeated network failures stop after three retries', async () => {
  const h = harness([{ status: 68, stderr: 'NSURLErrorDomain Code=-1005' }])
  await assert.rejects(runStapler('staple', '/app/installer.dmg', h.options), /stapler staple failed/)
  assert.equal(h.calls.length, 4)
  assert.deepEqual(h.waits, [5_000, 10_000, 20_000])
})

test('invalid or absent tickets and credentials never trigger retries', async () => {
  for (const stderr of [
    'The validate action failed! Error 68. Ticket invalid.',
    'Could not validate ticket for /app/LawVerify.app',
    'HTTP status code: 401. Invalid credentials.',
    'The signature is invalid.',
  ]) {
    const h = harness([{ status: 68, stderr }])
    await assert.rejects(runStapler('validate', '/app/LawVerify.app', h.options))
    assert.equal(h.calls.length, 1)
    assert.deepEqual(h.waits, [])
  }
})

test('a network retry does not mask subsequent invalid-ticket failures', async () => {
  const h = harness([
    { status: 68, stderr: 'NSURLErrorDomain Code=-1005' },
    { status: 68, stderr: 'Ticket invalid' },
  ])
  await assert.rejects(runStapler('validate', '/app/LawVerify.app', h.options), /Ticket invalid/)
  assert.equal(h.calls.length, 2)
})

test('missing tools fail immediately and unsupported actions never execute', async () => {
  const h = harness([{ status: null, error: Object.assign(new Error('xcrun not found'), { code: 'ENOENT' }) }])
  await assert.rejects(runStapler('validate', '/app/LawVerify.app', h.options), /xcrun not found/)
  assert.equal(h.calls.length, 1)
  await assert.rejects(runStapler('submit', '/app/LawVerify.app', h.options), /Unsupported/)
  assert.equal(h.calls.length, 1)
})
