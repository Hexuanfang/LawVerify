export type EvidenceUnderstandingMode = 'vision' | 'text' | 'retrieval' | 'none'

// 材料理解的路径选择：
// - retrieval：超大材料先建块级索引，只理解被检索命中的内容块；
// - text：有可检索文本，直接按文本理解，不再逐页渲染与视觉；
// - vision：扫描件只能靠视觉理解，页数封顶并在风险里标注未覆盖范围。
export function resolveEvidenceUnderstandingMode(input: {
  type: string
  pages?: number
  hasText: boolean
  hasVision: boolean
  retrievalPageThreshold: number
}): EvidenceUnderstandingMode {
  if (input.hasText) {
    return (input.pages ?? 0) > input.retrievalPageThreshold ? 'retrieval' : 'text'
  }

  return input.hasVision ? 'vision' : 'none'
}
