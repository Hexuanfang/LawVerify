const { EventEmitter } = require('node:events')

// Keep the origin fixed across restarts so cookies, drafts and source URLs stay valid.
class ServiceSupervisor extends EventEmitter {
  constructor({ fork, entry, env, readyTimeoutMs = 30000, restartDelays = [500, 1500, 4000], restartWindowMs = 300000, pingIntervalMs = 30000, pingTimeoutMs = 20000 }) {
    super()
    Object.assign(this, { fork, entry, env, readyTimeoutMs, restartDelays, restartWindowMs, pingIntervalMs, pingTimeoutMs })
    this.child = null
    this.pending = null
    this.stopped = false
    this.restarts = []
    this.timer = null
    this.state = 'idle'
  }

  status(state) {
    this.state = state
    this.emit('status', { state })
  }

  waitUntilReady() {
    if (this.state === 'ready') return Promise.resolve()
    return new Promise((resolve, reject) => {
      const listener = ({ state }) => {
        if (!['ready', 'failed', 'stopped'].includes(state)) return
        this.removeListener('status', listener)
        if (state === 'ready') resolve()
        else reject(new Error('Local service unavailable'))
      }
      this.on('status', listener)
      if (this.state !== 'recovering') {
        void this.start().catch(() => {
          if (this.state === 'failed' || this.stopped) listener({ state: this.state })
        })
      }
    })
  }

  start() {
    if (this.stopped) return Promise.reject(new Error('Service stopped'))
    if (this.state === 'ready') return Promise.resolve()
    if (this.pending) return this.pending
    this.status('starting')
    this.pending = new Promise((resolve, reject) => {
      let settled = false
      let readyTimer
      let pingTimer
      let pongTimer
      const clearTimers = () => {
        clearTimeout(readyTimer)
        clearInterval(pingTimer)
        clearTimeout(pongTimer)
      }
      const fail = () => {
        if (settled) return
        settled = true
        clearTimeout(readyTimer)
        reject(new Error('Local service did not become ready'))
      }
      let child
      try {
        child = this.fork(this.entry, [], {
          env: this.env, stdio: 'ignore', serviceName: 'LawVerify Local Service',
          execArgv: ['--max-old-space-size=1024'],
        })
      } catch (error) {
        this.status('failed')
        reject(error)
        return
      }
      this.child = child
      readyTimer = setTimeout(() => {
        fail()
        child.kill()
      }, this.readyTimeoutMs)
      child.on('message', message => {
        if (this.child !== child || this.stopped) return
        if (message?.type === 'ready' && !settled) {
          settled = true
          clearTimeout(readyTimer)
          pingTimer = setInterval(() => {
            if (this.stopped || this.child !== child) { clearTimers(); return }
            if (pongTimer) return
            pongTimer = setTimeout(() => {
              this.emit('diagnostic', { event: 'service-unresponsive' })
              child.kill()
            }, this.pingTimeoutMs)
            child.postMessage?.({ type: 'ping' })
          }, this.pingIntervalMs)
          this.status('ready')
          resolve()
        }
        if (message?.type === 'pong') {
          clearTimeout(pongTimer)
          pongTimer = null
          this.emit('diagnostic', { event: 'service-memory', rssMB: message.rssMB })
        }
        if (message?.type === 'diagnostic') {
          this.emit('diagnostic', { event: message.event, code: message.code })
        }
      })
      child.on('error', () => {
        this.emit('diagnostic', { event: 'service-process-error' })
        fail()
        child.kill()
      })
      child.once('exit', code => {
        fail()
        clearTimers()
        if (this.child !== child) return
        this.child = null
        this.emit('diagnostic', { event: 'service-exit', code })
        if (this.stopped) return
        this.status('recovering')
        this.restarts = this.restarts.filter(time => Date.now() - time < this.restartWindowMs)
        if (this.restarts.length >= this.restartDelays.length) {
          this.status('failed')
          return
        }
        const delay = this.restartDelays[this.restarts.length]
        this.restarts.push(Date.now())
        this.timer = setTimeout(() => {
          this.timer = null
          void this.start().catch(() => {})
        }, delay)
      })
    }).finally(() => { this.pending = null })
    return this.pending
  }

  stop() {
    this.stopped = true
    clearTimeout(this.timer)
    const child = this.child
    this.child = null
    if (child) child.kill()
    this.status('stopped')
  }
}

module.exports = { ServiceSupervisor }
