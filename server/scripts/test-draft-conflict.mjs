import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { test } from 'node:test'
import ts from 'typescript'
import { AppError } from '../src/core/app-error.ts'

const source = readFileSync(new URL('../src/service.ts', import.meta.url), 'utf8')
const ast = ts.createSourceFile('service.ts', source, ts.ScriptTarget.Latest, true)
const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'updateParagraph')
function fixture() {
  const workspace = { certificates: [{ id: 'c', paragraphs: [{ id: 'p', text: 'Current', richText: '<p>Current</p>' }] }] }
  let saves = 0
  const context = vm.createContext({
    AppError, Map,
    readWorkspace: async () => workspace, writeWorkspace: async () => { saves++ },
    normalizeParagraph: item => item,
    attachAutoStatuteReferencesToParagraph: async (_workspace, paragraph) => paragraph,
  })
  vm.runInContext(ts.transpileModule(`${declaration.getText(ast).replace(/^export\s+/, '')};this.update=updateParagraph`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText, context)
  return { context, workspace, saves: () => saves }
}

test('old draft cannot overwrite a newer persisted paragraph', async () => {
  const { context, workspace, saves } = fixture()
  await assert.rejects(context.update('c', 'p', {
    text: 'Old draft', richText: '<p>Old draft</p>', expectedContent: { text: 'Old', richText: '<p>Old</p>' },
  }), error => error.code === 'PARAGRAPH_CONFLICT')
  assert.equal(workspace.certificates[0].paragraphs[0].text, 'Current')
  assert.equal(saves(), 0)
})

test('matching base saves text and does not persist the request precondition', async () => {
  const { context, workspace, saves } = fixture()
  await context.update('c', 'p', {
    text: 'New', richText: '<p>New</p>', expectedContent: { text: 'Current', richText: '<p>Current</p>' },
  })
  assert.equal(workspace.certificates[0].paragraphs[0].text, 'New')
  assert.equal('expectedContent' in workspace.certificates[0].paragraphs[0], false)
  assert.equal(saves(), 1)
})

test('retry of an already committed save is accepted without a false conflict', async () => {
  const { context } = fixture()
  await context.update('c', 'p', {
    text: 'Current', richText: '<p>Current</p>', expectedContent: { text: 'Old', richText: '<p>Old</p>' },
  })
})

test('deleted paragraph cannot be reported as successfully saved', async () => {
  const { context } = fixture()
  await assert.rejects(context.update('c', 'missing', { text: 'Draft' }), error => error.code === 'PARAGRAPH_NOT_FOUND')
})
