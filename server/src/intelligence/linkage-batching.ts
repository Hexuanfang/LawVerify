import type { LlmChatMessage } from '../integrations/llm-service.js'
import type { ModelRedaction } from '../integrations/model-redaction.js'
import { getLinkageSentences } from './linkage-policy.js'

export type LinkageStage = 'overview' | 'links'

export interface LinkageBatchOptions {
  messages: LlmChatMessage[]
  paragraphIds: string[]
  stage: LinkageStage
  maxTokens: number
}

type ParagraphPayload = Record<string, unknown>

function estimateParagraphOutput(paragraph: ParagraphPayload, stage: LinkageStage) {
  const sentences = Array.isArray(paragraph.sentenceGroups)
    ? paragraph.sentenceGroups
    : getLinkageSentences(typeof paragraph.text === 'string' ? paragraph.text : '')
  const sentenceCount = Math.max(1, sentences.length)
  if (stage === 'overview') return 350 + sentenceCount * 160

  const overview = paragraph.overview as { sentenceFocus?: Array<Record<string, unknown>> } | undefined
  const focus = overview?.sentenceFocus ?? Array.from({ length: sentenceCount }, () => ({ evidenceNeeded: true }))
  const active = focus.filter(item => item.priority !== 'skip')
  const candidates = Array.isArray(paragraph.evidenceCandidates) ? paragraph.evidenceCandidates.length : 1
  // 估算 JSON 字段、理由和真实摘录的输出量，并遵循现有单段关联数量上限。
  const evidenceLinks = Math.min(12, active.filter(item => item.evidenceNeeded === true).length * candidates)
  const statuteIntents = active.some(item => item.statuteNeeded === true) ? 8 : 0
  const caseIntents = active.some(item => item.caseNeeded === true) ? 6 : 0
  return 120 + evidenceLinks * 320 + statuteIntents * 240 + caseIntents * 200
}

export function planLinkageParagraphBatches(
  options: LinkageBatchOptions,
  redaction?: Pick<ModelRedaction, 'learnText' | 'redact'>,
): LinkageBatchOptions[] {
  const paragraphsById = new Map<string, ParagraphPayload>()
  // 原始 JSON 只解析一次，后续仅序列化当前候选批次，避免长文档反复全量解析。
  const templates = options.messages.map(message => {
    if (message.role !== 'user' || typeof message.content !== 'string') return { message }
    try {
      const payload = JSON.parse(message.content) as Record<string, unknown> | null
      if (Array.isArray(payload?.paragraphs)) {
        const entries = new Map<string, ParagraphPayload>()
        for (const paragraph of payload.paragraphs as ParagraphPayload[]) {
          if (typeof paragraph?.paragraphId !== 'string') continue
          entries.set(paragraph.paragraphId, paragraph)
          paragraphsById.set(paragraph.paragraphId, paragraph)
        }
        return { message, payload, entries }
      }
    } catch {
      // 非段落 JSON 消息作为共享上下文完整保留。
    }
    return { message }
  })
  const selectMessages = (ids: string[]): LlmChatMessage[] => templates.map(template => {
    if (!template.payload || !template.entries) return template.message
    const paragraphs = ids.flatMap(id => {
      const paragraph = template.entries.get(id)
      return paragraph ? [paragraph] : []
    })
    return { ...template.message, content: JSON.stringify({ ...template.payload, paragraphs }) }
  })
  const textParts = (messages: LlmChatMessage[]) => messages.flatMap(message => typeof message.content === 'string'
    ? [message.content] : message.content.flatMap(part => part.type === 'text' ? [part.text] : []))
  textParts(options.messages).forEach(text => redaction?.learnText(text))

  const batches: LinkageBatchOptions[] = []
  const outputLimit = Math.min(options.maxTokens, 10000)
  let paragraphIds: string[] = []
  let messages: LlmChatMessage[] = []
  let estimatedOutput = 64
  const appendBatch = () => {
    batches.push({
      ...options, paragraphIds, messages,
      maxTokens: Math.min(outputLimit, Math.max(6000, Math.ceil(estimatedOutput / 0.8))),
    })
  }

  for (const paragraphId of options.paragraphIds) {
    const paragraphOutput = estimateParagraphOutput(paragraphsById.get(paragraphId) ?? {}, options.stage)
    let candidateIds = [...paragraphIds, paragraphId]
    let candidateMessages = selectMessages(candidateIds)
    let lengths = textParts(candidateMessages).map(text => (redaction?.redact(text) ?? text).length)
    // 输入按脱敏后的全部文本计量，输出预留 20% 余量，始终保持段落完整。
    if (paragraphIds.length && (lengths.reduce((total, length) => total + length, 0) > 16000
      || estimatedOutput + paragraphOutput > outputLimit * 0.8)) {
      appendBatch()
      paragraphIds = []
      estimatedOutput = 64
      candidateIds = [paragraphId]
      candidateMessages = selectMessages(candidateIds)
      lengths = textParts(candidateMessages).map(text => (redaction?.redact(text) ?? text).length)
    }
    if (lengths.some(length => length > 150000)) {
      throw new Error('单段核验内容及案件上下文超过 150000 字符，请精简相关材料摘要后重试。')
    }
    if (64 + paragraphOutput > outputLimit) {
      throw new Error('单段核验预计输出超过当前输出预算，请减少该段需核验的内容后重试。')
    }
    paragraphIds = candidateIds
    messages = candidateMessages
    estimatedOutput += paragraphOutput
  }
  if (paragraphIds.length) appendBatch()
  return batches
}
