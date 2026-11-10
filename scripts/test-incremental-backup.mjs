import fs from 'node:fs'
import path from 'node:path'
import cp from 'node:child_process'

const [backupDirectory, container = 'lawverify-pg16-incremental-test-20261105', ...selectedDatabases] = process.argv.slice(2)
if (!backupDirectory) throw new Error('Provide the PostgreSQL 16.14 backup directory.')
if (!/^lawverify-pg16-incremental-test-/.test(container)) throw new Error('Only dedicated incremental-test containers are allowed.')
const databases = selectedDatabases.length ? selectedDatabases : ['lawverify', 'crm']
if (databases.some(db => !['lawverify', 'crm'].includes(db))) throw new Error('Only LawVerify and CRM are supported by this test runner.')
const results = []

function execute(args, allowFailure = false) {
  const r = cp.spawnSync('wsl.exe', ['-d', 'Ubuntu', '-u', 'root', '--exec', 'docker', 'exec', container, ...args], {
    encoding: 'utf8', timeout: 120000, maxBuffer: 16777216,
  })
  if (r.error) throw r.error
  if (r.status !== 0 && !allowFailure) throw new Error(r.stderr)
  return r
}
const query = (db, sql) => execute(['psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', db, '-c', sql]).stdout.trim()
const file = (db, name, allowFailure = false) => execute([
  'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', db, '-f', `/backups/${name}`,
], allowFailure)
const literal = (value) => `'${value.replaceAll("'", "''")}'`
function snapshot(db) {
  const names = query(db, "SELECT format('%I.%I', schemaname, relname) FROM pg_stat_user_tables ORDER BY schemaname,relname").split('\n').filter(Boolean)
  return Object.fromEntries(names.map(name => [name, query(db, `SELECT count(*)::text || ':' || md5(coalesce(string_agg(h, '' ORDER BY h), '')) FROM (SELECT md5(row_to_json(t)::text) AS h FROM ${name} t) x`)]))
}
function assertEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(message)
}
function merge(db, allowFailure = false) {
  return file(db, `incremental/${db}-incremental.sql`, allowFailure)
}
function recreate(db) {
  execute(['dropdb', '-U', 'postgres', '--if-exists', db])
  execute(['createdb', '-U', 'postgres', db])
}
function checkCounts(db) {
  const expected = JSON.parse(fs.readFileSync(path.join(backupDirectory, 'expected-row-counts.json'), 'utf8'))[db]
  for (const [table, count] of Object.entries(expected)) {
    if (Number(query(db, `SELECT count(*) FROM ${table}`)) !== count) throw new Error(`Unexpected count in ${db}.${table}`)
  }
  return Object.keys(expected).length
}
function assertNoMutationOnError(db, expectedMessage) {
  const before = snapshot(db)
  const r = merge(db, true)
  if (r.status === 0 || !r.stderr.includes(expectedMessage)) {
    throw new Error(`Expected guarded rollback in ${db}: ${expectedMessage}; ${r.stderr.slice(0, 400)}`)
  }
  assertEqual(snapshot(db), before, `${db}: failed import changed target data`)
}

console.log(query('postgres', 'SHOW server_version'))
for (const db of databases) {
  recreate(db)
  merge(db)
  const tableCount = checkCounts(db)
  const emptyResult = { database: db, scenario: 'empty-database-create-and-import', tables: tableCount, pass: true }
  results.push(emptyResult)
  console.log(JSON.stringify(emptyResult))

  const first = snapshot(db)
  merge(db)
  assertEqual(snapshot(db), first, `${db}: repeated import changed rows`)
  results.push({ database: db, scenario: 'repeat-import-idempotent', pass: true })

  const userTable = db === 'lawverify' ? 'public.users' : 'public."user"'
  query(db, `UPDATE ${userTable} SET name = 'TARGET_KEEP_MARKER' WHERE id = (SELECT id FROM ${userTable} ORDER BY id LIMIT 1)`)
  if (db === 'lawverify') {
    query(db, "INSERT INTO public.users (id,email,name) VALUES ('00000000-0000-4000-8000-00000000f001','target-only@example.invalid','TARGET_ONLY')")
    query(db, "INSERT INTO public.schema_migrations (id,file_name) VALUES (100000,'__target_only_migration__')")
  } else {
    query(db, 'INSERT INTO public."user" (id,name,email,"createdAt","updatedAt") VALUES (\'target-only-id\',\'TARGET_ONLY\',\'target-only@example.invalid\',now(),now())')
  }
  const before = snapshot(db)
  merge(db)
  assertEqual(snapshot(db), before, `${db}: existing rows were overwritten or removed`)
  results.push({ database: db, scenario: 'retain-modified-and-target-only-records', pass: true })

  if (db === 'lawverify') {
    query(db, 'DROP TABLE public.user_feedback')
    merge(db)
    assertEqual(snapshot(db), before, 'Missing feedback table was not correctly recreated')
    results.push({ database: db, scenario: 'existing-database-create-missing-table', pass: true })
    query(db, 'DELETE FROM public.point_ledger_entries WHERE id = (SELECT id FROM public.point_ledger_entries e WHERE NOT EXISTS (SELECT 1 FROM public.point_ledger_entries r WHERE r.related_entry_id=e.id) AND e.commercial_user_id IS NOT NULL ORDER BY e.created_at DESC LIMIT 1)')
    assertNoMutationOnError(db, 'reconcile accounting')
    results.push({ database: db, scenario: 'accounting-conflict-rolls-back', pass: true })
  }
  console.log(JSON.stringify({ database: db, completed: true }))
}

// Build an existing empty schema, then exercise a unique email with a different user ID.
for (const db of databases) {
  recreate(db)
  file(db, `${db}.sql`)
  const tables = query(db, "SELECT format('%I.%I', schemaname,relname) FROM pg_stat_user_tables ORDER BY schemaname,relname").split('\n').filter(Boolean)
  query(db, `TRUNCATE ${tables.join(', ')} CASCADE`)
  merge(db)
  checkCounts(db)
  results.push({ database: db, scenario: 'existing-empty-schema-import', pass: true })
}

if (databases.includes('lawverify')) {
  query('lawverify', 'ALTER TABLE public.users ALTER COLUMN name TYPE varchar(256)')
  assertNoMutationOnError('lawverify', 'Incompatible column structure')
  results.push({ database: 'lawverify', scenario: 'schema-conflict-rolls-back', pass: true })

  recreate('lawverify')
  file('lawverify', 'lawverify.sql')
  const email = query('lawverify', 'SELECT email FROM public.users ORDER BY id LIMIT 1')
  query('lawverify', `TRUNCATE ${Object.keys(snapshot('lawverify')).join(', ')} CASCADE`)
  query('lawverify', `INSERT INTO public.users (id,email,name) VALUES ('00000000-0000-4000-8000-00000000f002',${literal(email)},'TARGET_EXISTING_EMAIL')`)
  assertNoMutationOnError('lawverify', 'violates foreign key constraint')
  results.push({ database: 'lawverify', scenario: 'unique-key-with-different-parent-id-rolls-back', pass: true })
}

const report = { serverVersion: query('postgres', 'SHOW server_version'), results,
  databases,
  originalDatabasesModified: false }
fs.writeFileSync(path.join(backupDirectory, 'incremental', 'validation-results.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
