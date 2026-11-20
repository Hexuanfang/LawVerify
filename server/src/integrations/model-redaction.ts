import { AsyncLocalStorage } from 'node:async_hooks'
import { randomBytes } from 'node:crypto'

const current = new AsyncLocalStorage<ModelRedaction>()
const tokenPattern = /【隐私_[a-f0-9]{12}_(?:姓名|身份证号|手机号|邮箱)_\d+】/gu
const namePattern = /(?:姓名|原告|被告|第三人|申请人|被申请人|委托代理人|法定代表人|联系人)(?:[：:]\s*|[ \t]+)([\p{Script=Han}·]{2,8})(?=[\s，。；、：,.;（）()"]|$)/gu
const space = '[ \\t\\r\\n\\u3000]*'
const digits = (count: number) => `(?:[0-9０-９]${space}){${count - 1}}[0-9０-９]`
const id = `(?:${digits(17)}${space}[0-9０-９XxＸｘ]|${digits(15)})`
const mobile = `[1１]${space}[3-9３-９]${space}${digits(9)}`
const contactPattern = new RegExp(
  `(?<邮箱>[a-z0-9.!#$%&'*+/=?^_\`{|}~-]+[@＠][a-z0-9-]+(?:[.．][a-z0-9-]+)+)|` +
  `(?<![0-9０-９])(?:(?<身份证号>${id})|(?<手机号>${mobile}))(?!${space}[0-9０-９])`, 'giu',
)

type Kind = '姓名' | '身份证号' | '手机号' | '邮箱'

export class ModelRedaction {
  private readonly namespace = randomBytes(6).toString('hex')
  private readonly tokens = new Map<string, string>()
  private readonly originals = new Map<string, string>()
  private readonly names = new Set<string>()

  addNames(names: string[]) {
    for (const value of names) {
      const name = value.trim().match(/^[\p{Script=Han}·]{2,8}$/u)?.[0]
      if (name) this.names.add(name)
      for (const match of value.matchAll(namePattern)) this.names.add(match[1])
    }
  }

  learnText(value: string) {
    for (const match of value.matchAll(namePattern)) this.names.add(match[1])
    let parsed: unknown
    try { parsed = JSON.parse(value) } catch { return }
    JSON.stringify(parsed, (_key, item: unknown) => {
      if (typeof item === 'string') {
        for (const match of item.matchAll(namePattern)) this.names.add(match[1])
      }
      return item
    })
  }

  private token(kind: Kind, value: string) {
    const key = `${kind}:${value}`
    const existing = this.tokens.get(key)
    if (existing) return existing
    const token = `【隐私_${this.namespace}_${kind}_${this.tokens.size + 1}】`
    this.tokens.set(key, token)
    this.originals.set(token, value)
    return token
  }

  private replaceSensitive(text: string, replacement: (kind: Kind, original: string) => string) {
    const masked = text.replace(contactPattern, (...args: unknown[]) => {
      const groups = args.at(-1) as Partial<Record<Kind, string>>
      const kind = groups.邮箱 ? '邮箱' : groups.身份证号 ? '身份证号' : '手机号'
      return replacement(kind, args[0] as string)
    })
    if (!this.names.size) return masked
    const alternatives = [...this.names].sort((a, b) => b.length - a.length)
      .map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    return masked.replace(new RegExp(alternatives.join('|'), 'gu'), name => replacement('姓名', name))
  }

  maskForEmbedding(value: string) {
    return this.replaceSensitive(value, (_kind, original) => '＊'.repeat(original.length))
  }

  redact(value: string) {
    const replace = (text: string) => this.replaceSensitive(text, (kind, original) => this.token(kind, original))
    let parsed: unknown
    try { parsed = JSON.parse(value) } catch { return replace(value) }
    return JSON.stringify(parsed, (_key, item: unknown) => {
      if (typeof item === 'string') return replace(item)
      if (typeof item !== 'number') return item
      const masked = replace(String(item))
      return masked === String(item) ? item : masked
    })
  }

  restore(value: string, sentTexts: string[]) {
    const allowed = new Set(sentTexts.flatMap(text => text.match(tokenPattern) ?? []))
    const originalFor = (token: string) => {
      const original = allowed.has(token) ? this.originals.get(token) : undefined
      if (original === undefined) throw new Error('模型返回了未发送的敏感信息占位符。')
      return original
    }
    let parsed: unknown
    try { parsed = JSON.parse(value) } catch {
      // 非严格 JSON 响应可能含代码块，后续解析仍需要保留字符串转义。
      return value.replace(tokenPattern, token => JSON.stringify(originalFor(token)).slice(1, -1))
    }
    return JSON.stringify(parsed, (_key, item: unknown) =>
      typeof item === 'string' ? item.replace(tokenPattern, originalFor) : item)
  }
}

export function currentModelRedaction() {
  return current.getStore()
}

export function withModelRedaction<T>(action: () => T): T {
  return current.getStore() ? action() : current.run(new ModelRedaction(), action)
}
