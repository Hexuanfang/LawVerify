import { extractStatuteCitations, inspectLegalText, isOfficialCaseUrl, normalizeCaseNumber, rankCases, type CaseSearchOptions } from './intelligence/legal-verification.js'
import { readWorkspace } from './store.js'
import { extractStatuteMentions, listKnowledgeStatutes, resolveStatuteMentionFromOfficialSource } from './service.js'
import { isYuandianCaseSearchConfigured, searchYuandianCases } from './integrations/yuandian-mcp.js'
import { isWkCaseSearchConfigured, searchWkCases } from './integrations/wk-mcp.js'
import { isPkulawCaseSearchConfigured, searchPkulawCases } from './integrations/pkulaw-mcp.js'
import type { KnowledgeCase } from './domain.js'
import { checkOfficialJudgment } from './intelligence/official-case-verification.js'

function withDeadline<T>(task: Promise<T>, signal: AbortSignal) {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error('Lookup deadline exceeded'))
    if (signal.aborted) { task.catch(() => {}); abort(); return }
    signal.addEventListener('abort', abort, { once: true })
    task.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

async function externalCases(query: string, signal = AbortSignal.timeout(90000)) {
  const tasks: Promise<KnowledgeCase[]>[] = []
  if (isYuandianCaseSearchConfigured()) tasks.push(searchYuandianCases(query, 10))
  if (isWkCaseSearchConfigured()) tasks.push(searchWkCases(query, 10))
  if (isPkulawCaseSearchConfigured()) tasks.push(searchPkulawCases(query, 10))
  const results = await Promise.allSettled(tasks.map(task => withDeadline(task, signal)))
  return { items: results.flatMap(r => r.status === 'fulfilled' ? r.value : []),
    configuredProviders: tasks.length, failedProviders: results.filter(r => r.status === 'rejected').length }
}

export async function searchWeightedCases(options: CaseSearchOptions) {
  const workspace = await readWorkspace()
  const remote = await externalCases([options.keyword, options.courtName, options.judgeName].filter(Boolean).join(' '))
  const seen = new Set<string>()
  const items = [...remote.items, ...workspace.knowledgeCases].filter(c => {
    const key = `${normalizeCaseNumber(c.caseNumber)}:${c.title}`
    if (seen.has(key)) return false
    seen.add(key); return true
  })
  const semanticRanks = new Map(remote.items.map((entry, index) => [entry.id, index]))
  return { ...remote, items: rankCases(items, options, semanticRanks).slice(0, 100) }
}

export async function verifyLegalText(text: string, online = false) {
  const deadline = AbortSignal.timeout(90000)
  const workspace = await readWorkspace()
  workspace.knowledgeStatutes = (await listKnowledgeStatutes()).items
  const previous = inspectLegalText(text, workspace.knowledgeStatutes, workspace.knowledgeCases)
  const citations = extractStatuteCitations(text)
  if (online) {
    // Only citation names/numbers go to external lookup, never the surrounding document.
    const mentions = citations.filter(c => previous.some(f => f.kind === 'statute' && f.from === c.from))
      .flatMap(c => extractStatuteMentions(`《${c.title}》第${c.number ?? '一'}条`, 1))
      .filter((m, i, all) => all.findIndex(n => n.lawTitle === m.lawTitle && n.articleNumber === m.articleNumber) === i)
      .slice(0, 20)
    let cursor = 0
    const worker = async () => {
      while (cursor < mentions.length && !deadline.aborted) {
        const mention = mentions[cursor++]
        await resolveStatuteMentionFromOfficialSource(workspace, mention, deadline).catch(() => null)
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, mentions.length) }, worker))
  }
  const findings = inspectLegalText(text, workspace.knowledgeStatutes, workspace.knowledgeCases)
  for (let i = 0; i < findings.length; i++) {
    const old = previous.find(f => f.from === findings[i].from && f.kind === 'statute')
    if (old && (old.status === 'repealed' || old.status === 'amended')) findings[i] = old
  }
  if (online) for (const finding of findings.filter(f => f.kind === 'case' && f.status === 'unverified').slice(0, 10)) {
    if (deadline.aborted) break
    const remote = await externalCases(normalizeCaseNumber(finding.text), deadline)
    const candidates = [...remote.items, ...workspace.knowledgeCases]
      .filter(c => normalizeCaseNumber(c.caseNumber) === normalizeCaseNumber(finding.text))
    const entry = candidates.find(c => c.sourceUrl && isOfficialCaseUrl(c.sourceUrl))
    if (!deadline.aborted && entry?.sourceUrl && await withDeadline(checkOfficialJudgment(entry.sourceUrl, finding.text), deadline).catch(() => false)) {
      finding.status = 'verified'
      finding.message = '已在法院官方原文中查到该案号；请继续核对裁判内容。'
      finding.sourceUrl = entry.sourceUrl
      finding.checkedAt = new Date().toISOString()
    } else if (candidates.length) {
      finding.sourceUrl = candidates[0].sourceUrl
      finding.message = '找到同案号案例记录，未能核实法院官方原文。'
    }
  }
  return { findings, checkedAt: new Date().toISOString(), online, timedOut: online && deadline.aborted,
    truncated: online && (citations.length > 20 || findings.filter(f => f.kind === 'case').length > 10) }
}
