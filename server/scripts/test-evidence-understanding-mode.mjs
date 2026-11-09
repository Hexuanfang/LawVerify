import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveEvidenceUnderstandingMode } from '../src/intelligence/evidence-understanding-mode.ts'

const base = {
  type: 'pdf',
  pages: 100,
  hasText: false,
  hasVision: true,
  retrievalPageThreshold: 500,
}

test('有文本层的 PDF 走文本理解，不再逐页渲染与视觉', () => {
  assert.equal(resolveEvidenceUnderstandingMode({ ...base, hasText: true }), 'text')
  assert.equal(resolveEvidenceUnderstandingMode({ ...base, type: 'image', hasText: true }), 'text')
})

test('超过页数阈值的材料走检索式理解', () => {
  assert.equal(
    resolveEvidenceUnderstandingMode({ ...base, pages: 501, hasText: true }),
    'retrieval',
  )
  assert.equal(
    resolveEvidenceUnderstandingMode({ ...base, pages: 500, hasText: true }),
    'text',
    '恰好等于阈值时仍走完整理解',
  )
})

test('扫描件只能靠视觉理解', () => {
  assert.equal(resolveEvidenceUnderstandingMode({ ...base, pages: 3000 }), 'vision')
  assert.equal(resolveEvidenceUnderstandingMode({ ...base, hasVision: false }), 'none')
})
