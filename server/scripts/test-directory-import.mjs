import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { env } from '../src/config/env.ts'

test('directory upload, compact import and workspace responses preserve original assets', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'lawverify-import-test-'))
  env.WORKSPACE_DATA_DIR = path.join(root, 'data')
  env.STORAGE_LOCAL_ROOT = path.join(root, 'storage')
  env.KNOWLEDGE_RAG_MODE = 'local'
  const { readWorkspace, writeWorkspace, runWithWorkspaceAccount } = await import('../src/store.ts')
  const { sanitizeWorkspaceForClient } = await import('../src/service.ts')
  const { createApp } = await import('../src/app.ts')
  const account = 'directory-test@example.invalid'
  await runWithWorkspaceAccount(account, async () => {
    const workspace = await readWorkspace()
    workspace.cases = [{ id: 'case-test', name: 'Import test', createdAt: '2026-10-19', status: 'draft' }]
    workspace.evidences = [{
      id: 'evidence-test', caseId: 'case-test', directoryId: 'directory-test',
      number: 'E01', name: 'Original', fileName: 'original.txt', relativePath: 'directory/original.txt',
      type: 'text', ocrText: 'Original material', contentHash: 'unchanged', uploadedAt: '2026-10-19',
      sourceDataUrl: 'data:text/plain;base64,T3JpZ2luYWw=',
      pageImageDataUrls: ['data:image/png;base64,' + 'A'.repeat(4 * 1024 * 1024)],
    }]
    await writeWorkspace(workspace)
    const sanitized = sanitizeWorkspaceForClient(workspace)
    assert.equal(sanitized.evidences[0].pageImageDataUrls, undefined)
    assert.equal(sanitized.evidences[0].sourceDataUrl, undefined)
    assert.equal(workspace.evidences[0].pageImageDataUrls.length, 1)
  })
  const server = createApp().app.listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  t.after(async () => {
    await new Promise(resolve => server.close(resolve))
    rmSync(root, { recursive: true, force: true })
  })
  const base = `http://127.0.0.1:${server.address().port}`
  const headers = { 'x-workspace-account': account }
  const form = new FormData()
  form.append('files', new Blob(['Original material']), 'original.txt')
  form.append('manifest', JSON.stringify([{ fileName: 'original.txt', relativePath: 'directory/original.txt' }]))
  const upload = await fetch(`${base}/api/evidences/assets/upload`, { method: 'POST', headers, body: form })
  assert.equal(upload.status, 200)
  const { assets } = await upload.json()
  assert.equal(assets.length, 1)
  assert.equal(await (await fetch(`${base}${assets[0].storageUrl}`)).text(), 'Original material')
  const response = await fetch(`${base}/api/evidences/import?response=compact`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      caseId: 'case-test', processInBackground: false, deferUnderstanding: true,
      files: [{ ...assets[0], name: 'Original', type: 'text', ocrText: '', contentHash: 'unchanged' }],
    }),
  })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { imported: 0 })
  const workspaceResponse = await fetch(`${base}/api/workspace`, { headers })
  assert.equal(workspaceResponse.status, 200)
  const workspace = (await workspaceResponse.json()).workspace
  assert.equal(workspace.evidences[0].pageImageDataUrls, undefined)
  const source = await fetch(`${base}/api/evidences/evidence-test/source`, { headers })
  assert.equal(source.status, 200)
  assert.equal(await source.text(), 'Original material')
  const register = async files => {
    const response = await fetch(`${base}/api/evidences/import?response=compact`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        caseId: 'case-test', processInBackground: false, deferUnderstanding: true, files,
      }),
    })
    assert.equal(response.status, 200)
    return response.json()
  }
  const manifest = [
    { directoryId: 'new-directory', relativePath: 'new-directory/first.txt', fileName: 'first.txt', contentHash: 'first', name: 'First', type: 'text', ocrText: '' },
    { directoryId: 'new-directory', relativePath: 'new-directory/second.txt', fileName: 'second.txt', contentHash: 'second', name: 'Second', type: 'text', ocrText: '' },
  ]
  assert.equal((await register(manifest)).imported, 2)
  await runWithWorkspaceAccount(account, async () => {
    const linked = await readWorkspace()
    assert.equal(linked.evidences.filter(e => e.directoryId === 'new-directory').length, 2)
    assert.equal(linked.cases[0].agent?.task, undefined, 'registration must not queue understanding')
    assert.equal(linked.caseContextMemories.length, 0, 'registration must not build case memory')
  })
  assert.equal((await register([{ ...manifest[0], ...assets[0], contentHash: 'first', relativePath: manifest[0].relativePath }])).imported, 0)
  await runWithWorkspaceAccount(account, async () => {
    const linked = await readWorkspace()
    const first = linked.evidences.find(e => e.contentHash === 'first')
    assert.equal(first.storageKey, assets[0].storageKey, 'source attachment must update same-hash placeholder')
    assert.equal(first.summaryStatus, 'idle')
    assert.equal(linked.cases[0].agent?.task, undefined)
    first.summaryStatus = 'ready'
    first.summaryText = 'Existing understanding'
    await writeWorkspace(linked)
  })
  await register(manifest)
  const fastManifest = {
    directoryId: 'fast-directory', relativePath: 'fast-directory/fast.txt',
    fileName: 'fast.txt', sourceFingerprint: 'stat:17:100:100',
    name: 'Fast original', type: 'text', ocrText: '',
  }
  await register([fastManifest])
  await register([{ ...fastManifest, ...assets[0], relativePath: fastManifest.relativePath }])
  await runWithWorkspaceAccount(account, async () => {
    const linked = await readWorkspace()
    const evidence = linked.evidences.find(e => e.directoryId === 'fast-directory')
    assert.equal(evidence.contentHash, assets[0].contentHash, 'source upload retains a real content hash')
    assert.equal(evidence.sourceFingerprint, fastManifest.sourceFingerprint)
    evidence.summaryStatus = 'ready'
    evidence.summaryText = 'Reusable understanding'
    await writeWorkspace(linked)
  })
  await register([fastManifest])
  await runWithWorkspaceAccount(account, async () => {
    const stored = await readWorkspace()
    assert.equal(stored.evidences.find(e => e.id === 'evidence-test').pageImageDataUrls.length, 1)
    const first = stored.evidences.find(e => e.contentHash === 'first')
    assert.equal(first.storageKey, assets[0].storageKey, 'rescanning must preserve attached original')
    assert.equal(first.summaryText, 'Existing understanding', 'unchanged files must retain understanding')
    const fast = stored.evidences.find(e => e.directoryId === 'fast-directory')
    assert.equal(fast.contentHash, assets[0].contentHash)
    assert.equal(fast.summaryText, 'Reusable understanding', 'metadata rescan preserves actual content and understanding')
  })
  await runWithWorkspaceAccount(account, async () => {
    const stored = await readWorkspace()
    stored.cases.push({ id: 'other-case', name: 'Other', createdAt: '2026-10-20', status: 'draft' })
    stored.evidences.push({ ...stored.evidences[0], id: 'other-evidence', caseId: 'other-case' })
    stored.certificates.push({
      id: 'clear-test-document', caseId: 'case-test', title: 'Keep document',
      paragraphs: [{ id: 'paragraph-clear', text: 'Keep original document text', verified: true,
        links: [{ evidenceId: 'evidence-test', locator: 'Page 1', quote: 'Original' }] }],
    })
    await writeWorkspace(stored)
  })
  const cleared = await fetch(`${base}/api/cases/case-test/directory-evidences`, { method: 'DELETE', headers })
  assert.equal(cleared.status, 200)
  const afterClear = (await cleared.json()).workspace
  assert.equal(afterClear.evidences.filter(e => e.caseId === 'case-test').length, 0)
  assert.equal(afterClear.evidences.filter(e => e.caseId === 'other-case').length, 1)
  const document = afterClear.certificates.find(c => c.id === 'clear-test-document')
  assert.equal(document.paragraphs[0].text, 'Keep original document text')
  assert.deepEqual(document.paragraphs[0].links, [])
  assert.equal(await (await fetch(`${base}${assets[0].storageUrl}`)).text(), 'Original material')
  assert.equal((await fetch(`${base}/api/cases/case-test/directory-evidences`, { method: 'DELETE', headers })).status, 200)
})
