import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const directory = mkdtempSync(path.join(tmpdir(), 'lawverify-long-task-'))
const { env } = await import('../src/config/env.ts')
env.WORKSPACE_DATA_DIR = directory
env.KNOWLEDGE_RAG_MODE = 'local'

const { readWorkspace, writeWorkspace, runWithWorkspaceAccount } = await import('../src/store.ts')
const { commitToLatestWorkspace, certificateParagraphsChanged } = await import('../src/service.ts')

function certificate(text) {
  return {
    id: 'certificate', caseId: 'case', title: '文书', role: 'plaintiff', focus: '',
    createdAt: '2026-11-08', paragraphIds: ['paragraph'],
    paragraphs: [{ id: 'paragraph', text, verified: false, links: [] }],
  }
}

test('长任务保存基于最新工作区，后台的更新不会被旧快照覆盖', async () => {
  await runWithWorkspaceAccount('long-task-a@test.invalid', async () => {
    const produced = await readWorkspace()

    // 任务进行期间，后台改动了工作区。
    const background = await readWorkspace()
    background.user.name = '后台改过的用户'
    await writeWorkspace(background)

    const next = await commitToLatestWorkspace(produced, (latest) => {
      latest.certificates.unshift(certificate('生成结果'))
    })

    assert.equal(next.user.name, '后台改过的用户', '后台的更新应当保留')
    assert.equal(next.certificates.length, 1, '本次任务的产出应当写入')
    assert.equal(next.certificates[0].paragraphs[0].text, '生成结果')

    const persisted = await readWorkspace()
    assert.equal(persisted.user.name, '后台改过的用户', '后台的更新应当已经落库')
    assert.equal(persisted.certificates.length, 1, '本次任务的产出应当已经落库')
  })
})

test('长任务保存前可以拦住已经失效的前提', async () => {
  await runWithWorkspaceAccount('long-task-b@test.invalid', async () => {
    const produced = await readWorkspace()
    await assert.rejects(
      commitToLatestWorkspace(produced, () => {}, () => { throw new Error('案件已删除，生成结果已丢弃。') }),
      /案件已删除/,
    )
    const persisted = await readWorkspace()
    assert.equal(persisted.certificates.length, 0, '前提失效时不应写入任何内容')
  })
})

test('改写期间文书正文被改动会被识别', () => {
  const original = certificate('原始正文')
  assert.equal(certificateParagraphsChanged(original, certificate('原始正文')), false)
  assert.equal(certificateParagraphsChanged(original, certificate('用户改过的正文')), true)
  assert.equal(certificateParagraphsChanged(original, undefined), true)
  assert.equal(
    certificateParagraphsChanged(original, { ...original, paragraphs: [
      ...original.paragraphs,
      { id: 'paragraph-2', text: '新增段落', verified: false, links: [] },
    ] }),
    true,
    '段落数量变化也算改动',
  )
})