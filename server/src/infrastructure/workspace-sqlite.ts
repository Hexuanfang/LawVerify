import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { isDeepStrictEqual } from 'node:util'
import type { Certificate, CertificateParagraph, WorkspaceState } from '../domain.js'
import { AppError } from '../core/app-error.js'

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
      db.exec('PRAGMA busy_timeout = 10000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;')
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

  private encodeAssets(value: unknown, persist: boolean, media = false): unknown {
    if (media && typeof value === 'string' && value.startsWith('data:')) {
      const hash = createHash('sha256').update(value).digest('hex')
      if (persist) {
        mkdirSync(this.assetsDir, { recursive: true })
        const file = path.join(this.assetsDir, hash)
        if (existsSync(file)) {
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
      }
      return { __lawverifyAsset: hash }
    }
    if (Array.isArray(value)) return value.map(item => this.encodeAssets(item, persist, media))
    if (isObject(value)) {
      return Object.fromEntries(Object.entries(value).map(([key, item]) =>
        [key, this.encodeAssets(item, persist, mediaKeys.has(key))],
      ))
    }
    return value
  }

  private decodeAssets(value: unknown, cache = new Map<string, string>()): unknown {
    if (isObject(value) && typeof value.__lawverifyAsset === 'string') {
      const hash = value.__lawverifyAsset
      if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid workspace asset reference')
      let content = cache.get(hash)
      if (content === undefined) {
        try {
          content = readFileSync(path.join(this.assetsDir, hash), 'utf8')
        } catch {
          throw new AppError('证据原件缓存无法读取，请保留工作区并从备份恢复。', 500, 'WORKSPACE_ASSET_MISSING')
        }
        if (createHash('sha256').update(content).digest('hex') !== hash) {
          throw new AppError('证据原件缓存校验失败，请从备份恢复工作区。', 500, 'WORKSPACE_ASSET_CORRUPT')
        }
        cache.set(hash, content)
      }
      return content
    }
    if (Array.isArray(value)) return value.map(item => this.decodeAssets(item, cache))
    if (isObject(value)) {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.decodeAssets(item, cache)]))
    }
    return value
  }

  private flatten(state: WorkspaceState, persistAssets: boolean) {
    const rows = new Map<string, RecordRow>()
    const add = (table: Table, id: string, value: unknown, position = 0, parentId: string | null = null, caseId: string | null = null) => {
      if (typeof id !== 'string' || !id) throw new Error(`Missing record ID in ${table}`)
      const row: RecordRow = { table, id, parentId, caseId, position, payload: JSON.stringify(this.encodeAssets(value, persistAssets)) }
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
    const list = (table: Table, parentId?: string) => [...rows.values()]
      .filter(row => row.table === table && (parentId === undefined || row.parentId === parentId))
      .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
      .map(row => JSON.parse(row.payload) as JsonObject)
    const state = { ...list('workspace_extra')[0], user: list('workspace_user')[0] } as unknown as WorkspaceState
    for (const [collection, table] of Object.entries(collections)) {
      (state as unknown as JsonObject)[collection] = list(table)
    }
    const certificateRows = [...rows.values()].filter(row => row.table === 'certificates')
      .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
    state.certificates = certificateRows.map(row => {
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
          const rows = this.flatten(state, true)
          this.putRows(db, rows)
          const stored = this.readRows(db)
          if (!isDeepStrictEqual(rows, stored)) throw new Error('Workspace migration verification failed')
          if (!isDeepStrictEqual(this.flatten(this.assemble(stored), false), rows)) {
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

  save(state: WorkspaceState) {
    const base = (state as unknown as Record<symbol, WorkspaceSnapshot>)[snapshotKey]
    if (!base || base.databasePath !== this.databasePath) {
      throw new AppError('工作区保存缺少有效版本，请刷新后重试。', 409, 'WORKSPACE_SNAPSHOT_REQUIRED')
    }
    const desired = this.flatten(state, true)
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
