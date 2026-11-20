import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { isDeepStrictEqual } from 'node:util'
import type { CaseFolder, Certificate, CertificateParagraph, WorkspaceState } from '../domain.js'
import { AppError } from '../core/app-error.js'
import { caseFileIdentity, evidenceObjectKey, readCaseFileReferences, type CaseFile } from './workspace-case-files.js'

const collections = {
  cases: 'cases',
  evidences: 'evidences',
  evidenceFragments: 'evidence_fragments',
  evidenceInsights: 'evidence_insights',
  caseContextMemories: 'case_memories',
  draftMemories: 'draft_memories',
  claimUnits: 'claim_units',
  claimEvidenceMatches: 'claim_evidence_matches',
  knowledgeCases: 'knowledge_cases',
  knowledgeFiles: 'knowledge_files',
  knowledgeStatutes: 'knowledge_statutes',
  paymentOrders: 'payment_orders',
} as const
const tables = [
  'workspace_user', 'workspace_extra', ...Object.values(collections),
  'certificates', 'paragraphs', 'evidence_links', 'paragraph_references',
] as const
type Table = typeof tables[number]
type JsonObject = Record<string, unknown>

interface RecordRow {
  table: Table
  id: string
  parentId: string | null
  caseId: string | null
  position: number
  payload: string
}

export interface WorkspaceSnapshot {
  databasePath: string
  rows: Map<string, RecordRow>
}

const snapshotKey = Symbol('lawverify.workspace.snapshot')
const mediaKeys = new Set(['sourceDataUrl', 'previewDataUrl', 'pageImageDataUrls'])
const caseFileHistoryKey = (caseId: string) => `case-files:${caseId}`

function appendCaseFiles(db: DatabaseSync, caseId: string, files: Set<CaseFile>) {
  if (!files.size) return
  const key = caseFileHistoryKey(caseId)
  const history = db.prepare('SELECT value FROM workspace_meta WHERE key = ?').get(key)
  const previous = history ? JSON.parse(String(history.value)) as CaseFile[] : []
  db.prepare('INSERT OR REPLACE INTO workspace_meta (key, value) VALUES (?, ?)')
    .run(key, JSON.stringify([...new Set([...previous, ...files])]))
}

function* liveCaseFileHistory(db: DatabaseSync) {
  const rows = db.prepare("SELECT value FROM workspace_meta JOIN cases ON workspace_meta.key = 'case-files:' || cases.id").iterate()
  for (const row of rows) yield* JSON.parse(String(row.value)) as CaseFile[]
}

function recordRemovedCaseFiles(db: DatabaseSync, current: Map<string, RecordRow>, merged: Map<string, RecordRow>) {
  const changes = new Map<string, Set<CaseFile>>()
  for (const [key, row] of current) {
    const caseId = row.table === 'cases' ? row.id : row.caseId
    const next = merged.get(key)
    if (!caseId || row.payload === next?.payload) continue
    const removed = new Set<CaseFile>()
    readCaseFileReferences(row.payload, removed)
    if (!removed.size) continue
    const remaining = new Set<CaseFile>()
    if (next) readCaseFileReferences(next.payload, remaining)
    const files = changes.get(caseId) ?? new Set<CaseFile>()
    for (const file of removed) {
      if (!remaining.has(file)) files.add(file)
    }
    changes.set(caseId, files)
  }
  for (const [caseId, files] of changes) appendCaseFiles(db, caseId, files)
}

// 资产文件的完整性校验结果：同一份资产在一个进程里只校验一次。
// 之后用体积与修改时间判断文件是否仍然可信，避免每次读写都重新读回整份文件算哈希。
// 进程重启后首次访问会重新校验一次，外部改动文件也会因体积或时间变化被重新校验。
const verifiedAssets = new Map<string, { size: number; mtimeMs: number }>()

// 已解码的原件内容：原件以哈希寻址，同一份原件只保留一份字符串。
// 并发任务各自读取工作区时不再各持有一份十几 MB 的 base64 副本，
// 内存占用与并发数无关，也不会因为反复解码把事件循环占满。
const assetContentCache = new Map<string, { content: string; size: number; mtimeMs: number }>()
const ASSET_CACHE_MAX_CHARS = 512 * 1024 * 1024
let assetContentChars = 0

function rowKey(row: Pick<RecordRow, 'table' | 'id'>) {
  return JSON.stringify([row.table, row.id])
}

function conflict(): never {
  throw new AppError('同一份材料或文书已被其他任务更新，本次保存已取消。请刷新后重试，已有结果不会被覆盖。', 409, 'WORKSPACE_CONFLICT')
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function storageError(error: unknown): never {
  if (error instanceof AppError) throw error
  const code = (error as { errcode?: number }).errcode
  if (code === 5 || code === 6) {
    throw new AppError('工作区正在保存，请稍后重试。', 409, 'WORKSPACE_BUSY')
  }
  if (code === 11 || code === 26) {
    throw new AppError('本地工作区数据库无法读取，已阻止自动重置。请保留 workspace.sqlite 和原有 JSON 备份后恢复数据。', 500, 'WORKSPACE_DATABASE_CORRUPT')
  }
  throw error
}

function itemKey(value: unknown) {
  if (!isObject(value)) return null
  if (typeof value.id === 'string') return value.id
  // Older sentence links do not necessarily have IDs.
  if (typeof value.evidenceId === 'string') {
    return JSON.stringify([value.evidenceId, value.sentenceIndex ?? null, value.sentenceText ?? null])
  }
  return null
}

function mergeValue(base: unknown, desired: unknown, current: unknown): unknown {
  if (isDeepStrictEqual(base, desired)) return current
  if (isDeepStrictEqual(base, current) || isDeepStrictEqual(desired, current)) return desired
  if (isObject(base) && isObject(desired) && isObject(current)) {
    const result: JsonObject = {}
    for (const key of new Set([...Object.keys(base), ...Object.keys(desired), ...Object.keys(current)])) {
      const value = mergeValue(base[key], desired[key], current[key])
      if (value !== undefined) result[key] = value
    }
    return result
  }
  if (Array.isArray(base) && Array.isArray(desired) && Array.isArray(current)) {
    const index = (items: unknown[]) => {
      const result = new Map<string, unknown>()
      for (const item of items) {
        const key = itemKey(item)
        if (key === null || result.has(key)) return null
        result.set(key, item)
      }
      return result
    }
    const b = index(base), d = index(desired), c = index(current)
    if (b && d && c) {
      const result: unknown[] = []
      for (const key of new Set([...d.keys(), ...c.keys(), ...b.keys()])) {
        const value = mergeValue(b.get(key), d.get(key), c.get(key))
        if (value !== undefined) result.push(value)
      }
      return result
    }
  }
  return conflict()
}

function attachSnapshot(state: WorkspaceState, snapshot: WorkspaceSnapshot) {
  // Enumerable symbols survive service-layer object spreads but never enter JSON responses.
  Object.defineProperty(state, snapshotKey, { value: snapshot, enumerable: true, configurable: true })
  return state
}

export function inheritWorkspaceSnapshot(source: WorkspaceState, target: WorkspaceState) {
  const snapshot = (source as unknown as Record<symbol, WorkspaceSnapshot>)[snapshotKey]
  if (snapshot) attachSnapshot(target, snapshot)
  return target
}

export class WorkspaceSqliteStore {
  readonly databasePath: string
  private readonly assetsDir: string

  constructor(readonly dataDir: string) {
    this.databasePath = path.join(dataDir, 'workspace.sqlite')
    this.assetsDir = path.join(dataDir, 'workspace-assets')
  }

  private open() {
    mkdirSync(this.dataDir, { recursive: true })
    let db: DatabaseSync
    try {
      db = new DatabaseSync(this.databasePath)
    } catch (error) {
      return storageError(error)
    }
    try {
      db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;')
      // journal_mode 是写操作：每次连接都重设会和正在进行的写入事务互相等待，
      // busy_timeout 到点后表现为数十秒的假死（桌面端看门狗会直接杀掉服务）。
      // 只在确实不是 WAL 时切一次，切完就不再触碰。
      const journalMode = String(db.prepare('PRAGMA journal_mode').get()?.journal_mode ?? '').toLowerCase()
      if (journalMode !== 'wal') db.exec('PRAGMA journal_mode = WAL;')
      const version = Number(db.prepare('PRAGMA user_version').get()?.user_version)
      if (version > 1) {
        throw new AppError('工作区由更新版本创建，请升级 LawVerify 后打开。', 409, 'WORKSPACE_VERSION')
      }
      if (version === 0) {
        db.exec('BEGIN IMMEDIATE')
        try {
          db.exec('CREATE TABLE IF NOT EXISTS workspace_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
          for (const table of tables) {
            const parent = table === 'paragraphs' ? 'certificates'
              : table === 'evidence_links' || table === 'paragraph_references' ? 'paragraphs' : null
            db.exec(`CREATE TABLE IF NOT EXISTS ${table} (
              id TEXT PRIMARY KEY,
              parent_id TEXT ${parent ? `REFERENCES ${parent}(id) ON DELETE CASCADE` : ''},
              case_id TEXT,
              position INTEGER NOT NULL,
              payload TEXT NOT NULL CHECK(json_valid(payload)),
              revision INTEGER NOT NULL DEFAULT 1
            );
            CREATE INDEX IF NOT EXISTS ${table}_case_idx ON ${table}(case_id);
            CREATE INDEX IF NOT EXISTS ${table}_parent_idx ON ${table}(parent_id, position);`)
          }
          db.exec('PRAGMA user_version = 1; COMMIT')
        } catch (error) {
          db.exec('ROLLBACK')
          throw error
        }
      }
      return db
    } catch (error) {
      db.close()
      return storageError(error)
    }
  }

  private encodeAssets(value: unknown, assets?: Map<string, string>, media = false): unknown {
    if (media && typeof value === 'string' && value.startsWith('data:')) {
      const hash = createHash('sha256').update(value).digest('hex')
      assets?.set(hash, value)
      return { __lawverifyAsset: hash }
    }
    if (Array.isArray(value)) return value.map(item => this.encodeAssets(item, assets, media))
    if (isObject(value)) {
      return Object.fromEntries(Object.entries(value).map(([key, item]) =>
        [key, this.encodeAssets(item, assets, mediaKeys.has(key))],
      ))
    }
    return value
  }

  private persistAssets(assets: Map<string, string>, rows: Map<string, RecordRow>) {
    if (!assets.size) return
    const retained = new Set<CaseFile>()
    for (const row of rows.values()) {
      if (row.payload.includes('"__lawverifyAsset"')) readCaseFileReferences(row.payload, retained)
    }
    for (const [hash, value] of assets) {
      // 合并前的旧快照可能仍包含已删除案件的缓存，只写入合并后仍被引用的文件。
      if (!retained.has(`asset:${hash}`)) continue
      mkdirSync(this.assetsDir, { recursive: true })
      const file = path.join(this.assetsDir, hash)
      if (existsSync(file)) {
        // 文件名就是内容哈希，已校验过且未被改动时不必再读回整份文件重算。
        if (this.isAssetTrusted(file)) continue
        if (createHash('sha256').update(readFileSync(file)).digest('hex') !== hash) {
          throw new AppError('证据原件缓存校验失败，已阻止保存。请检查工作区存储。', 500, 'WORKSPACE_ASSET_CORRUPT')
        }
      } else {
        const temporary = `${file}.${randomUUID()}.tmp`
        try {
          writeFileSync(temporary, value, { encoding: 'utf8', flag: 'wx', flush: true })
          renameSync(temporary, file)
        } finally {
          rmSync(temporary, { force: true })
        }
      }
      this.rememberAsset(file)
    }
  }

  private decodeAssets(value: unknown): unknown {
    if (isObject(value) && typeof value.__lawverifyAsset === 'string') {
      const hash = value.__lawverifyAsset
      if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid workspace asset reference')
      return this.readAssetContent(hash)
    }
    if (Array.isArray(value)) return value.map(item => this.decodeAssets(item))
    if (isObject(value)) {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.decodeAssets(item)]))
    }
    return value
  }

  private readAssetContent(hash: string) {
    const file = path.join(this.assetsDir, hash)
    const stat = this.assetStat(file)
    const cached = assetContentCache.get(hash)
    // 命中缓存前先确认文件没有被改动：体积或修改时间变了就重新读回并校验。
    if (cached && stat && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
      // 命中后移到队尾，便于按最近使用淘汰。
      assetContentCache.delete(hash)
      assetContentCache.set(hash, cached)
      return cached.content
    }

    let content: string
    try {
      content = readFileSync(file, 'utf8')
    } catch {
      throw new AppError('证据原件缓存无法读取，请保留工作区并从备份恢复。', 500, 'WORKSPACE_ASSET_MISSING')
    }
    // 已经校验过且文件未被改动时跳过哈希比对，避免每次读取工作区都重算全部原件。
    if (!this.isAssetTrusted(file)) {
      if (createHash('sha256').update(content).digest('hex') !== hash) {
        throw new AppError('证据原件缓存校验失败，请从备份恢复工作区。', 500, 'WORKSPACE_ASSET_CORRUPT')
      }
      this.rememberAsset(file)
    }

    assetContentCache.set(hash, { content, size: stat?.size ?? content.length, mtimeMs: stat?.mtimeMs ?? 0 })
    assetContentChars += content.length
    while (assetContentChars > ASSET_CACHE_MAX_CHARS) {
      const oldest = assetContentCache.keys().next().value
      if (oldest === undefined) break
      const removed = assetContentCache.get(oldest)
      assetContentCache.delete(oldest)
      assetContentChars -= removed?.content.length ?? 0
    }
    return content
  }

  private assetStat(file: string) {
    try {
      const stat = statSync(file)
      return { size: stat.size, mtimeMs: stat.mtimeMs }
    } catch {
      return null
    }
  }

  /** 文件此前已通过完整性校验，且体积与修改时间都没有变化。 */
  private isAssetTrusted(file: string) {
    const stat = this.assetStat(file)
    if (!stat) return false
    const trusted = verifiedAssets.get(file)
    return Boolean(trusted && trusted.size === stat.size && trusted.mtimeMs === stat.mtimeMs)
  }

  private rememberAsset(file: string) {
    const stat = this.assetStat(file)
    if (stat) verifiedAssets.set(file, stat)
  }

  private flatten(state: WorkspaceState, assets?: Map<string, string>) {
    const rows = new Map<string, RecordRow>()
    const add = (table: Table, id: string, value: unknown, position = 0, parentId: string | null = null, caseId: string | null = null) => {
      if (typeof id !== 'string' || !id) throw new Error(`Missing record ID in ${table}`)
      const row: RecordRow = { table, id, parentId, caseId, position, payload: JSON.stringify(this.encodeAssets(value, assets)) }
      const key = rowKey(row)
      if (rows.has(key)) throw new Error(`Duplicate record ID in ${table}: ${id}`)
      rows.set(key, row)
    }
    add('workspace_user', 'user', state.user)
    const extra = { ...state } as unknown as JsonObject
    delete extra.user
    delete extra.certificates
    for (const [collection, table] of Object.entries(collections)) {
      delete extra[collection]
      const items = state[collection as keyof typeof collections] ?? []
      if (!Array.isArray(items)) throw new Error(`Invalid workspace collection: ${collection}`)
      const matchOccurrences = new Map<string, number>()
      items.forEach((item, position) => {
        const value = item as unknown as JsonObject
        let id = value.id as string
        if (collection === 'claimEvidenceMatches') {
          // Historical heuristic/model matches can share a public ID. Preserve every occurrence.
          const identity = JSON.stringify([id, value.source, value.evidenceId, value.evidenceFragmentId])
          const occurrence = matchOccurrences.get(identity) ?? 0
          matchOccurrences.set(identity, occurrence + 1)
          id = JSON.stringify([identity, occurrence])
        }
        add(table, id, item, position, null, typeof value.caseId === 'string' ? value.caseId : null)
      })
    }
    add('workspace_extra', 'extra', extra)
    for (const [position, certificate] of (state.certificates ?? []).entries()) {
      const { paragraphs, ...metadata } = certificate
      add('certificates', certificate.id, metadata, position, null, certificate.caseId)
      for (const [paragraphPosition, paragraph] of (paragraphs ?? []).entries()) {
        const { links, link, references, ...text } = paragraph
        add('paragraphs', paragraph.id, text, paragraphPosition, certificate.id, certificate.caseId)
        const linkOccurrences = new Map<string, number>()
        for (const [index, evidenceLink] of (links?.length ? links : link ? [link] : []).entries()) {
          const identity = JSON.stringify([paragraph.id, evidenceLink.id ?? evidenceLink.evidenceId,
            evidenceLink.sentenceIndex ?? null, evidenceLink.sentenceText ?? null])
          const occurrence = linkOccurrences.get(identity) ?? 0
          linkOccurrences.set(identity, occurrence + 1)
          add('evidence_links', JSON.stringify([identity, occurrence]), evidenceLink, index, paragraph.id, certificate.caseId)
        }
        const referenceOccurrences = new Map<string, number>()
        for (const [index, reference] of (references ?? []).entries()) {
          const identity = JSON.stringify([paragraph.id, reference.id ?? `${reference.type}:${reference.targetId}`,
            reference.sentenceIndex ?? null, reference.sentenceText ?? null])
          const occurrence = referenceOccurrences.get(identity) ?? 0
          referenceOccurrences.set(identity, occurrence + 1)
          add('paragraph_references', JSON.stringify([identity, occurrence]), reference, index, paragraph.id, certificate.caseId)
        }
      }
    }
    return rows
  }

  private readRows(db: DatabaseSync) {
    const rows = new Map<string, RecordRow>()
    for (const table of tables) {
      const stored = db.prepare(`SELECT id, parent_id, case_id, position, payload FROM ${table} ORDER BY position, id`).all()
      for (const value of stored) {
        const row: RecordRow = {
          table, id: String(value.id), parentId: value.parent_id === null ? null : String(value.parent_id),
          caseId: value.case_id === null ? null : String(value.case_id),
          position: Number(value.position), payload: String(value.payload),
        }
        rows.set(rowKey(row), row)
      }
    }
    return rows
  }

  private assemble(rows: Map<string, RecordRow>): WorkspaceState {
    // 先按表与父节点分组：每个集合、每个段落、每条挂接只在各自的分组里排序，
    // 不再为一次查询扫描全部记录。
    const grouped = new Map<Table, Map<string | null, RecordRow[]>>()
    for (const row of rows.values()) {
      let parents = grouped.get(row.table)
      if (!parents) {
        parents = new Map()
        grouped.set(row.table, parents)
      }
      const key = row.parentId ?? null
      const bucket = parents.get(key)
      if (bucket) {
        bucket.push(row)
      } else {
        parents.set(key, [row])
      }
    }
    const compare = (a: RecordRow, b: RecordRow) => a.position - b.position || a.id.localeCompare(b.id)
    const list = (table: Table, parentId?: string) => {
      const parents = grouped.get(table)
      if (!parents) {
        return [] as JsonObject[]
      }
      let tableRows: RecordRow[]
      if (parentId === undefined) {
        tableRows = []
        for (const bucket of parents.values()) {
          for (const row of bucket) {
            tableRows.push(row)
          }
        }
      } else {
        tableRows = parents.get(parentId) ?? []
      }
      return tableRows
        .slice()
        .sort(compare)
        .map(row => JSON.parse(row.payload) as JsonObject)
    }
    const state = { ...list('workspace_extra')[0], user: list('workspace_user')[0] } as unknown as WorkspaceState
    for (const [collection, table] of Object.entries(collections)) {
      (state as unknown as JsonObject)[collection] = list(table)
    }
    const certificateRows = grouped.get('certificates')?.get(null) ?? []
    state.certificates = certificateRows.slice().sort(compare).map(row => {
      const certificate = JSON.parse(row.payload) as Certificate
      certificate.paragraphs = list('paragraphs', row.id).map(value => {
        const paragraph = value as unknown as CertificateParagraph
        paragraph.links = list('evidence_links', paragraph.id) as unknown as CertificateParagraph['links']
        paragraph.link = paragraph.links?.[0]
        paragraph.references = list('paragraph_references', paragraph.id) as unknown as CertificateParagraph['references']
        return paragraph
      })
      return certificate
    })
    return this.decodeAssets(state) as WorkspaceState
  }

  private putRows(db: DatabaseSync, desired: Map<string, RecordRow>, current = new Map<string, RecordRow>()) {
    // Delete children first and insert parents first; foreign keys stay valid throughout the transaction.
    for (const table of [...tables].reverse()) {
      const remove = db.prepare(`DELETE FROM ${table} WHERE id = ?`)
      for (const [key, row] of current) {
        if (row.table === table && !desired.has(key)) remove.run(row.id)
      }
    }
    for (const table of tables) {
      const upsert = db.prepare(`INSERT INTO ${table}(id, parent_id, case_id, position, payload)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET parent_id = excluded.parent_id, case_id = excluded.case_id,
          position = excluded.position, payload = excluded.payload, revision = ${table}.revision + 1`)
      for (const [key, row] of desired) {
        if (row.table === table && !isDeepStrictEqual(row, current.get(key))) {
          upsert.run(row.id, row.parentId, row.caseId, row.position, row.payload)
        }
      }
    }
  }

  private verifyDependencies(base: Map<string, RecordRow>, desired: Map<string, RecordRow>, current: Map<string, RecordRow>) {
    for (const [key, row] of desired) {
      if (isDeepStrictEqual(row, base.get(key))) continue
      if (row.table === 'evidence_links' || row.table === 'paragraph_references') {
        const parentKey = rowKey({ table: 'paragraphs', id: row.parentId! })
        const before = base.get(parentKey), latest = current.get(parentKey)
        if (before) {
          if (!latest) conflict()
          const b = JSON.parse(before.payload), c = JSON.parse(latest.payload)
          if (b.text !== c.text || b.richText !== c.richText) conflict()
        }
        if (row.table === 'evidence_links') {
          const evidenceKey = rowKey({ table: 'evidences', id: JSON.parse(row.payload).evidenceId })
          const original = base.get(evidenceKey), latestEvidence = current.get(evidenceKey)
          if (original) {
            if (!latestEvidence) conflict()
            const b = JSON.parse(original.payload), c = JSON.parse(latestEvidence.payload)
            if (['ocrText', 'sourceDataUrl', 'previewDataUrl', 'pageImageDataUrls', 'storageKey']
              .some(field => !isDeepStrictEqual(b[field], c[field]))) conflict()
          }
        }
      }
      if (row.table === 'evidences') {
        const before = base.get(key), latest = current.get(key)
        if (before && latest) {
          const b = JSON.parse(before.payload), d = JSON.parse(row.payload), c = JSON.parse(latest.payload)
          const inputs = ['ocrText', 'sourceDataUrl', 'previewDataUrl', 'pageImageDataUrls', 'storageKey', 'sourceMimeType', 'pages']
          const outputs = ['summaryText', 'summaryCacheKey', 'summaryStatus', 'summaryUpdatedAt']
          if (outputs.some(field => !isDeepStrictEqual(b[field], d[field]))
            && inputs.some(field => !isDeepStrictEqual(b[field], c[field]))) conflict()
          if (inputs.some(field => !isDeepStrictEqual(b[field], d[field]))
            && outputs.some(field => !isDeepStrictEqual(b[field], c[field]))) conflict()
        }
      }
    }
    // A stale delete must not silently discard work created after the delete task's snapshot.
    for (const [key, before] of base) {
      if (desired.has(key) || !['cases', 'certificates', 'paragraphs', 'evidences'].includes(before.table)) continue
      for (const [childKey, child] of current) {
        const belongs = before.table === 'cases' ? child.caseId === before.id
          : before.table === 'evidences' ? ['evidence_insights', 'evidence_fragments'].includes(child.table)
            && JSON.parse(child.payload).evidenceId === before.id
          : child.parentId === before.id
        if (belongs && !isDeepStrictEqual(child, base.get(childKey))) conflict()
      }
    }
  }

  read(initialize: () => WorkspaceState, migrationSource?: () => string | undefined) {
    const db = this.open()
    try {
      const initialized = db.prepare("SELECT value FROM workspace_meta WHERE key = 'initialized'").get()
      db.exec(initialized ? 'BEGIN' : 'BEGIN IMMEDIATE')
      try {
        if (!db.prepare("SELECT value FROM workspace_meta WHERE key = 'initialized'").get()) {
          const state = initialize()
          const assets = new Map<string, string>()
          const rows = this.flatten(state, assets)
          this.persistAssets(assets, rows)
          this.putRows(db, rows)
          const stored = this.readRows(db)
          if (!isDeepStrictEqual(rows, stored)) throw new Error('Workspace migration verification failed')
          if (!isDeepStrictEqual(this.flatten(this.assemble(stored)), rows)) {
            throw new Error('Workspace asset migration verification failed')
          }
          db.prepare('INSERT INTO workspace_meta(key, value) VALUES (?, ?)').run('initialized', new Date().toISOString())
          const source = migrationSource?.()
          if (source) db.prepare('INSERT INTO workspace_meta(key, value) VALUES (?, ?)').run('migration_source', source)
          db.prepare('INSERT INTO workspace_meta(key, value) VALUES (?, ?)').run('migration_counts', JSON.stringify(
            Object.fromEntries(tables.map(table => [table, [...rows.values()].filter(row => row.table === table).length])),
          ))
          const check = db.prepare('PRAGMA quick_check').get()
          if (check?.quick_check !== 'ok') throw new Error('Workspace database integrity check failed')
        }
        const rows = this.readRows(db)
        const state = this.assemble(rows)
        db.exec('COMMIT')
        return attachSnapshot(state, { databasePath: this.databasePath, rows })
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    } catch (error) {
      return storageError(error)
    } finally {
      db.close()
    }
  }

  mutateCases(action: (cases: CaseFolder[], hasEvidence: (caseId: string) => boolean) => void): CaseFolder[] | null {
    const db = this.open()
    try {
      if (!db.prepare("SELECT value FROM workspace_meta WHERE key = 'initialized'").get()) return null
      db.exec('BEGIN IMMEDIATE')
      try {
        const rows = db.prepare('SELECT id, position, payload FROM cases ORDER BY position, id').all()
        const cases = rows.map(row => JSON.parse(String(row.payload)) as CaseFolder)
        const evidenceQuery = db.prepare('SELECT 1 FROM evidences WHERE case_id = ? LIMIT 1')
        action(cases, caseId => Boolean(evidenceQuery.get(caseId)))
        const update = db.prepare('UPDATE cases SET position = ?, payload = ?, revision = revision + 1 WHERE id = ?')
        const insert = db.prepare('INSERT INTO cases(id, parent_id, case_id, position, payload) VALUES (?, NULL, NULL, ?, ?)')
        const existing = new Map(rows.map(row => [String(row.id), row]))
        for (const [position, folder] of cases.entries()) {
          const payload = JSON.stringify(folder)
          const before = existing.get(folder.id)
          if (!before) insert.run(folder.id, position, payload)
          else if (before.position !== position || before.payload !== payload) update.run(position, payload, folder.id)
        }
        db.exec('COMMIT')
        return cases
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    } catch (error) {
      return storageError(error)
    } finally {
      db.close()
    }
  }

  rememberCaseFiles(caseId: string, files: Set<CaseFile>) {
    const db = this.open()
    try {
      db.exec('BEGIN IMMEDIATE')
      try {
        if (!db.prepare('SELECT 1 FROM cases WHERE id = ?').get(caseId)) {
          throw new AppError('案件不存在。', 404, 'CASE_NOT_FOUND')
        }
        appendCaseFiles(db, caseId, files)
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    } finally {
      db.close()
    }
  }

  readEvidenceObjectReferences(keys: Set<CaseFile>) {
    try {
      statSync(this.databasePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
    const db = new DatabaseSync(this.databasePath, { readOnly: true })
    try {
      db.exec('PRAGMA busy_timeout = 5000; BEGIN')
      if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'workspace_meta'").get()
        || !db.prepare("SELECT 1 FROM workspace_meta WHERE key = 'initialized'").get()) return false
      for (const table of ['evidences', 'cases', 'knowledge_files']) {
        const refs = db.prepare(`SELECT DISTINCT ref.value FROM ${table}, json_tree(payload) AS ref
          WHERE ref.key = 'storageKey' AND ref.type = 'text'`).iterate()
        for (const ref of refs) {
          const key = evidenceObjectKey(String(ref.value))
          if (key) keys.add(caseFileIdentity(`evidence:${key}`))
        }
      }
      for (const file of liveCaseFileHistory(db)) {
        if (file.startsWith('evidence:')) keys.add(caseFileIdentity(file))
      }
      db.exec('COMMIT')
      return true
    } finally {
      db.close()
    }
  }

  cleanupDeletedCaseFiles(caseId: string, remove: (file: CaseFile) => void) {
    const db = this.open()
    try {
      db.exec('BEGIN IMMEDIATE')
      try {
        const key = caseFileHistoryKey(caseId)
        const history = db.prepare('SELECT value FROM workspace_meta WHERE key = ?').get(key)
        if (history && !db.prepare('SELECT 1 FROM cases WHERE id = ?').get(caseId)) {
          const retained = new Set<CaseFile>(liveCaseFileHistory(db))
          for (const row of this.readRows(db).values()) readCaseFileReferences(row.payload, retained)
          const identities = new Set([...retained].map(caseFileIdentity))
          for (const file of JSON.parse(String(history.value)) as CaseFile[]) {
            if (!identities.has(caseFileIdentity(file))) remove(file)
          }
          db.prepare('DELETE FROM workspace_meta WHERE key = ?').run(key)
        }
        db.exec('COMMIT')
      } catch (error) {
        // 已经清理的文件允许重复删除，失败时保留整份清单供重试。
        db.exec('ROLLBACK')
        throw error
      }
    } finally {
      db.close()
    }
  }

  save(state: WorkspaceState) {
    const base = (state as unknown as Record<symbol, WorkspaceSnapshot>)[snapshotKey]
    if (!base || base.databasePath !== this.databasePath) {
      throw new AppError('工作区保存缺少有效版本，请刷新后重试。', 409, 'WORKSPACE_SNAPSHOT_REQUIRED')
    }
    const assets = new Map<string, string>()
    const desired = this.flatten(state, assets)
    const db = this.open()
    try {
      db.exec('BEGIN IMMEDIATE')
      try {
        const current = this.readRows(db)
        this.verifyDependencies(base.rows, desired, current)
        const merged = new Map(current)
        for (const key of new Set([...base.rows.keys(), ...desired.keys()])) {
          const before = base.rows.get(key), after = desired.get(key), latest = current.get(key)
          if (isDeepStrictEqual(before, after)) continue
          if (!after) {
            if (latest && !isDeepStrictEqual(before, latest)) conflict()
            merged.delete(key)
          } else if (!before) {
            if (latest && !isDeepStrictEqual(after, latest)) conflict()
            merged.set(key, after)
          } else {
            if (!latest) conflict()
            merged.set(key, {
              ...after,
              parentId: mergeValue(before.parentId, after.parentId, latest.parentId) as string | null,
              caseId: mergeValue(before.caseId, after.caseId, latest.caseId) as string | null,
              position: after.position === before.position ? latest.position : after.position,
              payload: JSON.stringify(mergeValue(JSON.parse(before.payload), JSON.parse(after.payload), JSON.parse(latest.payload))),
            })
          }
        }
        this.persistAssets(assets, merged)
        recordRemovedCaseFiles(db, current, merged)
        this.putRows(db, merged, current)
        const result = this.assemble(merged)
        db.exec('COMMIT')
        Object.assign(state, result)
        attachSnapshot(state, { databasePath: this.databasePath, rows: merged })
        return state
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    } catch (error) {
      return storageError(error)
    } finally {
      db.close()
    }
  }

}
