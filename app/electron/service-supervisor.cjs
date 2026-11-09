const { EventEmitter } = require('node:events')

// Keep the origin fixed across restarts so cookies, drafts and source URLs stay valid.
class ServiceSupervisor extends EventEmitter {
  constructor({ fork, entry, env, readyTimeoutMs = 30000, restartDelays = [500, 1500, 4000, 8000, 15000], restartWindowMs = 600000, pingIntervalMs = 30000, pingTimeoutMs = 60000, recoveryRetryMs = 30000 }) {
    super()
    Object.assign(this, { fork, entry, env, readyTimeoutMs, restartDelays, restartWindowMs, pingIntervalMs, pingTimeoutMs, recoveryRetryMs })
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
          env: this.env, stdio: 'pipe', serviceName: 'LawVerify Local Service',
          // 工作区里几十份材料原件解码后会占用较多内存，堆上限过低会触发频繁的
          // 完整回收，把事件循环长时间占死，表现为流式连接被中断。
          execArgv: ['--max-old-space-size=2048'],
        })
      } catch (error) {
        this.status('failed')
        reject(error)
        return
      }
      this.child = child
      // 服务端日志原先被直接丢弃，出问题时无从查起；这里转成诊断事件写进稳定性日志。
      child.stdout?.on('data', (chunk) => {
        this.emit('diagnostic', { event: 'service-stdout', text: chunk.toString() })
      })
      child.stderr?.on('data', (chunk) => {
        this.emit('diagnostic', { event: 'service-stderr', text: chunk.toString() })
      })
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
          // 重启次数用尽也不放弃：本地服务只是暂时起不来，
          // 保持低频重试，恢复后界面会自动回到可用状态，不必让用户重开应用。
          this.status('failed')
          this.timer = setTimeout(() => {
            this.timer = null
            void this.start().catch(() => {})
          }, this.recoveryRetryMs)
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
