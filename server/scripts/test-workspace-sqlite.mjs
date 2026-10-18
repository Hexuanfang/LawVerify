import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { WorkspaceSqliteStore } from '../src/infrastructure/workspace-sqlite.ts'

function fixture() {
  return {
    user: { id: 'user', name: 'test', email: 'test@example.com', phone: '', organization: '', title: '', points: 100, pointLogs: [] },
    cases: [{ id: 'case', name: 'test case', description: '', createdAt: '2026-10-14', status: 'draft' }],
    evidences: [
      { id: 'e1', caseId: 'case', number: 'E01', name: 'one', fileName: 'one.txt', type: 'text', uploadedAt: '2026-10-14', ocrText: 'original one', summaryText: 'cached', summaryCacheKey: 'original-fingerprint', summaryStatus: 'ready', sourceDataUrl: 'data:text/plain;base64,b3JpZ2luYWw=' },
      { id: 'e2', caseId: 'case', number: 'E02', name: 'two', fileName: 'two.png', type: 'image', uploadedAt: '2026-10-14', ocrText: 'original two', previewDataUrl: 'data:image/png;base64,aW1hZ2U=', pageImageDataUrls: ['data:image/png;base64,aW1hZ2U='] },
    ],
    evidenceFragments: [],
    evidenceInsights: [{ id: 'insight', caseId: 'case', evidenceId: 'e1', version: 4, summary: 'cached understanding', status: 'ready', keyFacts: ['fact'], entities: [], timelineEvents: [], amounts: [], positions: [], issues: [], sourceFragmentIds: [], confidence: 0.9, updatedAt: '2026-10-14' }],
    caseContextMemories: [{ id: 'memory', caseId: 'case', version: 3, summary: 'cached case memory', disputeFocuses: ['dispute'] }],
    draftMemories: [],
    certificates: [{
      id: 'certificate', caseId: 'case', title: 'document', role: 'plaintiff', focus: '', createdAt: '2026-10-14', paragraphIds: ['paragraph'],
      paragraphs: [{ id: 'paragraph', text: 'First sentence. Second sentence.', verified: true,
        links: [
          { id: 'link-0', evidenceId: 'e1', locator: 'original', quote: 'original one', sentenceIndex: 0, sentenceText: 'First sentence.', relation: 'support' },
          { id: 'link-1', evidenceId: 'e1', locator: 'original', quote: 'original one', sentenceIndex: 1, sentenceText: 'Second sentence.', reason: 'same evidence, another sentence' },
        ],
        references: [{ id: 'ref', type: 'statute', targetId: 'article', sourceTitle: 'law', label: 'article', locator: 'one', quote: 'text', sentenceIndex: 1 }],
      }],
    }],
    claimUnits: [], claimEvidenceMatches: [], knowledgeCases: [], knowledgeFiles: [], knowledgeStatutes: [], paymentOrders: [],
  }
}

function isolated(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lawverify-sqlite-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const store = new WorkspaceSqliteStore(dir)
  const state = store.read(fixture)
  return { dir, store, state }
}

function read(store) {
  return store.read(() => { throw new Error('Existing database must not reinitialize') })
}

function worker(code, args = [], runtime = process.execPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(runtime, ['--import', 'tsx', '--input-type=module', '-e', code, ...args], {
      cwd: new URL('..', import.meta.url), env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    child.on('error', reject)
    child.on('exit', code => code === 0 ? resolve(output) : reject(new Error(output || `worker exited ${code}`)))
  })
}

test('SQLite roundtrip preserves cached understanding, memory, and separate sentence links', t => {
  const { store, state } = isolated(t)
  assert.equal(state.evidences[0].summaryCacheKey, 'original-fingerprint')
  assert.equal(state.evidenceInsights[0].version, 4)
  assert.equal(state.caseContextMemories[0].version, 3)
  assert.deepEqual(read(store), state)
  assert.equal(state.certificates[0].paragraphs[0].links.length, 2)
  const db = new DatabaseSync(store.databasePath)
  try {
    assert.equal(db.prepare('SELECT count(*) AS n FROM evidence_links').get().n, 2)
    assert.equal(db.prepare('SELECT count(*) AS n FROM paragraphs').get().n, 1)
    assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok')
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal')
    assert.equal(db.prepare("SELECT value FROM workspace_meta WHERE key = 'initialized'").get() !== undefined, true)
  } finally { db.close() }
})

test('media is deduplicated outside SQLite and decoded without changing fingerprints', t => {
  const { dir, store, state } = isolated(t)
  assert.equal(readdirSync(path.join(dir, 'workspace-assets')).length, 2)
  const db = new DatabaseSync(store.databasePath)
  try {
    const payload = db.prepare("SELECT payload FROM evidences WHERE id = 'e2'").get().payload
    assert.ok(!payload.includes('data:image'))
    assert.ok(payload.includes('__lawverifyAsset'))
  } finally { db.close() }
  assert.equal(read(store).evidences[1].previewDataUrl, state.evidences[1].previewDataUrl)
  const hash = readdirSync(path.join(dir, 'workspace-assets'))[0]
  writeFileSync(path.join(dir, 'workspace-assets', hash), 'corrupt')
  assert.throws(() => read(store), /校验失败/)
})

test('unchanged saves do not rewrite records; modifications affect only changed rows', t => {
  const { store, state } = isolated(t)
  store.save(state)
  state.evidences[0].name = 'new name'
  store.save(state)
  const db = new DatabaseSync(store.databasePath)
  try {
    assert.equal(db.prepare("SELECT revision FROM evidences WHERE id = 'e1'").get().revision, 2)
    assert.equal(db.prepare("SELECT revision FROM evidences WHERE id = 'e2'").get().revision, 1)
    assert.equal(db.prepare("SELECT revision FROM certificates WHERE id = 'certificate'").get().revision, 1)
  } finally { db.close() }
})

test('stale independent understanding and sentence-link updates both survive', t => {
  const { store } = isolated(t)
  const understanding = read(store), linkage = read(store)
  understanding.evidences[0].summaryText = 'new understanding'
  understanding.evidenceInsights[0].summary = 'new insight'
  store.save(understanding)
  linkage.certificates[0].paragraphs[0].links.push({
    id: 'link-2', evidenceId: 'e2', sentenceIndex: 1, locator: 'page one', quote: 'original two',
  })
  store.save(linkage)
  assert.equal(read(store).evidences[0].summaryText, 'new understanding')
  assert.equal(read(store).certificates[0].paragraphs[0].links.length, 3)
  assert.equal(linkage.evidenceInsights[0].summary, 'new insight')
})

test('different fields in the same evidence merge without dropping either update', t => {
  const { store } = isolated(t)
  const left = read(store), right = read(store)
  left.evidences[0].name = 'renamed'
  right.evidences[0].summaryText = 'understood'
  store.save(left)
  store.save(right)
  const result = read(store).evidences[0]
  assert.equal(result.name, 'renamed')
  assert.equal(result.summaryText, 'understood')
})

test('same-field conflicts roll back the entire save and preserve committed results', t => {
  const { store } = isolated(t)
  const left = read(store), right = read(store)
  left.evidences[0].summaryText = 'first result'
  right.evidences[0].summaryText = 'second result'
  right.cases[0].name = 'must not commit'
  store.save(left)
  assert.throws(() => store.save(right), error => error.code === 'WORKSPACE_CONFLICT')
  assert.equal(read(store).evidences[0].summaryText, 'first result')
  assert.equal(read(store).cases[0].name, 'test case')
})

test('service-layer object spreads retain optimistic snapshots and JSON never exposes them', t => {
  const { store } = isolated(t)
  const spread = { ...read(store) }
  spread.cases = spread.cases.map(item => ({ ...item, name: 'spread update' }))
  assert.ok(!JSON.stringify(spread).includes('databasePath'))
  store.save(spread)
  assert.equal(read(store).cases[0].name, 'spread update')
})

test('snapshot from another account cannot overwrite this account', t => {
  const left = isolated(t), right = isolated(t)
  assert.throws(() => right.store.save(left.state), error => error.code === 'WORKSPACE_SNAPSHOT_REQUIRED')
})

test('understanding computed against replaced evidence is rejected instead of cached as current', t => {
  const { store } = isolated(t)
  const understanding = read(store), replacement = read(store)
  replacement.evidences[0].ocrText = 'replacement text'
  replacement.evidences[0].summaryText = undefined
  replacement.evidences[0].summaryCacheKey = undefined
  store.save(replacement)
  understanding.evidences[0].summaryText = 'stale result'
  assert.throws(() => store.save(understanding), error => error.code === 'WORKSPACE_CONFLICT')
  assert.equal(read(store).evidences[0].ocrText, 'replacement text')
})

test('links calculated against edited sentences are rejected', t => {
  const { store } = isolated(t)
  const linking = read(store), editing = read(store)
  editing.certificates[0].paragraphs[0].text = 'Changed sentence.'
  store.save(editing)
  linking.certificates[0].paragraphs[0].links[0].quote = 'new link quote'
  assert.throws(() => store.save(linking), error => error.code === 'WORKSPACE_CONFLICT')
})

test('delete cannot silently discard newly completed understanding', t => {
  const { store } = isolated(t)
  const deletion = read(store), understanding = read(store)
  deletion.cases = []
  deletion.evidences = []
  deletion.evidenceInsights = []
  deletion.caseContextMemories = []
  deletion.certificates = []
  understanding.evidenceInsights[0].summary = 'new completed understanding'
  store.save(understanding)
  assert.throws(() => store.save(deletion), error => error.code === 'WORKSPACE_CONFLICT')
  assert.equal(read(store).cases.length, 1)
})

test('foreign keys enforce sentence-link ownership and normal case deletion succeeds', t => {
  const { store, state } = isolated(t)
  state.cases = []
  state.evidences = []
  state.evidenceInsights = []
  state.caseContextMemories = []
  state.certificates = []
  store.save(state)
  assert.equal(read(store).certificates.length, 0)
  const db = new DatabaseSync(store.databasePath)
  try { assert.equal(db.prepare('SELECT count(*) AS n FROM evidence_links').get().n, 0) }
  finally { db.close() }
})

test('failed migration rolls back without marking an empty workspace initialized', t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lawverify-sqlite-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const store = new WorkspaceSqliteStore(dir)
  const invalid = fixture()
  invalid.evidences.push({ ...invalid.evidences[0] })
  assert.throws(() => store.read(() => invalid), /Duplicate record ID/)
  const db = new DatabaseSync(store.databasePath)
  try {
    assert.equal(db.prepare("SELECT value FROM workspace_meta WHERE key = 'initialized'").get(), undefined)
    assert.equal(db.prepare('SELECT count(*) AS n FROM cases').get().n, 0)
  } finally { db.close() }
  assert.equal(store.read(fixture).cases.length, 1)
})

test('historical repeated public match IDs preserve every heuristic and model occurrence', t => {
  const { store, state } = isolated(t)
  const match = {
    id: 'shared-match-id', caseId: 'case', claimUnitId: 'claim',
    evidenceId: 'e1', evidenceFragmentId: 'fragment', relation: 'support', score: 0.9,
    locator: 'original', verified: false,
  }
  state.claimEvidenceMatches = [
    { ...match, source: 'heuristic', reason: 'rule result' },
    { ...match, source: 'model', reason: 'model result' },
    { ...match, source: 'model', reason: 'another historical result' },
  ]
  const expected = structuredClone(state.claimEvidenceMatches)
  store.save(state)
  assert.deepEqual(read(store).claimEvidenceMatches, expected)
  store.save(read(store))
  assert.deepEqual(read(store).claimEvidenceMatches, expected)
  const db = new DatabaseSync(store.databasePath)
  try { assert.equal(db.prepare('SELECT count(*) AS n FROM claim_evidence_matches').get().n, 3) }
  finally { db.close() }
})

test('repeated link and statute IDs on different sentences survive migration and later saves', t => {
  const { store, state } = isolated(t)
  const paragraph = state.certificates[0].paragraphs[0]
  paragraph.links[1].id = paragraph.links[0].id
  paragraph.references.push({ ...paragraph.references[0], sentenceIndex: 0 })
  paragraph.references.push({ ...paragraph.references[0] })
  const expectedLinks = structuredClone(paragraph.links)
  const expectedReferences = structuredClone(paragraph.references)
  store.save(state)
  const reopened = read(store)
  assert.deepEqual(reopened.certificates[0].paragraphs[0].links, expectedLinks)
  assert.deepEqual(reopened.certificates[0].paragraphs[0].references, expectedReferences)
  store.save(reopened)
  assert.deepEqual(read(store).certificates[0].paragraphs[0].references, expectedReferences)
})

test('four real processes can save independent records while readers always see valid snapshots', async t => {
  const { dir, store, state } = isolated(t)
  for (let index = 0; index < 4; index++) {
    state.evidences.push({ ...state.evidences[0], id: `worker-${index}`, sourceDataUrl: undefined, summaryText: '0' })
  }
  store.save(state)
  const code = `
    import { WorkspaceSqliteStore } from './src/infrastructure/workspace-sqlite.ts';
    const store = new WorkspaceSqliteStore(process.argv[1]);
    for (let i = 1; i <= 20; i++) {
      const state = store.read(() => { throw new Error('Unexpected reinitialization') });
      state.evidences.find(e => e.id === 'worker-' + process.argv[2]).summaryText = String(i);
      store.save(state);
    }
  `
  await Promise.all(Array.from({ length: 4 }, (_, index) => worker(code, [dir, String(index)])))
  const result = read(store)
  for (let index = 0; index < 4; index++) {
    assert.equal(result.evidences.find(item => item.id === `worker-${index}`).summaryText, '20')
  }
  const db = new DatabaseSync(store.databasePath)
  try { assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok') }
  finally { db.close() }
})

const integrationCode = `
  import { env } from './src/config/env.ts';
  env.WORKSPACE_DATA_DIR = process.argv[1];
  env.KNOWLEDGE_RAG_MODE = 'local';
  const { readWorkspace, writeWorkspace } = await import('./src/store.ts');
  const state = await readWorkspace();
  if (state.evidences[0]?.summaryCacheKey !== 'original-fingerprint') throw new Error('Fingerprint changed');
  if (state.evidenceInsights[0]?.version !== 4) throw new Error('Understanding version changed');
  if (state.certificates[0].paragraphs[0].links.length !== 2) throw new Error('Sentence links changed');
  state.cases[0].name = 'after migration';
  await writeWorkspace(state);
  if ((await readWorkspace()).cases[0].name !== 'after migration') throw new Error('Save failed');
`

test('real store entry point migrates once, leaves both JSON files untouched, and ignores stale JSON later', async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lawverify-sqlite-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const json = JSON.stringify(fixture())
  writeFileSync(path.join(dir, 'workspace.json'), json)
  writeFileSync(path.join(dir, 'workspace.backup.json'), json)
  await worker(integrationCode, [dir])
  assert.equal(readFileSync(path.join(dir, 'workspace.json'), 'utf8'), json)
  assert.equal(readFileSync(path.join(dir, 'workspace.backup.json'), 'utf8'), json)
  writeFileSync(path.join(dir, 'workspace.json'), '{broken')
  await worker(integrationCode, [dir])
  assert.equal(new WorkspaceSqliteStore(dir).read(fixture).cases[0].name, 'after migration')
})

test('real store migration recovers from backup without overwriting a corrupt primary JSON', async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lawverify-sqlite-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(path.join(dir, 'workspace.json'), '{broken')
  writeFileSync(path.join(dir, 'workspace.backup.json'), JSON.stringify(fixture()))
  await worker(integrationCode, [dir])
  assert.equal(readFileSync(path.join(dir, 'workspace.json'), 'utf8'), '{broken')
  const db = new DatabaseSync(path.join(dir, 'workspace.sqlite'))
  try {
    assert.ok(db.prepare("SELECT value FROM workspace_meta WHERE key = 'migration_source'").get().value.endsWith('workspace.backup.json'))
  } finally { db.close() }
})

test('corrupt primary and backup never initialize an empty workspace', async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lawverify-sqlite-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(path.join(dir, 'workspace.json'), '{broken')
  writeFileSync(path.join(dir, 'workspace.backup.json'), '{broken')
  await assert.rejects(worker(integrationCode, [dir]), /已阻止自动重置/)
  const db = new DatabaseSync(path.join(dir, 'workspace.sqlite'))
  try {
    assert.equal(db.prepare("SELECT value FROM workspace_meta WHERE key = 'initialized'").get(), undefined)
  } finally { db.close() }
})
