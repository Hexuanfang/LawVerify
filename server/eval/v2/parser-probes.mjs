import { isDeepStrictEqual } from 'node:util'

// 不只检查“返回了段落”：段落、句号锚点、材料编号、关系、引用都要原样保留。
export function parserProbes(parse) {
  const entry = { paragraphId: 'p1', evidenceLinks: [{ sentenceIndex: 0, evidenceNumber: 'E01', relation: 'contradict', quoteHint: '尚未支付尾款64000元' }] }
  const payload = JSON.stringify({ paragraphs: [entry] })
  const fixtures = [
    { id: 'normal', raw: payload, ids: ['p1'], expected: [entry] },
    { id: 'fenced', raw: `\`\`\`json\n${payload}\n\`\`\``, ids: ['p1'], expected: [entry] },
    { id: 'double-encoded', raw: JSON.stringify(payload), ids: ['p1'], expected: [entry] },
    { id: 'nested', raw: JSON.stringify({ result: JSON.parse(payload) }), ids: ['p1'], expected: [entry] },
    { id: 'truncated-outer', raw: payload.slice(0, -2), ids: ['p1'], expected: [entry] },
    { id: 'garbage', raw: '抱歉，我无法分析。', ids: ['p1'], expected: [] },
    { id: 'wrong-id', raw: payload, ids: ['p2'], expected: [] },
    { id: 'empty-links-valid', raw: '{"paragraphs":[{"paragraphId":"p1","evidenceLinks":[]}]}', ids: ['p1'], expected: [{ paragraphId: 'p1', evidenceLinks: [] }] },
    { id: 'invalid-link-shape', raw: '{"paragraphs":[{"paragraphId":"p1","evidenceLinks":["错误字段"]}]}', ids: ['p1'], expected: [] },
    { id: 'invalid-relation', raw: '{"paragraphs":[{"paragraphId":"p1","evidenceLinks":[{"sentenceIndex":0,"evidenceNumber":"E01","relation":"胡说","quoteHint":"虚假内容"}]}]}', ids: ['p1'], expected: [] },
  ]
  const results = fixtures.map(f => {
    const actual = parse(f.raw, f.ids, 'links')
    return { ...f, actual, correct: isDeepStrictEqual(actual, f.expected) }
  })
  return { total: results.length, correct: results.filter(r => r.correct).length,
    rate: results.filter(r => r.correct).length / results.length, results }
}
