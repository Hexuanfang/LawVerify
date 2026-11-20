import { readFileSync, createReadStream } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import * as policy from '../../src/intelligence/linkage-policy.ts'
import { normalizeDocKey, profile as documentProfile } from '../../src/intelligence/verification/profile.ts'
import { parseModelDeclarationCandidates } from '../../src/intelligence/verification/extract.ts'
import { buildEvidenceFragments } from '../../src/intelligence/evidence-matching.ts'
import { buildEvidenceChunks, buildEvidenceChunkIndex, rankEvidenceChunks, splitEvidenceTextIntoPages } from '../../src/intelligence/evidence-retrieval.ts'
import { parseDocument } from '../../src/infrastructure/document-jobs.ts'
import { boundedFileStorage } from '../../src/middleware/bounded-upload.ts'

const servicePath = new URL('../../src/service.ts', import.meta.url)
export const serviceSha256 = createHash('sha256').update(readFileSync(servicePath)).digest('hex')

// 沿用项目 test-semantic-linkage 的 AST 加载方案，执行原函数而不启动数据库与账户后台任务。
export function loadProductionFunctions(names, bindings = {}) {
  const source = readFileSync(servicePath, 'utf8')
  const ast = ts.createSourceFile('service.ts', source, ts.ScriptTarget.Latest, true)
  const snippets = []
  for (const node of ast.statements) {
    if (ts.isFunctionDeclaration(node) && names.includes(node.name?.text)) snippets.push(node.getText(ast).replace(/^export\s+/, ''))
    if (ts.isVariableStatement(node)) for (const declaration of node.declarationList.declarations) {
      if (names.includes(declaration.name.getText(ast))) snippets.push(`const ${declaration.getText(ast)};`)
    }
  }
  if (snippets.length !== names.length) throw new Error('生产函数签名变化，benchmark 适配器需要检查')
  const context = vm.createContext({ ...policy, normalizeDocKey, documentProfile, parseModelDeclarationCandidates, Buffer, ...bindings })
  vm.runInContext(ts.transpileModule(`${snippets.join('\n')}\nthis.result={${names.join(',')}}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText, context)
  return context.result
}

const linkage = loadProductionFunctions([
  'attachAutoEvidenceLinksToCertificateWithLlm', 'findBestEvidenceFragmentForParagraph', 'getParagraphLinks',
  'getEvidenceFragmentsForEvidence', 'getLatestEvidenceInsight', 'getMeaningfulEvidenceText',
  'isPlaceholderEvidenceText', 'scoreKeywords', 'tokenizeKeywordSource', 'createEvidenceLink',
], {
  AUTO_EVIDENCE_LINK_NOTE: 'system:auto-evidence-linked', createId: () => randomUUID(),
  splitEvidenceTextIntoPages,
  // 富文本与引用排版不属于本次挂接指标，保留生产筛选与定位逻辑。
  normalizeParagraph: p => p, getQuote: text => text.slice(0, 120),
})

export function sampleWorkspace(sample, observedMaterials = sample.materials) {
  const evidences = observedMaterials.map(material => ({ id: material.id, caseId: sample.id,
    number: material.number, name: material.name, fileName: `${material.name}.pdf`, type: 'pdf',
    pages: material.pages.length, uploadedAt: '2026-11-15T00:00:00Z',
    ocrText: material.pages.map((text, i) => `-- 第 ${i + 1}/${material.pages.length} 页 --\n${text}`).join('\n'),
  }))
  const certificate = { id: `${sample.id}-doc`, caseId: sample.id, paragraphs: sample.claims.map(c => ({ id: c.id, text: c.text, links: [] })) }
  const workspace = { evidences, certificates: [certificate], evidenceFragments: buildEvidenceFragments(evidences),
    evidenceInsights: observedMaterials.map(m => ({ evidenceId: m.id, status: 'ready', version: 1, confidence: 0.9,
      materialRole: m.role, summary: '', keyFacts: [] })) }
  return { workspace, certificate, evidences }
}

export function applyProductionLinks(sample, intents, observedMaterials = sample.materials) {
  const { workspace, certificate, evidences } = sampleWorkspace(sample, observedMaterials)
  const analyses = new Map(sample.claims.map(claim => [claim.id, {
    sentenceFocus: policy.normalizeSentenceLinkageFocus(claim.text, [{ sentenceIndex: 0, kind: 'fact',
      priority: 'high', reason: 'benchmark 注入，核验材料防线', evidenceNeeded: true, statuteNeeded: false, caseNeeded: false }]),
    evidenceLinks: intents.filter(i => i.claimId === claim.id).map(i => ({ sentenceIndex: 0,
      evidenceNumber: observedMaterials.find(m => m.id === i.materialId)?.number ?? 'E99',
      quoteHint: i.quote, relation: i.relation, reason: 'benchmark 固定输入，不是模型实测' })),
  }]))
  const result = linkage.attachAutoEvidenceLinksToCertificateWithLlm(workspace, certificate, evidences, analyses)
  return result.paragraphs.flatMap(p => (p.links ?? []).map(link => ({ claimId: p.id,
    materialId: link.evidenceId, relation: link.relation, locator: link.locator, quote: link.quote })))
}

// 检索的是生产 chunk BM25 本身；这是组件指标，不能冒充完整候选编排召回率。
export function measureChunkRetrieval(sample) {
  const indexed = sample.materials.flatMap(m => buildEvidenceChunks(m.pages.map((p, i) => `-- 第 ${i + 1}/${m.pages.length} 页 --\n${p}`).join('\n'))
    .map(chunk => ({ ...chunk, materialId: m.id })))
  const chunks = indexed.map((c, i) => ({ ...c, index: i }))
  const index = buildEvidenceChunkIndex(chunks)
  const results = []
  for (const claim of sample.claims.filter(c => c.expected.length)) {
    const ranked = rankEvidenceChunks(index, [claim.text])
    const ids = [...new Set(ranked.map(r => chunks[r.chunkIndex].materialId))]
    for (const expected of claim.expected) results.push({ claimId: claim.id, materialId: expected.materialId,
      rank: ids.indexOf(expected.materialId) < 0 ? null : ids.indexOf(expected.materialId) + 1 })
  }
  return results
}

export async function parseUploadedFile(filePath, mimeType) {
  const uploaded = await new Promise((resolve, reject) => {
    boundedFileStorage()._handleFile({}, { originalname: path.basename(filePath), mimetype: mimeType,
      stream: createReadStream(filePath) }, (error, info) => error ? reject(error) : resolve(info))
  })
  try {
    const result = await parseDocument(uploaded.path, path.basename(filePath), mimeType)
    // 采用 worker 返回的实际页码，保留空页供评分器检测漏识别。
    const pages = Array.from({ length: Math.max(1, result.pages) }, (_, index) => ({
      page: index + 1,
      text: result.pages > 0
        ? result.blocks.filter(block => block.page === index + 1).map(block => block.text).join('\n')
        : result.text,
    }))
    return { patch: { ocrText: result.text, pages: result.pages }, pages, sha256: uploaded.contentHash,
      uploadBytesMatch: createHash('sha256').update(readFileSync(filePath)).digest('hex') === uploaded.contentHash }
  } finally {
    await unlink(uploaded.path)
  }
}
