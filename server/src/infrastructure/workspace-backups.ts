import { backup, DatabaseSync } from 'node:sqlite'
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

const pending = new Map<string, Promise<string>>()
let queue: Promise<unknown> = Promise.resolve()

export function createWorkspaceBackup(databasePath: string): Promise<string> {
  const existing = pending.get(databasePath)
  if (existing) return existing
  const task = queue.catch(() => {}).then(async () => {
    const directory = path.join(path.dirname(databasePath), 'workspace-backups')
    await mkdir(directory, { recursive: true })
    const temporary = path.join(directory, `${randomUUID()}.tmp`)
    const target = path.join(directory, `workspace-${Date.now()}-${randomUUID()}.sqlite`)
    const source = new DatabaseSync(databasePath, { readOnly: true })
    try {
      await backup(source, temporary, { rate: 64 })
      const candidate = new DatabaseSync(temporary)
      try {
        // Make the snapshot standalone; it must not depend on WAL sidecars.
        candidate.exec('PRAGMA journal_mode = DELETE')
        if (candidate.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') throw new Error('Backup integrity failed')
        if (!candidate.prepare("SELECT value FROM workspace_meta WHERE key = 'initialized'").get()) throw new Error('Backup not initialized')
      } finally { candidate.close() }
      await rename(temporary, target)
      const files = (await readdir(directory)).filter(file => /^workspace-\d+-[a-f0-9-]+\.sqlite$/.test(file)).sort().reverse()
      for (const old of files.slice(3)) await rm(path.join(directory, old), { force: true })
      return target
    } finally {
      source.close()
      await rm(temporary, { force: true })
      await rm(`${temporary}-wal`, { force: true })
      await rm(`${temporary}-shm`, { force: true })
    }
  })
  pending.set(databasePath, task)
  queue = task
  void task.finally(() => pending.delete(databasePath)).catch(() => {})
  return task
}

export function scheduleWorkspaceBackup(databasePath: string) {
  const directory = path.join(path.dirname(databasePath), 'workspace-backups')
  if (pending.has(databasePath)) return
  // Directory mtime survives restarts; no timer or high-frequency polling is needed.
  void stat(directory).then(metadata => Date.now() - metadata.mtimeMs < 5 * 60 * 1000, () => false)
    .then(recent => recent ? undefined : createWorkspaceBackup(databasePath))
    .catch(() => {
      const parent = (process as typeof process & { parentPort?: { postMessage: (message: unknown) => void } }).parentPort
      parent?.postMessage({ type: 'diagnostic', event: 'workspace-backup-failed' })
    })
}
