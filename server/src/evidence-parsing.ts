import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Evidence, EvidenceParsing } from './domain.js'
import { AppError } from './core/app-error.js'
import { getStorageRoot } from './config/paths.js'
import { getCurrentWorkspaceAccount, readWorkspace, writeWorkspace } from './store.js'
import { runExclusiveWorkspaceMutation } from './infrastructure/workspace-lock.js'
import { parserRoot } from './infrastructure/mineru-runtime.js'
import { readParsedArtifact, runDocumentParsing, supportsDocumentParsing, type ParsedArtifact } from './infrastructure/document-jobs.js'
import { createSemaphore } from './infrastructure/concurrency.js'

export type { ParsedArtifact } from './infrastructure/document-jobs.js'

const pending = new Map<string, Promise<Evidence | undefined>>()
// 上传可继续登记，进入原生进程前施加背压，避免单批几百份材料挤爆协议队列。
const admission = createSemaphore(8)
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const now = () => new Date().toISOString()

export function supportsMineru(evidence: Evidence) {
  const supported = supportsDocumentParsing(evidence.fileName, evidence.sourceMimeType)
  return supported && Boolean(evidence.storageKey || evidence.sourceDataUrl || evidence.previewDataUrl)
}

function sourceKey(evidence: Evidence) {
  return hash(JSON.stringify([evidence.contentHash, evidence.sourceFingerprint, evidence.storageKey,
    evidence.sourceDataUrl, evidence.previewDataUrl, evidence.fileName]))
}

function accountDirectory() {
  return path.join(parserRoot(), hash(getCurrentWorkspaceAccount() ?? '__local__'))
}

function artifactPath(key: string) {
  if (!/^[a-f0-9-]+\.json$/.test(key)) throw new AppError('解析结果定位无效。', 400, 'PARSE_RESULT_INVALID')
  return path.join(accountDirectory(), key)
}

async function readArtifact(evidence: Evidence): Promise<ParsedArtifact | null> {
  if (!evidence.parsing?.artifactKey) return null
  const location = artifactPath(evidence.parsing.artifactKey)
  try {
    return await readParsedArtifact(location)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function inputPath(evidence: Evidence) {
  if (evidence.storageKey) {
    const root = path.resolve(getStorageRoot())
    const resolved = path.resolve(root, evidence.storageKey)
    const relative = path.relative(root, resolved)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('原件位置超出存储目录')
    return resolved
  }
  const data = evidence.sourceDataUrl || evidence.previewDataUrl || ''
  const match = data.match(/^data:[^;,]+;base64,([\s\S]+)$/)
  if (!match) throw new Error('当前材料没有可读取的本地原件')
  const directory = path.join(accountDirectory(), 'inputs')
  await mkdir(directory, { recursive: true })
  const location = path.join(directory, `${sourceKey(evidence)}${path.extname(evidence.fileName).replace(/[^.a-z0-9]/gi, '') || '.png'}`)
  await writeFile(location, Buffer.from(match[1], 'base64'))
  return location
}

async function mutateCurrent(evidenceId: string, revision: string, action: (evidence: Evidence) => void) {
  return runExclusiveWorkspaceMutation(async () => {
    const workspace = await readWorkspace()
    const current = workspace.evidences.find(item => item.id === evidenceId)
    if (!current || current.parsing?.revision !== revision || current.parsing.sourceKey !== sourceKey(current)) return undefined
    action(current)
    await writeWorkspace(workspace)
    return current
  })
}

export async function ensureEvidenceParsed(evidenceId: string, options: { force?: boolean; mode?: EvidenceParsing['mode'] } = {}) {
  const snapshot = await readWorkspace()
  const source = snapshot.evidences.find(item => item.id === evidenceId)
  if (!source) return undefined
  // 同一证据 ID 的原件替换后必须得到新任务，不能复用旧原件尚未完成的 Promise。
  const key = JSON.stringify([getCurrentWorkspaceAccount(), evidenceId, sourceKey(source)])
  const existing = pending.get(key)
  if (existing && !options.force) return existing
  const task = performParsing(evidenceId, options).finally(() => { if (pending.get(key) === task) pending.delete(key) })
  pending.set(key, task)
  return task
}

async function performParsing(evidenceId: string, options: { force?: boolean; mode?: EvidenceParsing['mode'] }) {
  const revision = randomUUID()
  const captured = await runExclusiveWorkspaceMutation(async () => {
    const workspace = await readWorkspace()
    const evidence = workspace.evidences.find(item => item.id === evidenceId)
    if (!evidence || !supportsMineru(evidence)) return { evidence, run: false }
    if (!options.force && evidence.parsing?.sourceKey === sourceKey(evidence)) {
      if (['review_required', 'failed'].includes(evidence.parsing.status)) return { evidence, run: false }
      if (evidence.parsing.status === 'ready' && (evidence.parsing.reviewedAt || await readArtifact(evidence))) return { evidence, run: false }
    }
    evidence.parsing = { status: 'queued', revision, sourceKey: sourceKey(evidence), mode: options.mode ?? evidence.parsing?.mode ?? 'auto', updatedAt: now() }
    await writeWorkspace(workspace)
    return { evidence, run: true }
  })
  if (!captured.run || !captured.evidence) return captured.evidence
  const evidence = captured.evidence
  return admission.run(async () => {
    try {
      const current = await mutateCurrent(evidenceId, revision, item => { item.parsing!.status = 'processing'; item.parsing!.updatedAt = now() })
      if (!current) return undefined
      const artifactKey = `${revision}.json`
      const output = artifactPath(artifactKey)
      await mkdir(path.dirname(output), { recursive: true })
      const artifact = await runDocumentParsing(await inputPath(evidence), output, evidence.fileName,
        evidence.sourceMimeType, evidence.parsing!.mode)
      return mutateCurrent(evidenceId, revision, item => {
        item.parsing = { ...item.parsing!, artifactKey, engineVersion: artifact.engineVersion,
          warnings: artifact.warnings, status: artifact.reviewRequired ? 'review_required' : 'ready', updatedAt: now() }
        item.ocrText = artifact.text
        item.pages = artifact.pages || undefined
        item.summaryText = undefined
        item.summaryCacheKey = undefined
        item.summaryStatus = artifact.reviewRequired ? 'idle' : 'processing'
        item.summaryError = undefined
      })
    } catch (error) {
      return mutateCurrent(evidenceId, revision, item => {
        item.parsing = { ...item.parsing!, status: 'failed', error: error instanceof Error ? error.message : '材料解析失败，请人工审核', updatedAt: now() }
        item.summaryStatus = 'idle'
      })
    }
  })
}

export async function getEvidenceParsing(evidenceId: string) {
  const workspace = await readWorkspace()
  const evidence = workspace.evidences.find(item => item.id === evidenceId)
  if (!evidence) throw new AppError('材料不存在。', 404, 'EVIDENCE_NOT_FOUND')
  const result = await readArtifact(evidence)
  const continuityCandidates: Array<{ evidenceId: string; name: string; position: 'before' | 'after'; overlapMessages: number }> = []
  if (result?.chat) {
    for (const other of workspace.evidences) {
      if (other.id === evidenceId || other.caseId !== evidence.caseId || other.type !== 'image' || other.parsing?.status !== 'ready') continue
      let peer: ParsedArtifact | null
      try { peer = await readArtifact(other) } catch { continue }
      const before = chatOverlap(peer?.chat, result.chat)
      const after = chatOverlap(result.chat, peer?.chat)
      if (before) continuityCandidates.push({ evidenceId: other.id, name: other.name, position: 'before', overlapMessages: before })
      if (after) continuityCandidates.push({ evidenceId: other.id, name: other.name, position: 'after', overlapMessages: after })
    }
  }
  return { parsing: evidence.parsing, result, text: evidence.ocrText, continuityCandidates }
}

function chatOverlap(first: ParsedArtifact['chat'], second: ParsedArtifact['chat']) {
  if (!first || !second || !first.title || first.title !== second.title || first.group !== second.group) return 0
  const normalized = (text: string) => text.replace(/\s+/g, '')
  let found = 0
  for (let size = 2; size <= Math.min(first.messages.length, second.messages.length); size++) {
    const tail = first.messages.slice(-size)
    const head = second.messages.slice(0, size)
    if (tail.every((message, index) => message.sender === head[index].sender && normalized(message.text) === normalized(head[index].text))
      && tail.reduce((total, message) => total + normalized(message.text).length, 0) >= 16) found = size
  }
  return found
}

export async function approveEvidenceParsing(evidenceId: string, revision: string, text: string) {
  return runExclusiveWorkspaceMutation(async () => {
    const workspace = await readWorkspace()
    const evidence = workspace.evidences.find(item => item.id === evidenceId)
    if (!evidence) throw new AppError('材料不存在。', 404, 'EVIDENCE_NOT_FOUND')
    if (!evidence.parsing || evidence.parsing.revision !== revision || evidence.parsing.sourceKey !== sourceKey(evidence)) {
      throw new AppError('材料或解析结果已变化，请刷新后重新审核。', 409, 'PARSE_REVIEW_CONFLICT')
    }
    if (['queued', 'processing'].includes(evidence.parsing.status)) throw new AppError('解析正在进行，请完成后审核。', 409, 'PARSE_IN_PROGRESS')
    if (!text.trim() || text.length > 8_000_000) throw new AppError('请填写有效的材料正文。', 400, 'PARSE_TEXT_REQUIRED')
    evidence.ocrText = text.trim()
    evidence.parsing = { ...evidence.parsing, revision: randomUUID(), status: 'ready', reviewedAt: now(), updatedAt: now(), error: undefined }
    evidence.summaryStatus = 'idle'
    evidence.summaryCacheKey = undefined
    evidence.summaryText = undefined
    workspace.evidenceInsights = workspace.evidenceInsights.filter(item => item.evidenceId !== evidenceId)
    await writeWorkspace(workspace)
    return { workspace, caseId: evidence.caseId }
  })
}
