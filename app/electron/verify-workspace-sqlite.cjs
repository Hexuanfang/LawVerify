const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { existsSync, mkdtempSync, readFileSync, rmSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const appRoot = path.resolve(__dirname, '..')
const modulePath = path.join(appRoot, '.desktop', 'server', 'dist', 'infrastructure', 'workspace-sqlite.js')
assert.ok(existsSync(modulePath), 'Run build:server and prepare:desktop before verifying SQLite')
const runtime = require('electron')
const dir = mkdtempSync(path.join(os.tmpdir(), 'lawverify-electron-workspace-'))
const output = path.join(dir, 'result.json')

const script = `
  import { writeFileSync } from 'node:fs';
  import { WorkspaceSqliteStore } from ${JSON.stringify(pathToFileURL(modulePath).href)};
  const store = new WorkspaceSqliteStore(${JSON.stringify(dir)});
  const initial = {
    user: { id: 'test', points: 10, pointLogs: [] }, cases: [], evidences: [],
    evidenceFragments: [], evidenceInsights: [], caseContextMemories: [], draftMemories: [],
    certificates: [], claimUnits: [], claimEvidenceMatches: [], knowledgeCases: [],
    knowledgeFiles: [], knowledgeStatutes: [], paymentOrders: []
  };
  const state = store.read(() => initial);
  state.cases.push({ id: 'case', name: 'SQLite desktop smoke test' });
  store.save(state);
  const result = store.read(() => { throw new Error('Unexpected reinitialization') });
  if (result.cases[0].name !== 'SQLite desktop smoke test') throw new Error('Desktop save failed');
  writeFileSync(${JSON.stringify(output)}, JSON.stringify({
    electron: process.versions.electron, node: process.versions.node, cases: result.cases.length, ok: true
  }));
`

try {
  const result = spawnSync(runtime, ['--input-type=module', '--eval', script], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    timeout: 30000,
  })
  if (result.error) throw result.error
  assert.equal(result.status, 0, result.stderr || result.stdout || 'Electron SQLite verification failed')
  assert.ok(existsSync(output), 'Electron did not produce a verification result')
  const report = JSON.parse(readFileSync(output, 'utf8'))
  assert.equal(report.ok, true)
  console.log(`Electron ${report.electron} / Node ${report.node}: prepared desktop SQLite read/write passed`)
} finally {
  rmSync(dir, { recursive: true, force: true })
}
