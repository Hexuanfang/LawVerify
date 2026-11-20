import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const prototypePath = 'docs/lawverify-视觉交付/src/data/cases.js';
const prototypeUrl = new URL(`../../../${prototypePath}`, import.meta.url);
const output = new URL('./fixtures/seed/', import.meta.url);
const args = process.argv.slice(2);
if (args.length > 1 || (args.length && args[0] !== '--check')) {
  throw new Error('用法：node server/eval/verification/freeze-seed.mjs [--check]');
}

const prototypeText = (await readFile(prototypeUrl, 'utf8')).replace(/\r\n/g, '\n');
const { CASES } = await import(prototypeUrl.href);
const documents = [];
const expected = [];
const sources = [];

for (const { mats, els, docs, docNames, ...caseContext } of CASES) {
  const excerpts = new Map();
  const freezeSource = ({ st, name, loc, excerpt, match, main }) => {
    const key = JSON.stringify([st, name, loc, excerpt]);
    if (!excerpts.has(key)) {
      excerpts.set(key, { id: `S${excerpts.size + 1}`, st, name, loc, excerpt });
    }
    return { sourceId: excerpts.get(key).id, match, main };
  };

  for (const docKey of docs) {
    const document = { id: `${caseContext.id}-${docKey}`, caseId: caseContext.id, docKey, title: docNames[docKey], paragraphs: [] };
    documents.push(document);
    for (const { sources: cited, verifiedSources = [], alignmentDiagnostic, ...record } of els[docKey]) {
      const paragraphIndex = alignmentDiagnostic ? null : document.paragraphs.length;
      if (!alignmentDiagnostic) document.paragraphs.push(record.quote);
      expected.push({
        documentId: document.id,
        paragraphIndex,
        purpose: alignmentDiagnostic ? 'alignment-diagnostic' : record.verdict === 'pending' ? 'pending-placeholder' : 'declaration',
        ...record,
        sourceMatches: cited.map(freezeSource),
        suggestedSourceMatches: verifiedSources.map(freezeSource),
      });
    }
  }
  sources.push({ caseId: caseContext.id, caseContext, materials: mats, excerpts: [...excerpts.values()] });
}

const provenance = { version: 1, prototypePath, normalizedSha256: createHash('sha256').update(prototypeText).digest('hex') };
const check = args[0] === '--check';
if (!check) await mkdir(output, { recursive: true });
for (const [name, value] of Object.entries({ documents, expected, sources, provenance })) {
  const target = new URL(`${name}.json`, output);
  const json = `${JSON.stringify(value, null, 2)}\n`;
  if (check) {
    if ((await readFile(target, 'utf8')).replace(/\r\n/g, '\n') !== json) throw new Error(`种子快照与原型不一致：${name}.json`);
  } else {
    await writeFile(target, json);
  }
}
console.log(`种子${check ? '追溯校验' : '冻结'}：${documents.length} 份文书，${expected.length} 条原始标注。`);
