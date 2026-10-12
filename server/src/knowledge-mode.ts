import { env } from './config/env.js'
import { isDatabaseEnabled } from './infrastructure/postgres.js'

export function shouldUseCommercialKnowledgeStore() {
  if (env.KNOWLEDGE_RAG_MODE === 'commercial') {
    return true
  }

  if (env.KNOWLEDGE_RAG_MODE === 'auto') {
    return isDatabaseEnabled()
  }

  return false
}
