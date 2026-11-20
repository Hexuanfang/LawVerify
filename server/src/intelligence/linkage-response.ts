import { createChatCompletion } from '../integrations/llm-service.js'
import { withLlmCallCache } from '../infrastructure/llm-call-cache.js'
import { currentModelRedaction } from '../integrations/model-redaction.js'
import { planLinkageParagraphBatches, type LinkageBatchOptions, type LinkageStage } from './linkage-batching.js'

type LinkageParagraph = Record<string, unknown> & { paragraphId: string }

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

export async function requestLinkageParagraphBatch(options: LinkageBatchOptions & {
  onBatch?: (paragraphIds: string[]) => void
}) {
  const batches = planLinkageParagraphBatches(options, currentModelRedaction())
  const paragraphs: LinkageParagraph[] = []
  for (const batch of batches) {
    options.onBatch?.(batch.paragraphIds)
    const selectMessages = (paragraphIds: string[]) => batch.messages.map(message => {
      if (message.role !== 'user' || typeof message.content !== 'string') return message
      try {
        const payload = JSON.parse(message.content) as { paragraphs?: Array<{ paragraphId?: string }> }
        if (Array.isArray(payload.paragraphs)) {
          payload.paragraphs = payload.paragraphs.filter(item => paragraphIds.includes(item.paragraphId ?? ''))
          return { ...message, content: JSON.stringify(payload) }
        }
      } catch {
        // 非段落 JSON 消息保留完整上下文。
      }
      return message
    })
    // 结果按请求内容缓存：任务被中断后重新执行时，已完成的段落分析可以直接复用。
    const { value } = await withLlmCallCache('linkage-paragraph', {
      stage: batch.stage,
      paragraphIds: batch.paragraphIds,
      messages: batch.messages,
      maxTokens: batch.maxTokens,
    }, async () => {
      const completion = await createChatCompletion({
        messages: batch.messages,
        maxTokens: batch.maxTokens,
        temperature: 0.1,
        responseFormat: 'json_object',
      })
      const entries = new Map(parseLinkageParagraphResponse(completion.content, batch.paragraphIds, batch.stage)
        .map(item => [item.paragraphId, item]))
      for (const paragraphId of batch.paragraphIds) {
        if (entries.has(paragraphId)) continue
        const retryMessages = selectMessages([paragraphId])
        retryMessages.push({
          role: 'user',
          content: `只返回 paragraphId="${paragraphId}" 的完整 JSON 对象，格式 {"paragraphs":[...]}。不要解释，不要 Markdown，不要重复原句；使用输入 sentenceIndex 定位，reason 简短，空关联用空数组。`,
        })
        const retry = await createChatCompletion({
          messages: retryMessages,
          maxTokens: Math.min(batch.maxTokens * 2, 10000),
          temperature: 0.1,
          responseFormat: 'json_object',
        })
        const recovered = parseLinkageParagraphResponse(retry.content, [paragraphId], batch.stage)[0]
        if (!recovered) {
          throw new Error('本次联动分析未完整返回，已自动重试。请稍后重试；原文和已有关联均未改动。')
        }
        entries.set(paragraphId, recovered)
      }
      return { paragraphs: batch.paragraphIds.map(id => entries.get(id)!) }
    })
    paragraphs.push(...value.paragraphs)
  }
  return { paragraphs }
}
