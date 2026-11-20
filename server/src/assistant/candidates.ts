import { randomUUID } from 'node:crypto'
import { AppError } from '../core/app-error.js'
import { getCurrentWorkspaceAccount } from '../store.js'

export type AssistantCandidateTarget = { caseId: string; certificateId?: string }
type AdoptionResult = { certificateId: string; paragraphId?: string; elementId?: string }
type Candidate = {
  target: AssistantCandidateTarget
  account: string | null
  expiresAt: number
  apply?: () => Promise<AdoptionResult>
  applying?: Promise<AdoptionResult>
  result?: AdoptionResult
}

const candidates = new Map<string, Candidate>()
const lifetime = 45 * 60 * 1000

export function rememberAssistantCandidate(target: AssistantCandidateTarget, apply: () => Promise<AdoptionResult>) {
  const now = Date.now()
  for (const [key, candidate] of candidates) {
    if (!candidate.applying && candidate.expiresAt <= now) candidates.delete(key)
  }
  if (candidates.size >= 200) {
    const oldest = [...candidates].find(([, candidate]) => !candidate.applying)
    if (!oldest) throw new AppError('助手正在保存多个候选，请稍后重试。', 429, 'ASSISTANT_CANDIDATE_BUSY')
    candidates.delete(oldest[0])
  }
  const id = randomUUID()
  candidates.set(id, { target: { ...target }, account: getCurrentWorkspaceAccount(), expiresAt: now + lifetime, apply })
  return id
}

export async function adoptAssistantCandidate(request: AssistantCandidateTarget & { candidateId: string; confirmed: boolean }) {
  if (request.confirmed !== true) throw new AppError('请明确确认采纳候选。', 400, 'ASSISTANT_CONFIRMATION_REQUIRED')
  const candidate = candidates.get(request.candidateId)
  if (!candidate || candidate.expiresAt <= Date.now() || candidate.account !== getCurrentWorkspaceAccount()
    || candidate.target.caseId !== request.caseId || candidate.target.certificateId !== request.certificateId) {
    throw new AppError('候选已失效，请在当前案件和文书重新生成。', 409, 'ASSISTANT_CANDIDATE_EXPIRED')
  }
  if (candidate.result) return candidate.result
  if (candidate.applying) return candidate.applying
  const apply = candidate.apply!
  candidate.applying = Promise.resolve().then(apply)
  try {
    candidate.result = await candidate.applying
    candidate.apply = undefined
    return candidate.result
  } finally {
    candidate.applying = undefined
  }
}

export function discardAssistantCandidate(candidateId: string) {
  const candidate = candidates.get(candidateId)
  if (candidate && candidate.account === getCurrentWorkspaceAccount() && !candidate.applying && !candidate.result) {
    candidates.delete(candidateId)
  }
}
