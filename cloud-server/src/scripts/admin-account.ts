import { randomBytes } from 'node:crypto'

import { config } from '../config.js'
import { createAdminAccount, getAccountStatuses, setAccountEmail, setAccountPassword } from '../commercial/auth-service.js'
import { AppError } from '../core/app-error.js'
import { isDatabaseEnabled } from '../infrastructure/postgres.js'
import { getPlatformAdminEmails, isPlatformAdminEmail } from '../middleware/authenticate.js'

const usage = `用法：
  node dist/scripts/admin-account.js list
  node dist/scripts/admin-account.js create <账号> [--name 显示名] [--password 密码 | --password-stdin]
  node dist/scripts/admin-account.js set-password <账号> [--password 密码 | --password-stdin]
  node dist/scripts/admin-account.js set-email <当前账号> <新账号>

未提供密码时自动生成随机密码并打印一次。修改密码或账号会使该账号所有已登录会话失效。
系统管理员权限由环境变量 ADMIN_EMAILS 决定，新建或改名后请确认新账号已列入其中。`

function parseArgs(argv: string[]) {
  const positional: string[] = []
  const options = new Map<string, string | true>()
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    const name = arg.slice(2)
    const next = argv[index + 1]
    if (name === 'password-stdin' || name === 'help' || next === undefined || next.startsWith('--')) {
      options.set(name, true)
    } else {
      options.set(name, next)
      index += 1
    }
  }
  return { positional, options }
}

async function readStdin() {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '')
}

async function resolvePassword(options: Map<string, string | true>) {
  const value = options.get('password')
  if (typeof value === 'string') return { password: value, generated: false }
  if (options.has('password-stdin')) return { password: await readStdin(), generated: false }
  return { password: randomBytes(12).toString('base64url'), generated: true }
}

function assertPassword(password: string) {
  if (password.length < 8) throw new AppError('密码至少 8 位。', 400, 'WEAK_PASSWORD')
}

function warnIfNotAdmin(email: string) {
  if (!isPlatformAdminEmail(email)) {
    console.warn(`注意：${email} 不在 ADMIN_EMAILS（${getPlatformAdminEmails().join(', ') || '空'}）中，登录后没有系统管理员权限。`)
  }
}

function printPassword(email: string, password: string, generated: boolean) {
  if (generated) console.log(`账号 ${email} 的新密码：${password}`)
  else console.log(`账号 ${email} 的密码已设置。`)
}

async function main() {
  const { positional, options } = parseArgs(process.argv.slice(2))
  const [command, ...args] = positional

  if (!command || options.has('help')) {
    console.log(usage)
    return
  }

  if (!isDatabaseEnabled()) {
    console.warn('未配置 DATABASE_URL，将操作本地开发数据（.data/dev-store.json）。')
  }

  switch (command) {
    case 'list': {
      const statuses = await getAccountStatuses(getPlatformAdminEmails())
      console.log(`ADMIN_EMAILS：${getPlatformAdminEmails().join(', ') || '空'}`)
      for (const item of statuses) {
        console.log(`- ${item.email}\t${item.exists ? `已存在（${item.status}，${item.name}）` : '未创建'}`)
      }
      return
    }
    case 'create': {
      const email = args[0] || config.ADMIN_INITIAL_EMAIL
      const { password, generated } = await resolvePassword(options)
      assertPassword(password)
      const name = typeof options.get('name') === 'string' ? options.get('name') as string : undefined
      await createAdminAccount({ email, password, name })
      printPassword(email, password, generated)
      warnIfNotAdmin(email)
      return
    }
    case 'set-password': {
      const email = args[0]
      if (!email) throw new AppError('请指定账号。', 400, 'INVALID_ARGS')
      const { password, generated } = await resolvePassword(options)
      assertPassword(password)
      await setAccountPassword(email, password)
      printPassword(email, password, generated)
      return
    }
    case 'set-email': {
      const [currentEmail, nextEmail] = args
      if (!currentEmail || !nextEmail) throw new AppError('请指定当前账号和新账号。', 400, 'INVALID_ARGS')
      const result = await setAccountEmail(currentEmail, nextEmail)
      console.log(`账号已改为 ${result.email}。`)
      warnIfNotAdmin(result.email)
      return
    }
    default:
      console.log(usage)
      process.exitCode = 1
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
  .finally(() => {
    // The pg pool keeps the event loop alive; this is a one-shot command.
    setTimeout(() => process.exit(), 50).unref()
  })
