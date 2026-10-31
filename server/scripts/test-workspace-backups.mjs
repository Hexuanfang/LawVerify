import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { createWorkspaceBackup } from '../src/infrastructure/workspace-backups.ts'
import { WorkspaceSqliteStore } from '../src/infrastructure/workspace-sqlite.ts'

test('verified WAL snapshots keep three versions and preserve the live database', async t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'lawverify-backup-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const store = new WorkspaceSqliteStore(directory)
  const state = store.read(() => ({
    user: { id: 'user', points: 10 }, cases: [], certificates: [], evidences: [],
    evidenceFragments: [], evidenceInsights: [], caseContextMemories: [], draftMemories: [],
    claimUnits: [], claimEvidenceMatches: [], knowledgeCases: [], knowledgeFiles: [], knowledgeStatutes: [], paymentOrders: [],
  }))
  for (let i = 0; i < 4; i++) {
    state.cases.push({ id: `case-${i}`, name: `Snapshot ${i}` })
    store.save(state)
    const backupPath = await createWorkspaceBackup(store.databasePath)
    const snapshot = new DatabaseSync(backupPath, { readOnly: true })
    try {
      assert.equal(snapshot.prepare('PRAGMA quick_check').get().quick_check, 'ok')
      assert.equal(snapshot.prepare('SELECT count(*) AS count FROM cases').get().count, i + 1)
    } finally { snapshot.close() }
  }
  assert.equal(readdirSync(path.join(directory, 'workspace-backups')).length, 3)
  assert.equal(store.read(() => { throw new Error('must not reset') }).cases.length, 4)
})

test('concurrent backup requests share one verified snapshot', async t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'lawverify-backup-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const db = new DatabaseSync(path.join(directory, 'workspace.sqlite'))
  db.exec("CREATE TABLE workspace_meta(key TEXT PRIMARY KEY, value TEXT); INSERT INTO workspace_meta VALUES ('initialized','yes')")
  db.close()
  const result = await Promise.all(Array.from({ length: 8 }, () => createWorkspaceBackup(path.join(directory, 'workspace.sqlite'))))
  assert.equal(new Set(result).size, 1)
  assert.equal(readdirSync(path.join(directory, 'workspace-backups')).length, 1)
})
