import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { WorkspaceSqliteStore } from '../src/infrastructure/workspace-sqlite.ts'
import { mergeAutoLinkageIntoCertificate } from '../src/service.ts'

const AUTO_LINK_NOTE = 'system:auto-evidence-linked'

function fixture() {
  return {
    user: { id: 'user', name: 'test', email: 'linkage@test.invalid', phone: '', organization: '', title: '', points: 0, pointLogs: [] },
    cases: [{ id: 'case', name: 'case', description: '', createdAt: '2026-11-08', status: 'draft' }],
    evidences: [{
      id: 'e1', caseId: 'case', number: 'E01', name: 'one', fileName: 'one.txt', type: 'text',
      uploadedAt: '2026-11-08', ocrText: 'original one', summaryText: '旧理解', summaryStatus: 'ready',
      sourceDataUrl: 'data:text/plain;base64,b3JpZ2luYWw=',
    }],
    evidenceFragments: [], evidenceInsights: [], caseContextMemories: [], draftMemories: [],
    certificates: [{
      id: 'certificate', caseId: 'case', title: 'document', role: 'plaintiff', focus: '', createdAt: '2026-11-08', paragraphIds: ['paragraph'],
      paragraphs: [{
        id: 'paragraph', text: 'First sentence.', verified: false, links: [],
        references: [{ id: 'ref', type: 'statute', targetId: 'article', sourceTitle: 'law', label: 'article', locator: 'one', quote: 'text' }],
      }],
    }],
    claimUnits: [], claimEvidenceMatches: [], knowledgeCases: [], knowledgeFiles: [], knowledgeStatutes: [], paymentOrders: [],
  }
}

function workspace() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lawverify-linkage-'))
  const store = new WorkspaceSqliteStore(dir)
  store.read(fixture)
  const read = () => store.read(() => { throw new Error('Existing database must not reinitialize') })
  return { store, read, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

// 联动结束时的结果：给段落挂上一条自动生成的证据。
function linkedCertificate(read) {
  const certificate = read().certificates[0]
  return {
    ...certificate,
    paragraphs: certificate.paragraphs.map((paragraph) => ({
      ...paragraph,
      links: [...(paragraph.links ?? []), {
        id: 'link-auto', evidenceId: 'e1', locator: '第一句', quote: 'original one',
        sentenceIndex: 0, note: AUTO_LINK_NOTE,
      }],
    })),
  }
}

// 联动的保存流程：重新读取最新工作区，再把联动结果合并上去。
function commitLinkage(read, linked) {
  const latest = read()
  latest.certificates = latest.certificates.map((certificate) =>
    certificate.id === 'certificate' ? mergeAutoLinkageIntoCertificate(certificate, linked) : certificate,
  )
  return latest
}

test('联动期间后台重写材料原件，联动结果仍能保存', (t) => {
  const { store, read, cleanup } = workspace()
  t.after(cleanup)
  const linked = linkedCertificate(read)

  // 后台完成材料理解，重新解析了原件并写入新的理解结果。
  const background = read()
  background.evidences[0].sourceDataUrl = 'data:text/plain;base64,bmV3'
  background.evidences[0].summaryText = '新理解'
  store.save(background)

  store.save(commitLinkage(read, linked))

  const result = read()
  const paragraph = result.certificates[0].paragraphs[0]
  assert.equal(paragraph.links.length, 1, '联动生成的证据挂接应当写入')
  assert.equal(paragraph.links[0].note, AUTO_LINK_NOTE)
  assert.equal(result.evidences[0].summaryText, '新理解', '后台写入的理解结果不应被联动覆盖')
  assert.equal(result.evidences[0].sourceDataUrl, 'data:text/plain;base64,bmV3', '后台重写的原件不应被联动覆盖')
})

test('联动期间用户编辑段落正文，用户的编辑优先保留', (t) => {
  const { store, read, cleanup } = workspace()
  t.after(cleanup)
  const linked = linkedCertificate(read)

  const editing = read()
  editing.certificates[0].paragraphs[0].text = '用户改过的正文'
  store.save(editing)

  store.save(commitLinkage(read, linked))

  const paragraph = read().certificates[0].paragraphs[0]
  assert.equal(paragraph.text, '用户改过的正文', '用户的正文修改不应被联动覆盖')
  assert.equal(paragraph.links.length, 1, '联动生成的证据挂接应当写入')
})

test('联动不会丢掉人工添加的证据挂接', (t) => {
  const { store, read, cleanup } = workspace()
  t.after(cleanup)

  const manual = read()
  manual.certificates[0].paragraphs[0].links = [{
    id: 'link-manual', evidenceId: 'e1', locator: '手动定位', quote: 'original one', sentenceIndex: 0,
  }]
  store.save(manual)

  const linked = linkedCertificate(read)
  store.save(commitLinkage(read, linked))

  const links = read().certificates[0].paragraphs[0].links
  assert.equal(links.length, 2, '人工挂接与自动挂接都应保留')
  assert.equal(links[0].id, 'link-manual', '人工挂接排在前面')
  assert.equal(links[1].note, AUTO_LINK_NOTE)
})

test('再次联动会替换上一次的自动挂接', (t) => {
  const { store, read, cleanup } = workspace()
  t.after(cleanup)

  const first = linkedCertificate(read)
  store.save(commitLinkage(read, first))

  const second = read().certificates[0]
  const relinked = {
    ...second,
    paragraphs: second.paragraphs.map((paragraph) => ({
      ...paragraph,
      links: [{
        id: 'link-auto-2', evidenceId: 'e1', locator: '第一句', quote: 'original one',
        sentenceIndex: 0, note: AUTO_LINK_NOTE,
      }],
    })),
  }
  store.save(commitLinkage(read, relinked))

  const links = read().certificates[0].paragraphs[0].links
  assert.equal(links.length, 1, '上一次的自动挂接不应残留')
  assert.equal(links[0].id, 'link-auto-2')
})
