import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const readFixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/seed/${name}.json`, import.meta.url), 'utf8'));

test('冻结的种子保留 11 份文书、36 条原始标注及可回查锚点', () => {
  const documents = readFixture('documents');
  const expected = readFixture('expected');
  const sources = readFixture('sources');
  assert.equal(documents.length, 11);
  assert.equal(new Set(documents.map((document) => document.id)).size, 11);
  assert.equal(expected.length, 36);
  assert.equal(new Set(expected.map((record) => record.id)).size, 36);
  assert.equal(expected.filter((record) => record.documentId.startsWith('c1-')).length, 32);
  assert.equal(expected.filter((record) => record.documentId.startsWith('c2-')).length, 4);

  for (const document of documents) {
    assert.deepEqual(Object.keys(document).sort(), ['caseId', 'docKey', 'id', 'paragraphs', 'title']);
    const records = expected.filter((record) => record.documentId === document.id);
    assert.ok(records.length > 0, document.id);
    assert.deepEqual(document.paragraphs, records.filter((record) => record.purpose !== 'alignment-diagnostic').map((record) => record.quote));
    const caseSources = sources.find((entry) => entry.caseId === document.caseId);
    assert.ok(caseSources, document.id);
    for (const record of records) {
      assert.ok(['pass', 'note', 'warn', 'fail', 'miss', 'pending'].includes(record.verdict), record.id);
      if (record.paragraphIndex === null) assert.equal(record.purpose, 'alignment-diagnostic');
      else assert.equal(document.paragraphs[record.paragraphIndex], record.quote, record.id);
      for (const link of [...record.sourceMatches, ...record.suggestedSourceMatches]) {
        assert.ok(caseSources.excerpts.some((excerpt) => excerpt.id === link.sourceId), record.id);
      }
      if (record.dependsOn) assert.ok(records.some((item) => item.id === record.dependsOn.id), record.id);
    }
  }

  assert.deepEqual(expected.filter((record) => record.purpose === 'pending-placeholder').map((record) => [record.id, record.type, record.verdict]), [
    ['c1-zs', 'E-ERR', 'pending'], ['c1-lsh', 'E-CLAIM', 'pending'],
    ['c1-flyj', 'E-FOCUS', 'pending'], ['c1-cx', 'E-PROC', 'pending'],
  ]);
  assert.deepEqual(expected.filter((record) => record.paragraphIndex === null).map((record) => record.id), ['c1-z4']);
  assert.equal(expected.find((record) => record.id === 'c1-l3').verdict, 'pass');
  assert.equal(expected.find((record) => record.id === 'c1-s4').type, 'E-CLAIM');
  assert.ok(sources.every((entry) => entry.excerpts.every((excerpt) => !('match' in excerpt) && !('main' in excerpt))));
  const supplements = readFixture('supplements');
  for (const supplement of supplements) {
    assert.ok(documents.some((document) => document.id === supplement.documentId && document.caseId === supplement.caseId));
    assert.match(supplement.kind, /^controlled-/);
  }
  const repealed = supplements.find((item) => item.kind === 'controlled-statute-detail');
  assert.equal(repealed.status, 'repealed');
  assert.equal(repealed.text, null, '替代条文不得作为原条文');
});

test('受控用例覆盖 ADV-01–12、R1–R10 及彼此独立的服务失败语义', () => {
  const { adversarial, regressions } = JSON.parse(readFileSync(new URL('./fixtures/controlled.json', import.meta.url), 'utf8'));
  assert.deepEqual(adversarial.map((item) => item.id), Array.from({ length: 12 }, (_, index) => `ADV-${String(index + 1).padStart(2, '0')}`));
  const cases = [...adversarial, ...regressions];
  assert.equal(new Set(cases.map((item) => item.id)).size, cases.length);
  assert.deepEqual([...new Set(cases.flatMap((item) => item.redlines))].sort(), ['R1', 'R10', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9']);
  for (const item of cases) {
    assert.ok(Object.keys(item.input).length && Object.keys(item.expected).length, item.id);
  }
  for (const [id, outcome, verdict] of [
    ['ADV-02', 'authoritative-not-found', 'fail'], ['ADV-10', 'timeout', 'pending'],
    ['TOOL-EMPTY', 'empty-response', 'pending'], ['TOOL-NO-HITS', 'search-zero-results', 'pending'], ['TOOL-403', 'forbidden', 'pending'],
  ]) {
    const item = cases.find((entry) => entry.id === id);
    assert.equal(item.input.provider.outcome, outcome);
    assert.equal(item.expected.verdict, verdict);
    assert.equal(item.expected.allowCitation, false);
  }
});
