// 共享分词实现：证据检索（evidence-retrieval）与全局搜索（workspace-search）使用同一套口径。
// 单独抽出是为了让「检索命中」与「搜索命中」对同一个词给出一致判断，
// 否则评测指标与用户实际看到的搜索结果会对不上。
export function tokenize(text: string) {
  const tokens: string[] = []
  const lower = text.toLowerCase()

  for (const matched of lower.matchAll(/[a-z0-9]{2,}/g)) {
    tokens.push(matched[0])
  }

  // 中文按二元组切分：不需要分词词典，也比单字更有区分度。
  for (const part of lower.replace(/[^\u4e00-\u9fa5]+/g, ' ').split(/\s+/)) {
    if (!part) {
      continue
    }
    if (part.length === 1) {
      tokens.push(part)
      continue
    }
    for (let index = 0; index < part.length - 1; index += 1) {
      tokens.push(part.slice(index, index + 2))
    }
  }

  return tokens
}

// 归一化文本：去掉空白后比较，避免排版差异导致「明明引用了却判定没引用」。
export function normalizeForMatch(text: string) {
  return text.replace(/\s+/g, '').toLowerCase()
}
