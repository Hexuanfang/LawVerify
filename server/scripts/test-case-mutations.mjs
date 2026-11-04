import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { env } from '../src/config/env.ts'

const directory = mkdtempSync(path.join(os.tmpdir(), 'lawverify-case-mutations-'))
env.WORKSPACE_DATA_DIR = directory
env.KNOWLEDGE_RAG_MODE = 'local'
env.AI_GATEWAY_MODE = 'cloud'
const { readWorkspace, writeWorkspace, runWithWorkspaceAccount } = await import('../src/store.ts')
const { createApp } = await import('../src/app.ts')
const { WorkspaceSqliteStore } = await import('../src/infrastructure/workspace-sqlite.ts')

test('compact case CRUD preserves analysis and originals without loading them or requiring cloud login', async t => {
  const account = 'case-mutations@test.invalid'
  const accountDir = path.join(directory, 'workspaces', 'case-mutations-test-invalid')
  const databasePath = path.join(accountDir, 'workspace.sqlite')
  let db, server
  t.after(async () => {
    if (server) await new Promise(resolve => server.close(resolve))
    db?.close()
    rmSync(directory, { recursive: true, force: true })
  })
  await runWithWorkspaceAccount(account, async () => {
    const workspace = await readWorkspace()
    workspace.cases = [{ id: 'original', name: 'Original', description: '', status: 'draft', createdAt: '2026-11-03',
      agent: { autoAnalyze: false, pendingRefunds: [{ secret: 'private-billing' }] } }]
    workspace.evidences = [{ id: 'evidence', caseId: 'original', name: 'Source', fileName: 'source.txt',
      type: 'text', number: 'E01', uploadedAt: '2026-11-03', ocrText: 'Original content.',
      sourceDataUrl: 'data:text/plain;base64,b3JpZ2luYWw=' }]
    await writeWorkspace(workspace)
  })
  db = new DatabaseSync(databasePath)
  // A large derived collection must never be assembled by a metadata-only mutation.
  const insert = db.prepare('INSERT INTO claim_evidence_matches(id, position, payload) VALUES (?, ?, ?)')
  db.exec('BEGIN')
  for (let i = 0; i < 160000; i++) insert.run(`match-${i}`, i, JSON.stringify({ id: `match-${i}`, quote: 'cached'.repeat(50) }))
  db.exec('COMMIT')
  const preserved = db.prepare('SELECT payload, revision FROM evidences WHERE id = ?').get('evidence')
  const mediaFile = path.join(accountDir, 'workspace-assets', readdirSync(path.join(accountDir, 'workspace-assets'))[0])
  const mediaBytes = readFileSync(mediaFile)
  const { app } = createApp()
  server = app.listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  const base = `http://127.0.0.1:${server.address().port}/api`
  const request = (url, method = 'GET', body, owner = account) => fetch(`${base}${url}`, {
    method, headers: { 'content-type': 'application/json', 'x-workspace-account': owner },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000),
  })
  const caps = await request('/assistant/capabilities')
  assert.equal(caps.status, 200)
  assert.deepEqual(await caps.json(), { models: [], voice: false })
  const create = await request('/cases?response=compact', 'POST', { name: '  Created  ' })
  assert.equal(create.status, 200)
  const created = await create.json()
  assert.equal(created.caseFolder.name, 'Created')
  assert.equal(created.workspace, undefined)
  assert.equal(created.cases.length, 2)
  assert.equal(created.cases.find(c => c.id === 'original').agent.pendingRefunds, undefined)
  assert.ok(JSON.stringify(created).length < 3000)
  const rename = await request(`/cases/${created.caseFolder.id}?response=compact`, 'PATCH', { name: ' Renamed ' })
  assert.equal(rename.status, 200)
  assert.equal((await rename.json()).cases[0].name, 'Renamed')
  const renameWithEvidence = await request('/cases/original?response=compact', 'PATCH', { name: 'Renamed existing case' })
  assert.equal(renameWithEvidence.status, 200)
  const existingCase = (await renameWithEvidence.json()).cases.find(c => c.id === 'original')
  assert.equal(existingCase.name, 'Renamed existing case')
  assert.equal(existingCase.agent.task, undefined, 'name-only edits must not schedule AI analysis')
  assert.equal((await request('/cases?response=compact', 'POST', { name: '   ' })).status, 400)
  assert.equal((await request('/cases/missing?response=compact', 'PATCH', { name: 'Missing' })).status, 400)
  const other = await request(`/cases/${created.caseFolder.id}?response=compact`, 'PATCH', { name: 'Wrong account' }, 'other@test.invalid')
  assert.equal(other.status, 400)
  assert.equal(db.prepare('SELECT count(*) AS n FROM claim_evidence_matches').get().n, 160000)
  assert.deepEqual(db.prepare('SELECT payload, revision FROM evidences WHERE id = ?').get('evidence'), preserved)
  assert.deepEqual(readFileSync(mediaFile), mediaBytes)
  assert.equal(db.prepare('SELECT json_extract(payload, ?) AS name FROM cases WHERE id = ?').get('$.name', created.caseFolder.id).name, 'Renamed')
  // Missing media must not block a name-only save or reset existing records.
  rmSync(mediaFile)
  const store = new WorkspaceSqliteStore(accountDir)
  assert.equal(store.mutateCases(cases => { cases[0].name = 'Without media hydration' })[0].name, 'Without media hydration')
  assert.equal(db.prepare('SELECT count(*) AS n FROM evidences').get().n, 1)
})
