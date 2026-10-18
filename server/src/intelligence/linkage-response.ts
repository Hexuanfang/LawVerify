import { createChatCompletion, type LlmChatMessage } from '../integrations/llm-service.js'

type LinkageParagraph = Record<string, unknown> & { paragraphId: string }
type LinkageStage = 'overview' | 'links'

function hasStageFields(item: Record<string, unknown>, stage: LinkageStage) {
  return stage === 'overview'
    ? Array.isArray(item.sentenceFocus)
    : ['evidenceLinks', 'statuteIntents', 'caseIntents'].some(key => Array.isArray(item[key]))
}

export function parseLinkageParagraphResponse(raw: string, paragraphIds: string[], stage: LinkageStage) {
  const text = raw.replace(/^\uFEFF/, '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  const values: unknown[] = []
  const decode = (candidate: string) => {
    try {
      const value: unknown = JSON.parse(candidate)
      if (typeof value === 'string' && value !== candidate) decode(value)
      else values.push(value)
    } catch {
      // A truncated outer envelope can still contain complete paragraph objects.
    }
  }
  decode(text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, ''))
  const stack: number[] = []
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{' || char === '[') stack.push(index)
    else if ((char === '}' || char === ']') && stack.length) {
      const start = stack.pop()!
      const opening = text[start]
      if ((opening === '{' && char === '}') || (opening === '[' && char === ']')) decode(text.slice(start, index + 1))
    }
  }
  const allowedIds = new Set(paragraphIds)
  const entries = new Map<string, LinkageParagraph>()
  const visit = (value: unknown, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 5) return
    if (Array.isArray(value)) {
      value.forEach(item => visit(item, depth + 1))
      return
    }
    const item = value as Record<string, unknown>
    const id = typeof item.paragraphId === 'string' ? item.paragraphId.trim()
      : paragraphIds.length === 1 && hasStageFields(item, stage) ? paragraphIds[0] : ''
    if (allowedIds.has(id) && hasStageFields(item, stage)) {
      entries.set(id, { ...item, paragraphId: id })
      return
    }
    for (const key of ['paragraphs', 'data', 'result', 'results', 'output']) visit(item[key], depth + 1)
  }
  values.forEach(value => visit(value))
  return [...entries.values()]
}

export async function requestLinkageParagraphBatch(options: {
  messages: LlmChatMessage[]
  paragraphIds: string[]
  stage: LinkageStage
  maxTokens: number
}) {
  const completion = await createChatCompletion({
    messages: options.messages,
    maxTokens: options.maxTokens,
    temperature: 0.1,
    responseFormat: 'json_object',
  })
  const entries = new Map(parseLinkageParagraphResponse(completion.content, options.paragraphIds, options.stage)
    .map(item => [item.paragraphId, item]))
  for (const paragraphId of options.paragraphIds) {
    if (entries.has(paragraphId)) continue
    const retryMessages = options.messages.map(message => {
      if (message.role !== 'user' || typeof message.content !== 'string') return message
      try {
        const payload = JSON.parse(message.content) as { paragraphs?: Array<{ paragraphId?: string }> }
        if (Array.isArray(payload.paragraphs)) {
          payload.paragraphs = payload.paragraphs.filter(item => item.paragraphId === paragraphId)
          return { ...message, content: JSON.stringify(payload) }
        }
      } catch {
        // Keep the original context if the caller is not using a JSON payload.
      }
      return message
    })
    retryMessages.push({
      role: 'user',
      content: `只返回 paragraphId="${paragraphId}" 的完整 JSON 对象，格式 {"paragraphs":[...]}。不要解释，不要 Markdown，不要重复原句；使用输入 sentenceIndex 定位，reason 简短，空关联用空数组。`,
    })
    const retry = await createChatCompletion({
      messages: retryMessages,
      maxTokens: Math.min(options.maxTokens * 2, 10000),
      temperature: 0.1,
      responseFormat: 'json_object',
    })
    const recovered = parseLinkageParagraphResponse(retry.content, [paragraphId], options.stage)[0]
    if (!recovered) {
      throw new Error('本次联动分析未完整返回，已自动重试。请稍后重试；原文和已有关联均未改动。')
    }
    entries.set(paragraphId, recovered)
  }
  return { paragraphs: options.paragraphIds.map(id => entries.get(id)!) }
}
