import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const [sourceDirectory, outputDirectory, ...selectedDatabases] = process.argv.slice(2)
if (!sourceDirectory || !outputDirectory) {
  throw new Error('Usage: node generate-incremental-backup.mjs SOURCE_DIRECTORY OUTPUT_DIRECTORY [DATABASE ...]')
}
if (fs.existsSync(outputDirectory)) {
  throw new Error('Output directory already exists; refusing to overwrite files.')
}
const databases = selectedDatabases.length ? selectedDatabases : ['lawverify', 'crm', 'lobechat']
if (databases.some(db => !['lawverify', 'crm', 'lobechat'].includes(db)) || new Set(databases).size !== databases.length) {
  throw new Error('Only distinct lawverify, crm and lobechat database names are supported.')
}

const literal = (value) => `'${value.replaceAll("'", "''")}'`
const identifier = (value) => `"${value.replaceAll('"', '""')}"`
const qualifiedPattern = String.raw`(?:"(?:[^"]|"")+"|[a-zA-Z_][a-zA-Z_0-9]*)(?:\.(?:"(?:[^"]|"")+"|[a-zA-Z_][a-zA-Z_0-9]*))?`
const q = qualifiedPattern
let blockNumber = 0
const block = (body) => {
  const tag = `$lv_import_${blockNumber++}$`
  if (body.includes(tag)) throw new Error('Dollar quote collision')
  return `DO ${tag}\nBEGIN\n${body}\nEND\n${tag};`
}

// COPY payloads are read separately so SQL-like text inside business data is never rewritten.
function parseDump(input) {
  const sql = input.replace(/^\\(?:un)?restrict [a-zA-Z0-9]+\r?$/gm, '')
  const result = []
  let statement = ''
  let state = ''
  for (let i = 0; i < sql.length; i++) {
    const char = sql[i]
    if (state === "'") {
      statement += char
      if (char === "'" && sql[i + 1] === "'") statement += sql[++i]
      else if (char === "'") state = ''
      continue
    }
    if (state === '"') {
      statement += char
      if (char === '"' && sql[i + 1] === '"') statement += sql[++i]
      else if (char === '"') state = ''
      continue
    }
    if (state.startsWith('$')) {
      if (sql.startsWith(state, i)) {
        statement += state
        i += state.length - 1
        state = ''
      } else statement += char
      continue
    }
    if (char === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i)
      if (end === -1) break
      statement += '\n'
      i = end
      continue
    }
    if (char === '/' && sql[i + 1] === '*') {
      throw new Error('Block comments require explicit parser support.')
    }
    if (char === "'" || char === '"') state = char
    else if (char === '$') {
      const tag = sql.slice(i).match(/^\$(?:[a-zA-Z_][a-zA-Z_0-9]*)?\$/)?.[0]
      if (tag) {
        state = tag
        statement += tag
        i += tag.length - 1
        continue
      }
    }
    statement += char
    if (char !== ';' || state) continue
    const text = statement.trim()
    statement = ''
    const copy = text.match(new RegExp(`^COPY (${q}) \\(([^\\n]+)\\) FROM stdin;$`))
    if (copy) {
      let start = i + 1
      if (sql[start] === '\r') start++
      if (sql[start] !== '\n') throw new Error('COPY header must end with a newline.')
      start++
      const terminator = /^\\\.\r?$/gm
      terminator.lastIndex = start
      const end = terminator.exec(sql)
      if (!end) throw new Error('Incomplete COPY payload.')
      const payload = sql.slice(start, end.index)
      result.push({ kind: 'copy', table: copy[1], columns: copy[2], payload })
      i = end.index + end[0].length - 1
    } else result.push({ kind: 'sql', text })
  }
  if (state || statement.trim()) throw new Error('Incomplete SQL statement.')
  return result
}

function describe(db, items) {
  const model = { db, schemas: [], extensions: [], types: [], tables: new Map(),
    sequences: [], defaults: [], ownership: [], constraints: [], indexes: [], copies: [], foreignKeys: [] }
  for (const item of items) {
    if (item.kind === 'copy') {
      model.copies.push(item)
      continue
    }
    const s = item.text
    let match
    if (/^(SET |SELECT pg_catalog\.set_config\(|COMMENT ON )/.test(s)) continue
    if (/^SELECT pg_catalog\.setval\(/.test(s)) continue
    if ((match = s.match(new RegExp(`^CREATE SCHEMA (${q});$`)))) model.schemas.push(match[1])
    else if (/^CREATE EXTENSION IF NOT EXISTS [a-z_]+ WITH SCHEMA [a-z_]+;$/.test(s)) model.extensions.push(s)
    else if ((match = s.match(new RegExp(`^CREATE TYPE (${q}) AS ENUM \\([\\s\\S]*\\);$`)))) model.types.push({ name: match[1], sql: s })
    else if ((match = s.match(new RegExp(`^CREATE TABLE (${q}) (\\([\\s\\S]*\\));$`)))) {
      model.tables.set(match[1], { name: match[1], body: match[2], sql: s })
    } else if ((match = s.match(new RegExp(`^CREATE SEQUENCE (${q})\\s`)))) model.sequences.push({ name: match[1], sql: s })
    else if ((match = s.match(new RegExp(`^ALTER SEQUENCE (${q}) OWNED BY (${q})\\.`)))) model.ownership.push({ sequence: match[1], table: match[2], sql: s })
    else if ((match = s.match(new RegExp(`^ALTER TABLE ONLY (${q})\\s+ALTER COLUMN [\\s\\S]+ SET DEFAULT `)))) model.defaults.push({ table: match[1], sql: s })
    else if ((match = s.match(new RegExp(`^ALTER TABLE ONLY (${q})\\s+ADD CONSTRAINT `)))) {
      const constraint = { table: match[1], sql: s, foreign: /\bFOREIGN KEY\b/.test(s) }
      model.constraints.push(constraint)
      if (constraint.foreign) {
        const fk = s.match(new RegExp(`FOREIGN KEY \\(([^)]+)\\) REFERENCES (${q})\\(([^)]+)\\)`))
        if (!fk || /\bMATCH (?:FULL|PARTIAL)\b/.test(s)) throw new Error(`Unsupported foreign key in ${db}`)
        model.foreignKeys.push({ child: match[1], childColumns: fk[1].split(',').map(v => v.trim()),
          parent: fk[2], parentColumns: fk[3].split(',').map(v => v.trim()) })
      }
    } else if ((match = s.match(new RegExp(`^CREATE (?:UNIQUE )?INDEX (${q}) ON (${q}) `)))) model.indexes.push({ table: match[2], sql: s })
    else throw new Error(`Unsupported SQL object in ${db}: ${s.slice(0, 160)}`)
  }
  if (model.tables.size !== model.copies.length) throw new Error(`Table/COPY mismatch in ${db}`)
  for (const [i, copy] of model.copies.entries()) {
    const table = model.tables.get(copy.table)
    if (!table) throw new Error(`Missing table definition: ${copy.table}`)
    Object.assign(table, { stage: `_lv_stage_${i}`, added: `_lv_added_${i}`, columns: copy.columns })
  }
  return model
}

function build(model) {
  const { db, tables } = model
  const key = crypto.randomBytes(24).toString('hex')
  const output = [
    '-- Incremental import: no business-table DELETE, TRUNCATE, DROP or UPDATE.',
    '-- Duplicate primary/unique keys retain the target row. Any error rolls back the transaction.',
    '\\set ON_ERROR_STOP on', `\\restrict ${key}`, 'BEGIN;',
    "SET LOCAL statement_timeout = 0;", "SET LOCAL lock_timeout = '30s';",
    "SET LOCAL row_security = off;", "SET LOCAL client_encoding = 'UTF8';",
    "SET LOCAL standard_conforming_strings = on;",
    block(`  IF current_database() <> ${literal(db)} THEN
    RAISE EXCEPTION 'Wrong target database; expected ${db}';
  END IF;`),
    `SELECT pg_advisory_xact_lock(hashtext(${literal(`lawverify-incremental-import:${db}`)}));`,
    'CREATE TEMP TABLE _lv_targets (table_name text PRIMARY KEY, existed boolean NOT NULL, stage_name text NOT NULL, added_name text NOT NULL, columns_sql text NOT NULL, imported boolean NOT NULL DEFAULT false) ON COMMIT DROP;',
    'CREATE TEMP TABLE _lv_summary (table_name text, created_table boolean, backup_rows bigint, inserted_rows bigint, skipped_rows bigint) ON COMMIT DROP;',
    'CREATE TEMP TABLE _lv_sequences (sequence_name text PRIMARY KEY, existed boolean NOT NULL) ON COMMIT DROP;',
  ]
  for (const table of tables.values()) {
    output.push(`INSERT INTO pg_temp._lv_targets VALUES (${literal(table.name)}, to_regclass(${literal(table.name)}) IS NOT NULL, ${literal(table.stage)}, ${literal(table.added)}, ${literal(table.columns)}, false);`)
  }
  for (const seq of model.sequences) {
    output.push(`INSERT INTO pg_temp._lv_sequences VALUES (${literal(seq.name)}, to_regclass(${literal(seq.name)}) IS NOT NULL);`)
  }
  for (const schema of model.schemas) output.push(`CREATE SCHEMA IF NOT EXISTS ${schema};`)
  output.push(...model.extensions)
  for (const type of model.types) {
    output.push(block(`  IF to_regtype(${literal(type.name)}) IS NULL THEN\n    ${type.sql}\n  END IF;`))
  }
  for (const table of tables.values()) output.push(`CREATE TABLE IF NOT EXISTS ${table.name} ${table.body};`)
  for (const seq of model.sequences) output.push(seq.sql.replace(/^CREATE SEQUENCE /, 'CREATE SEQUENCE IF NOT EXISTS '))
  const onlyNew = (table, sql) => block(`  IF NOT (SELECT existed FROM pg_temp._lv_targets WHERE table_name = ${literal(table)}) THEN\n    ${sql}\n  END IF;`)
  for (const own of model.ownership) {
    output.push(block(`  IF NOT (SELECT existed FROM pg_temp._lv_sequences WHERE sequence_name = ${literal(own.sequence)})
    AND NOT (SELECT existed FROM pg_temp._lv_targets WHERE table_name = ${literal(own.table)}) THEN
    ${own.sql}
  END IF;`))
  }
  for (const d of model.defaults) output.push(onlyNew(d.table, d.sql))
  output.push(`LOCK TABLE ${[...tables.keys()].join(', ')} IN SHARE ROW EXCLUSIVE MODE;`)
  for (const c of model.constraints.filter(c => !c.foreign)) output.push(onlyNew(c.table, c.sql))
  for (const idx of model.indexes) output.push(onlyNew(idx.table, idx.sql))
  for (const table of tables.values()) {
    output.push(`CREATE TEMP TABLE ${identifier(table.stage)} ${table.body} ON COMMIT DROP;`)
    output.push(`CREATE TEMP TABLE ${identifier(table.added)} (LIKE pg_temp.${identifier(table.stage)}) ON COMMIT DROP;`)
    output.push(block(`  IF EXISTS (
    SELECT 1 FROM pg_attribute s
    LEFT JOIN pg_attribute t ON t.attrelid = ${literal(table.name)}::regclass AND t.attname = s.attname AND NOT t.attisdropped
    WHERE s.attrelid = 'pg_temp.${table.stage}'::regclass AND s.attnum > 0 AND NOT s.attisdropped
      AND (t.attname IS NULL OR t.atttypid <> s.atttypid OR t.atttypmod <> s.atttypmod
        OR t.attcollation <> s.attcollation OR t.attgenerated <> s.attgenerated OR t.attidentity <> s.attidentity)
  ) THEN RAISE EXCEPTION 'Incompatible column structure: %', ${literal(table.name)}; END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = ${literal(table.name)}::regclass AND NOT tgisinternal AND tgenabled <> 'D') THEN
    RAISE EXCEPTION 'User triggers require manual review before import: %', ${literal(table.name)};
  END IF;`))
  }
  for (const copy of model.copies) {
    const table = tables.get(copy.table)
    const newline = copy.payload.includes('\r\n') ? '\r\n' : '\n'
    output.push(`COPY pg_temp.${identifier(table.stage)} (${copy.columns}) FROM stdin;${newline}${copy.payload}\\.${newline}`)
  }
  if (db === 'lawverify') {
    const ledger = tables.get('public.point_ledger_entries')
    // Merging new ledger entries into an existing balance snapshot needs accounting reconciliation.
    output.push(block(`  IF EXISTS (
    SELECT 1 FROM pg_temp.${identifier(ledger.stage)} s
    JOIN public.point_accounts a ON a.organization_id = s.organization_id AND a.user_id = s.commercial_user_id
    WHERE NOT EXISTS (SELECT 1 FROM public.point_ledger_entries e WHERE e.id = s.id)
  ) THEN
    RAISE EXCEPTION 'Existing point accounts have new backup ledger entries; reconcile accounting before importing';
  END IF;`))
  }
  const mergeTag = '$lv_merge$'
  output.push(`DO ${mergeTag}
DECLARE
  target record; fk record; edge_exists boolean; blocked boolean;
  child_stage text; join_sql text; nonnull_sql text;
  progressed boolean; total_count bigint; inserted_count bigint;
BEGIN
  LOOP
    EXIT WHEN NOT EXISTS (SELECT 1 FROM pg_temp._lv_targets WHERE NOT imported);
    progressed := false;
    FOR target IN SELECT * FROM pg_temp._lv_targets WHERE NOT imported ORDER BY table_name LOOP
      EXECUTE format('SELECT count(*) FROM pg_temp.%I', target.stage_name) INTO total_count;
      blocked := false;
      IF total_count > 0 THEN
        IF NOT EXISTS (SELECT 1 FROM pg_index WHERE indrelid = to_regclass(target.table_name) AND indisunique AND indisvalid AND indpred IS NULL AND indimmediate AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conindid = indexrelid AND contype = 'x')) THEN
          RAISE EXCEPTION 'No usable unique key for idempotent import: %', target.table_name;
        END IF;
        FOR fk IN
          SELECT c.*, p.stage_name AS parent_stage FROM pg_constraint c
          JOIN pg_temp._lv_targets p ON to_regclass(p.table_name) = c.confrelid AND NOT p.imported
          WHERE c.contype = 'f' AND c.conrelid = to_regclass(target.table_name) AND c.confrelid <> c.conrelid
        LOOP
          SELECT string_agg(format('c.%I = p.%I', ca.attname, pa.attname), ' AND ' ORDER BY ck.n),
                 string_agg(format('c.%I IS NOT NULL', ca.attname), ' AND ' ORDER BY ck.n)
          INTO join_sql, nonnull_sql
          FROM unnest(fk.conkey) WITH ORDINALITY ck(k,n)
          JOIN unnest(fk.confkey) WITH ORDINALITY pk(k,n) USING (n)
          JOIN pg_attribute ca ON ca.attrelid = fk.conrelid AND ca.attnum = ck.k
          JOIN pg_attribute pa ON pa.attrelid = fk.confrelid AND pa.attnum = pk.k;
          EXECUTE format('SELECT EXISTS (SELECT 1 FROM pg_temp.%I c WHERE %s AND NOT EXISTS (SELECT 1 FROM %s p WHERE %s))',
            target.stage_name, nonnull_sql, fk.confrelid::regclass, join_sql) INTO edge_exists;
          IF edge_exists THEN blocked := true; EXIT; END IF;
        END LOOP;
      END IF;
      IF blocked THEN CONTINUE; END IF;
      EXECUTE format('WITH inserted AS (INSERT INTO %s (%s) SELECT %s FROM pg_temp.%I ON CONFLICT DO NOTHING RETURNING %s) INSERT INTO pg_temp.%I SELECT * FROM inserted',
        target.table_name, target.columns_sql, target.columns_sql, target.stage_name, target.columns_sql, target.added_name);
      GET DIAGNOSTICS inserted_count = ROW_COUNT;
      INSERT INTO pg_temp._lv_summary VALUES (target.table_name, NOT target.existed, total_count, inserted_count, total_count - inserted_count);
      UPDATE pg_temp._lv_targets SET imported = true WHERE table_name = target.table_name;
      progressed := true;
    END LOOP;
    IF NOT progressed THEN
      RAISE EXCEPTION 'Unresolved foreign-key dependency cycle; no changes committed';
    END IF;
  END LOOP;
END
${mergeTag};`)
  for (const fk of model.foreignKeys) {
    const added = tables.get(fk.child)?.added
    if (!added || fk.childColumns.length !== fk.parentColumns.length) throw new Error('Unsupported FK mapping')
    const nonnull = fk.childColumns.map(c => `c.${c} IS NOT NULL`).join(' AND ')
    const join = fk.childColumns.map((c, i) => `c.${c} = p.${fk.parentColumns[i]}`).join(' AND ')
    output.push(block(`  IF EXISTS (SELECT 1 FROM pg_temp.${identifier(added)} c WHERE ${nonnull}
    AND NOT EXISTS (SELECT 1 FROM ${fk.parent} p WHERE ${join})) THEN
    RAISE EXCEPTION 'Imported rows have unresolved references: % -> %', ${literal(fk.child)}, ${literal(fk.parent)};
  END IF;`))
  }
  for (const c of model.constraints.filter(c => c.foreign)) output.push(onlyNew(c.table, c.sql))
  output.push(`DO $lv_sequences$
DECLARE
  col record; sequence_name text; maximum_value bigint; old_value bigint; old_called boolean;
BEGIN
  FOR col IN
    SELECT t.table_name, a.attname FROM pg_temp._lv_targets t
    JOIN pg_attribute a ON a.attrelid = to_regclass(t.table_name) AND a.attnum > 0 AND NOT a.attisdropped
    JOIN pg_temp._lv_summary s USING (table_name)
    WHERE s.inserted_rows > 0
  LOOP
    sequence_name := pg_get_serial_sequence(col.table_name, col.attname);
    IF sequence_name IS NULL THEN CONTINUE; END IF;
    EXECUTE format('SELECT max(%I)::bigint FROM %s', col.attname, col.table_name) INTO maximum_value;
    EXECUTE format('SELECT last_value, is_called FROM %s', sequence_name) INTO old_value, old_called;
    IF maximum_value IS NOT NULL AND (maximum_value > old_value OR (maximum_value = old_value AND NOT old_called)) THEN
      PERFORM pg_catalog.setval(sequence_name::regclass, maximum_value, true);
    END IF;
  END LOOP;
END
$lv_sequences$;`)
  output.push('SELECT table_name, created_table, backup_rows, inserted_rows, skipped_rows FROM pg_temp._lv_summary ORDER BY table_name;')
  output.push('COMMIT;', `\\unrestrict ${key}`, '')
  return output.join('\n\n')
}

const artifacts = []
for (const db of databases) {
  const source = fs.readFileSync(path.join(sourceDirectory, `${db}.sql`), 'utf8')
  const model = describe(db, parseDump(source))
  const sql = build(model)
  artifacts.push({ db, sql, tables: model.tables.size,
    sourceSha256: crypto.createHash('sha256').update(source).digest('hex'),
    sha256: crypto.createHash('sha256').update(sql).digest('hex') })
}
fs.mkdirSync(outputDirectory)
for (const artifact of artifacts) {
  fs.writeFileSync(path.join(outputDirectory, `${artifact.db}-incremental.sql`), artifact.sql, { flag: 'wx' })
}
fs.writeFileSync(path.join(outputDirectory, 'SHA256SUMS.txt'),
  artifacts.map(a => `${a.sha256}  ${a.db}-incremental.sql`).join('\n') + '\n', { flag: 'wx' })
console.log(JSON.stringify(artifacts.map(({ sql, ...a }) => a), null, 2))
