const assert = require('node:assert/strict')
const { EventEmitter, once } = require('node:events')
const { test } = require('node:test')
const { ServiceSupervisor } = require('./service-supervisor.cjs')

function fixture(options = {}) {
  const children = []
  const supervisor = new ServiceSupervisor({
    entry: 'desktop-service.cjs', env: { PORT: '18787' },
    restartDelays: [1, 1, 1], readyTimeoutMs: 1000,
    fork(_entry, _args, configuration) {
      const child = new EventEmitter()
      child.configuration = configuration
      child.kill = () => { setImmediate(() => child.emit('exit', 1)); return true }
      children.push(child)
      setImmediate(() => child.emit('message', { type: 'ready' }))
      return child
    },
    ...options,
  })
  return { supervisor, children }
}

function state(supervisor, target) {
  return new Promise(resolve => {
    const listener = status => {
      if (status.state === target) { supervisor.off('status', listener); resolve() }
    }
    supervisor.on('status', listener)
  })
}

test('starts once for concurrent callers and does not reset the origin', async t => {
  const { supervisor, children } = fixture()
  t.after(() => supervisor.stop())
  await Promise.all([supervisor.start(), supervisor.start()])
  assert.equal(children.length, 1)
  const ready = state(supervisor, 'ready')
  children[0].emit('exit', 9)
  await ready
  assert.equal(children.length, 2)
  assert.equal(children[0].configuration.env.PORT, children[1].configuration.env.PORT)
  assert.equal(children[1].configuration.stdio, 'ignore')
})

test('stops after three automatic recoveries', async t => {
  const { supervisor, children } = fixture()
  t.after(() => supervisor.stop())
  await supervisor.start()
  for (let index = 0; index < 3; index++) {
    const ready = state(supervisor, 'ready')
    children[index].emit('exit', 1)
    await ready
  }
  const failed = state(supervisor, 'failed')
  children[3].emit('exit', 1)
  await failed
  assert.equal(children.length, 4)
  assert.equal(supervisor.state, 'failed')
})

test('startup failure retries without rejecting the overall readiness wait', async t => {
  let attempts = 0
  const { supervisor } = fixture({
    fork() {
      const child = new EventEmitter()
      child.kill = () => child.emit('exit', 1)
      setImmediate(() => {
        if (++attempts === 1) child.emit('exit', 1)
        else child.emit('message', { type: 'ready' })
      })
      return child
    },
  })
  t.after(() => supervisor.stop())
  await supervisor.waitUntilReady()
  assert.equal(attempts, 2)
})

test('readiness timeout terminates a hung child and respects retry budget', async t => {
  let killed = 0
  const { supervisor } = fixture({
    readyTimeoutMs: 10, restartDelays: [],
    fork() {
      const child = new EventEmitter()
      child.kill = () => { killed++; child.emit('exit', 1) }
      return child
    },
  })
  t.after(() => supervisor.stop())
  await assert.rejects(supervisor.waitUntilReady())
  assert.equal(killed, 1)
})

test('shutdown cancels a pending restart', async () => {
  const { supervisor, children } = fixture({ restartDelays: [1000] })
  await supervisor.start()
  const diagnostic = once(supervisor, 'diagnostic')
  children[0].emit('exit', 1)
  await diagnostic
  supervisor.stop()
  assert.equal(supervisor.state, 'stopped')
  assert.equal(supervisor.child, null)
  await assert.rejects(supervisor.start())
  assert.equal(children.length, 1)
})

test('a living but unresponsive service is terminated without an infinite retry', async t => {
  const { supervisor, children } = fixture({ pingIntervalMs: 5, pingTimeoutMs: 10, restartDelays: [] })
  t.after(() => supervisor.stop())
  await supervisor.start()
  const failed = state(supervisor, 'failed')
  await failed
  assert.equal(supervisor.child, null)
  assert.equal(children.length, 1)
})
