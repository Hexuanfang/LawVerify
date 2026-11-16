import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { AUTH_CHANGED, getLoginWorkspace, handoffLoginWorkspace } from './auth-transition.ts'
import type { AppState } from './types'

const values = new Map<string, string>()
const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) }
const events = new EventTarget()
Object.defineProperty(globalThis, 'sessionStorage', { value: storage, configurable: true })
Object.defineProperty(globalThis, 'window', { value: events, configurable: true })
Object.defineProperty(globalThis, 'location', { value: new URL('http://localhost/?ui=new'), configurable: true })
let now = 100_000
const realNow = Date.now
Date.now = () => now
after(() => { Date.now = realNow })

function workspace(email: string) {
  return { user: { email }, cases: [], certificates: [], evidences: [] } as unknown as AppState
}
function session(account = 'a@test.invalid', token = 'qa-session-a') {
  storage.setItem('lawverify-login-account', account)
  storage.setItem('lawverify-auth-session', token)
}
beforeEach(() => {
  values.clear()
  getLoginWorkspace()
  location.search = '?ui=new'
  now = 100_000
  session()
})

test('登录响应直接交接到首页，事件即时触发且不持久化工作区', () => {
  const data = workspace('a@test.invalid')
  let received = 0
  const listener = () => { received++ }
  events.addEventListener(AUTH_CHANGED, listener)
  assert.equal(handoffLoginWorkspace('A@test.invalid', 'qa-session-a', data), true)
  assert.equal(received, 1)
  assert.equal(getLoginWorkspace(), data)
  assert.equal(getLoginWorkspace(), data, '初始化重复读取也应拿到相同快照')
  assert.equal(values.size, 2)
  events.removeEventListener(AUTH_CHANGED, listener)
})
test('切换账号或同账号重建会话后不能复用旧工作区', () => {
  handoffLoginWorkspace('a@test.invalid', 'qa-session-a', workspace('a@test.invalid'))
  session('b@test.invalid', 'qa-session-b')
  assert.equal(getLoginWorkspace(), null)
  session()
  handoffLoginWorkspace('a@test.invalid', 'qa-session-a', workspace('a@test.invalid'))
  session('a@test.invalid', 'qa-session-new')
  assert.equal(getLoginWorkspace(), null)
})
test('响应账号不符、退出登录或交接超时后读取真实工作区', () => {
  handoffLoginWorkspace('a@test.invalid', 'qa-session-a', workspace('b@test.invalid'))
  assert.equal(getLoginWorkspace(), null)
  handoffLoginWorkspace('a@test.invalid', 'qa-session-a', workspace('a@test.invalid'))
  values.clear()
  assert.equal(getLoginWorkspace(), null)
  session()
  handoffLoginWorkspace('a@test.invalid', 'qa-session-a', workspace('a@test.invalid'))
  now += 60_001
  assert.equal(getLoginWorkspace(), null)
})
test('旧版登录继续使用原有工作区流程', () => {
  location.search = '?ui=legacy'
  assert.equal(handoffLoginWorkspace('a@test.invalid', 'qa-session-a', workspace('a@test.invalid')), false)
  assert.equal(getLoginWorkspace(), null)
})
