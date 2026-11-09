import { Router, type Request, type Response } from 'express'
import multer from 'multer'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { env } from '../config/env.js'
import { sendLegacyError } from '../core/api-response.js'
import { AppError } from '../core/app-error.js'
import { storeObjectFromPath } from '../infrastructure/object-storage.js'
import { runWithWorkspaceAccount } from '../store.js'
import { rememberCaseAgentCredential } from '../case-agent-billing.js'
import { rememberCloudAiToken } from '../integrations/cloud-ai.js'
import { getAssistantCapabilities, transcribeAssistantAudio, withAssistantModel, withRequestAbortSignal } from '../integrations/llm-service.js'
import { assistantOptionsSchema } from '../intelligence/assistant-options.js'
import { subscribeWorkspaceChanges } from '../infrastructure/workspace-events.js'
import { boundedFileStorage, reserveUpload, type UploadedFile } from '../middleware/bounded-upload.js'
import {
  bootstrap,
  caseAgentMessage,
  confirmCasePosition,
  retryCaseAgent,
  createCase,
  createCaseRecord,
  createCloudWorkspaceSession,
  deleteCase,
  deleteEvidence,
  clearCaseDirectoryEvidences,
  generateCertificate,
  importCertificate,
  importEvidences,
  getEvidenceSourceAssetStream,
  bindWorkspaceCloudAccount,
  login,
  autoLinkCertificate,
  rebuildCaseMemory,
  replaceCaseEvidences,
  recharge,
  reviewParagraphMatches,
  rewriteCertificate,
  sanitizeWorkspaceForClient,
  sanitizeCaseForClient,
  streamGenerateCertificate,
  streamRewriteCertificate,
  summarizeEvidence,
  updateCase,
  updateCaseRecord,
  updateEvidence,
  updateParagraph,
} from '../service.js'
import type { WorkspaceState } from '../domain.js'

const loginSchema = z.object({
  account: z.string().min(1),
  password: z.string().min(1),
  loginType: z.enum(['password', 'code']),
})

const bindCloudAccountSchema = z.object({
  email: z.string().email('请输入正确邮箱。'),
  name: z.string().trim().optional(),
  organization: z.string().trim().optional(),
  role: z.string().trim().optional(),
})

const createCloudSessionSchema = bindCloudAccountSchema

const createCaseSchema = z.object({
  name: z.string().trim().min(1, '案件名称不能为空。'),
  description: z.string().optional(),
})

export function createLegacyRouter() {
  const router = Router()
  // 材料原件按文件落盘：单文件上限可以放大，内存占用不随文件大小增长。
  const upload = multer({
    storage: boundedFileStorage(),
    limits: {
      fileSize: env.MAX_EVIDENCE_FILE_MB * 1024 * 1024,
      files: 200,
      fields: 10,
      fieldSize: 2 * 1024 * 1024,
    },
  })
  const resolveWorkspaceAccount = (request: Request) =>
    request.header('x-workspace-account')?.trim().toLowerCase()
    ?? (typeof request.query.workspaceAccount === 'string'
      ? request.query.workspaceAccount.trim().toLowerCase()
      : null)

  // #region debug-point A-B-C-D:route-reporting
  // 启用方式：设置环境变量 DEBUG_EVENT_URL=http://127.0.0.1:7777/event 后重启服务；未设置则不发送任何调试请求。
  const reportLegacyDebug = (hypothesisId: string, msg: string, data: Record<string, unknown> = {}) => {
    const debugEventUrl = env.DEBUG_EVENT_URL?.trim()
    if (!debugEventUrl) {
      return
    }

    void fetch(debugEventUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sessionId: 'backend-file-load',
        runId: 'pre-fix',
        hypothesisId,
        location: 'server/src/routes/legacy.ts',
        msg: `[DEBUG] ${msg}`,
        data,
        ts: Date.now(),
      }),
    }).catch(() => {})
  }
  // #endregion

  const sendWorkspacePayload = <T extends Record<string, unknown>>(response: Response, payload: T) => {
    const nextPayload = 'workspace' in payload && payload.workspace
      ? {
        ...payload,
        workspace: sanitizeWorkspaceForClient(payload.workspace as WorkspaceState),
      }
      : payload

    response.json(nextPayload)
  }

  const proxyCloudRequest = async (request: Request, response: Response) => {
    const targetBaseUrl = (request.header('x-cloud-base-url')?.trim() || env.CLOUD_API_BASE_URL?.trim() || '').replace(/\/$/, '')
    if (!targetBaseUrl) {
      sendLegacyError(response, 503, '当前桌面端尚未配置 LawVerify 账户服务地址，请更新至官网下载最新安装包。')
      return
    }

    const originalUrl = request.originalUrl || request.url
    const targetPathWithQuery = originalUrl.startsWith(`${request.baseUrl}`)
      ? originalUrl.slice(request.baseUrl.length)
      : request.url
    const targetPath = targetPathWithQuery || '/'

    const headers = new Headers()
    const authorization = request.header('authorization')
    const contentType = request.header('content-type')
    const accept = request.header('accept')

    if (authorization) {
      headers.set('authorization', authorization)
    }
    if (contentType) {
      headers.set('content-type', contentType)
    }
    if (accept) {
      headers.set('accept', accept)
    }
    if (request.header('x-product-surface') === 'desktop') {
      headers.set('x-product-surface', 'desktop')
    }

    const method = request.method.toUpperCase()
    const requestBody = method === 'GET' || method === 'HEAD'
      ? undefined
      : JSON.stringify(request.body ?? {})

    try {
      const upstream = await fetch(`${targetBaseUrl}${targetPath}`, {
        method,
        headers,
        body: requestBody,
        signal: AbortSignal.timeout(120000),
      })

      const payloadText = await upstream.text()
      const upstreamContentType = upstream.headers.get('content-type')
      if (upstreamContentType) {
        response.setHeader('content-type', upstreamContentType)
      }
      response.status(upstream.status).send(payloadText)
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message || '' : ''
      const lower = rawMessage.toLowerCase()
      const networkKeywords = ['fetch failed', 'failed to fetch', 'econnrefused', 'enotfound', 'getaddrinfo', 'timeout', 'timed out', 'network error']
      const message = networkKeywords.some((keyword) => lower.includes(keyword))
        ? '当前无法连接 LawVerify 账户服务，请检查网络后重试，或稍后再登录。'
        : `账户服务暂不可用，请稍后再试。${rawMessage ? `详情：${rawMessage}` : ''}`
      sendLegacyError(response, 502, message)
    }
  }

  const startEventStream = (response: Response) => {
    response.status(200)
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    response.setHeader('Cache-Control', 'no-cache, no-transform')
    response.setHeader('Connection', 'keep-alive')
    response.setHeader('X-Accel-Buffering', 'no')
    response.flushHeaders?.()
  }

  const sendStreamEvent = (response: Response, event: string, data: unknown) => {
    response.write(`event: ${event}\n`)
    response.write(`data: ${JSON.stringify(data)}\n\n`)
    response.flush?.()
  }

  router.get('/health', (_request, response) => {
    response.json({ ok: true })
  })

  router.get('/workspace/events', (request, response) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const unsubscribe = subscribeWorkspaceChanges(resolveWorkspaceAccount(request), () => {
      if (timer) return
      timer = setTimeout(() => {
        timer = undefined
        if (!response.destroyed) sendStreamEvent(response, 'changed', {})
      }, 500)
    })
    if (!unsubscribe) { response.sendStatus(429); return }
    startEventStream(response)
    sendStreamEvent(response, 'connected', {})
    const heartbeat = setInterval(() => {
      if (!response.destroyed) { response.write(': keepalive\n\n'); response.flush?.() }
    }, 30000)
    response.once('close', () => {
      clearTimeout(timer)
      clearInterval(heartbeat)
      unsubscribe()
    })
  })

  router.use((request, _response, next) => {
    runWithWorkspaceAccount(resolveWorkspaceAccount(request), () => {
      rememberCaseAgentCredential(request.header('x-case-agent-token'))
      rememberCloudAiToken(request.header('x-case-agent-token'))
      next()
    })
  })

  router.use('/cloud', (request, response) => {
    void proxyCloudRequest(request, response)
  })

  router.use('/certificates', async (request, _response, next) => {
    if (request.method !== 'POST' || !/^\/(?:generate(?:\/stream)?|[^/]+\/rewrite(?:\/stream)?)\/?$/.test(request.path)) return next()
    try { await withAssistantModel(request.body?.model, () => next()) } catch (error) { next(error) }
  })

  router.post('/auth/login', async (request, response) => {
    try {
      const payload = loginSchema.parse(request.body)
      const result = await login(payload)
      sendWorkspacePayload(response, result)
    } catch (error) {
      const message = error instanceof Error ? error.message : '登录失败'
      sendLegacyError(response, 400, message)
    }
  })

  router.post('/auth/cloud-bind', async (request, response) => {
    try {
      const payload = bindCloudAccountSchema.parse(request.body ?? {})
      const result = await bindWorkspaceCloudAccount(payload)
      sendWorkspacePayload(response, result)
    } catch (error) {
      const message = error instanceof Error ? error.message : '绑定失败'
      sendLegacyError(response, 400, message)
    }
  })

  router.post('/auth/cloud-session', async (request, response) => {
    try {
      const payload = createCloudSessionSchema.parse(request.body ?? {})
      const result = await createCloudWorkspaceSession(payload)
      sendWorkspacePayload(response, result)
    } catch (error) {
      const message = error instanceof Error ? error.message : '桌面端会话创建失败'
      sendLegacyError(response, 400, message)
    }
  })

  router.get('/workspace', async (_request, response) => {
    const result = await bootstrap()
    sendWorkspacePayload(response, result)
  })

  router.post('/billing/recharge', async (request, response) => {
    const amount = typeof request.body?.amount === 'number' ? request.body.amount : 100
    const result = await recharge(amount)
    sendWorkspacePayload(response, result)
  })

  router.post('/cases', async (request, response) => {
    try {
      const payload = createCaseSchema.parse(request.body)
      if (request.query.response === 'compact') {
        const result = await createCaseRecord(payload.name, payload.description)
        response.json({ ...result, cases: result.cases.map(sanitizeCaseForClient), caseFolder: sanitizeCaseForClient(result.caseFolder) })
        return
      }
      const result = await createCase(payload.name, payload.description)
      sendWorkspacePayload(response, result)
    } catch (error) {
      const message = error instanceof Error ? error.message : '案件创建失败'
      sendLegacyError(response, 400, message)
    }
  })

  router.patch('/cases/:caseId', async (request, response) => {
    if (request.query.response === 'compact') {
      const result = await updateCaseRecord(request.params.caseId, request.body ?? {})
      response.json({ cases: result.cases.map(sanitizeCaseForClient) })
      return
    }
    const result = await updateCase(request.params.caseId, request.body ?? {})
    sendWorkspacePayload(response, result)
  })

  router.post('/cases/:caseId/rebuild-memory', async (request, response) => {
    const result = await rebuildCaseMemory(request.params.caseId)
    sendWorkspacePayload(response, result)
  })

  router.post('/cases/:caseId/agent/message', async (request, response) => {
    const payload = z.object({
      message: z.string().trim().min(1).max(6000),
      intent: z.enum(['position', 'question']),
      options: assistantOptionsSchema.optional(),
    }).parse(request.body)
    sendWorkspacePayload(response, await caseAgentMessage(request.params.caseId, payload.message, payload.intent, payload.options))
  })

  router.get('/assistant/capabilities', async (_request, response) => {
    response.json(await getAssistantCapabilities())
  })
  const voiceUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1, fields: 0 } })
  router.post('/assistant/transcriptions', reserveUpload, voiceUpload.single('file'), async (request, response) => {
    if (!request.file || !['audio/webm', 'audio/mp4', 'audio/ogg', 'audio/wav'].includes(request.file.mimetype)) {
      throw new AppError('请提供有效的语音文件。', 400, 'INVALID_AUDIO')
    }
    response.json(await transcribeAssistantAudio(request.file.buffer, request.file.mimetype))
  })

  router.put('/cases/:caseId/agent/position', async (request, response) => {
    const payload = z.object({ position: z.unknown(), expectedVersion: z.number().int().nonnegative() }).parse(request.body)
    sendWorkspacePayload(response, await confirmCasePosition(request.params.caseId, payload.position, payload.expectedVersion))
  })

  router.post('/cases/:caseId/agent/retry', async (request, response) => {
    const payload = z.object({ autoAnalyze: z.boolean().optional() }).parse(request.body ?? {})
    sendWorkspacePayload(response, await retryCaseAgent(request.params.caseId, payload.autoAnalyze))
  })

  router.delete('/cases/:caseId', async (request, response) => {
    const result = await deleteCase(request.params.caseId)
    sendWorkspacePayload(response, result)
  })

  router.delete('/cases/:caseId/directory-evidences', async (request, response) => {
    sendWorkspacePayload(response, await clearCaseDirectoryEvidences(request.params.caseId))
  })

  router.post('/evidences/import', async (request, response) => {
    const result = await importEvidences(request.body)
    if (request.query.response === 'compact') {
      response.json({ imported: result.created.length })
      return
    }
    sendWorkspacePayload(response, result)
  })

  router.post('/evidences/assets/upload', reserveUpload, upload.array('files', 200), async (request, response) => {
    const files = Array.isArray(request.files) ? request.files : []
    const manifest = typeof request.body?.manifest === 'string'
      ? JSON.parse(request.body.manifest) as Array<{ relativePath?: string; fileName?: string; sourceMimeType?: string }>
      : []

    const assets = []
    for (const [index, file] of files.entries()) {
      const manifestItem = manifest[index] ?? {}
      const stored = await storeObjectFromPath({
        path: (file as Partial<UploadedFile>).path!,
        size: file.size,
        originalname: file.originalname,
        mimetype: file.mimetype,
        contentHash: (file as Partial<UploadedFile>).contentHash!,
      }, {
        bucket: 'evidence',
        fileName: manifestItem.fileName?.trim() || file.originalname,
      })

      assets.push({
        relativePath: manifestItem.relativePath?.trim() || file.originalname,
        fileName: manifestItem.fileName?.trim() || file.originalname,
        storageKey: stored.key,
        storageUrl: stored.url,
        sourceMimeType: manifestItem.sourceMimeType?.trim() || file.mimetype || undefined,
        contentHash: stored.contentHash,
      })
    }

    response.json({ assets })
  })

  router.post('/evidences/replace', async (request, response) => {
    const result = await replaceCaseEvidences(request.body)
    sendWorkspacePayload(response, result)
  })

  router.patch('/evidences/:evidenceId', async (request, response) => {
    const result = await updateEvidence(request.params.evidenceId, request.body ?? {})
    sendWorkspacePayload(response, result)
  })

  router.post('/evidences/:evidenceId/summarize', async (request, response) => {
    const result = await summarizeEvidence(request.params.evidenceId, {
      force: request.body?.force === true,
      cacheOnly: request.body?.cacheOnly === true,
    })
    sendWorkspacePayload(response, result)
  })

  router.get('/evidences/:evidenceId/source', async (request, response) => {
    try {
      // #region debug-point D:source-route-enter
      reportLegacyDebug('D', 'source-route-enter', {
        requestId: request.headers['x-request-id'] ?? null,
        evidenceId: request.params.evidenceId,
        workspaceAccount: resolveWorkspaceAccount(request),
        accept: request.headers.accept ?? null,
        secFetchDest: request.headers['sec-fetch-dest'] ?? null,
      })
      // #endregion
      const asset = await getEvidenceSourceAssetStream(request.params.evidenceId)
      response.setHeader('Content-Type', asset.mimeType)
      response.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(asset.fileName)}"`)
      response.removeHeader('X-Frame-Options')
      // #region debug-point B-C:source-route-success
      reportLegacyDebug('B', 'source-route-success', {
        requestId: request.headers['x-request-id'] ?? null,
        evidenceId: request.params.evidenceId,
        mimeType: asset.mimeType,
        fileName: asset.fileName,
      })
      // #endregion
      // 流式回传原件：几百页的扫描件不会因为一次预览就把整份文件读进内存。
      asset.stream.once('error', () => {
        if (!response.headersSent) {
          sendLegacyError(response, 404, '读取证据原件失败')
          return
        }
        response.destroy()
      })
      asset.stream.pipe(response)
    } catch (error) {
      const message = error instanceof Error ? error.message : '读取证据原件失败'
      sendLegacyError(response, 404, message)
    }
  })

  router.delete('/evidences/:evidenceId', async (request, response) => {
    const result = await deleteEvidence(request.params.evidenceId)
    if (request.query.response === 'compact') {
      response.json({ deleted: true })
      return
    }
    sendWorkspacePayload(response, result)
  })

  router.post('/certificates/generate', async (request, response) => {
    try {
      const result = await generateCertificate(request.body)
      sendWorkspacePayload(response, result)
    } catch (error) {
      const message = error instanceof Error ? error.message : '生成失败'
      sendLegacyError(response, 400, message)
    }
  })

  router.post('/certificates/generate/stream', async (request, response) => {
    startEventStream(response)
    // 客户端断开（用户点击“停止”）时中断模型生成，避免服务端继续消耗调用。
    const abortController = new AbortController()
    response.once('close', () => abortController.abort())

    try {
      await withRequestAbortSignal(abortController.signal, () => streamGenerateCertificate(request.body, async (event) => {
        if (event.type === 'done') {
          sendStreamEvent(response, 'done', {
            ...event,
            workspace: sanitizeWorkspaceForClient(event.workspace as WorkspaceState),
          })
          return
        }

        sendStreamEvent(response, event.type, event)
      }))
    } catch (error) {
      if (!response.destroyed && !abortController.signal.aborted) {
        const message = error instanceof Error ? error.message : '生成失败'
        sendStreamEvent(response, 'error', { message })
      }
    } finally {
      if (!response.destroyed) response.end()
    }
  })

  router.post('/certificates/:certificateId/rewrite', async (request, response) => {
    try {
      const result = await rewriteCertificate({
        certificateId: request.params.certificateId,
        evidenceIds: Array.isArray(request.body?.evidenceIds) ? request.body.evidenceIds : [],
        prompt: typeof request.body?.prompt === 'string' ? request.body.prompt : '',
      })
      sendWorkspacePayload(response, result)
    } catch (error) {
      const message = error instanceof Error ? error.message : '改写失败'
      sendLegacyError(response, 400, message)
    }
  })

  router.post('/certificates/:certificateId/rewrite/stream', async (request, response) => {
    startEventStream(response)
    // 客户端断开（用户点击“停止”）时中断模型改写，避免服务端继续消耗调用。
    const abortController = new AbortController()
    response.once('close', () => abortController.abort())

    try {
      await withRequestAbortSignal(abortController.signal, () => streamRewriteCertificate({
        certificateId: request.params.certificateId,
        evidenceIds: Array.isArray(request.body?.evidenceIds) ? request.body.evidenceIds : [],
        prompt: typeof request.body?.prompt === 'string' ? request.body.prompt : '',
      }, async (event) => {
        if (event.type === 'done') {
          sendStreamEvent(response, 'done', {
            ...event,
            workspace: sanitizeWorkspaceForClient(event.workspace as WorkspaceState),
          })
          return
        }

        sendStreamEvent(response, event.type, event)
      }))
    } catch (error) {
      if (!response.destroyed && !abortController.signal.aborted) {
        const message = error instanceof Error ? error.message : '改写失败'
        sendStreamEvent(response, 'error', { message })
      }
    } finally {
      if (!response.destroyed) response.end()
    }
  })

  router.post('/certificates/import', async (request, response) => {
    try {
      const result = await importCertificate(request.body)
      sendWorkspacePayload(response, result)
    } catch (error) {
      const message = error instanceof Error ? error.message : '导入失败'
      sendLegacyError(response, 400, message)
    }
  })

  router.patch('/certificates/:certificateId/paragraphs/:paragraphId', async (request, response) => {
    const result = await updateParagraph(
      request.params.certificateId,
      request.params.paragraphId,
      request.body ?? {},
    )
    sendWorkspacePayload(response, result)
  })

  router.post('/certificates/:certificateId/auto-link/stream', async (request, response) => {
    startEventStream(response)
    // 客户端断开（用户点击“停止”或关闭窗口）时中止联动，避免服务端继续消耗模型调用。
    const abortController = new AbortController()
    const abortOnDisconnect = () => abortController.abort()
    response.once('close', abortOnDisconnect)
    const heartbeat = setInterval(() => {
      if (!response.destroyed) {
        response.write(': heartbeat\n\n')
        response.flush?.()
      }
    }, 15000)
    const stopHeartbeat = () => clearInterval(heartbeat)
    response.once('close', stopHeartbeat)
    try {
      const result = await autoLinkCertificate(request.params.certificateId, (text) => {
        if (!response.destroyed) sendStreamEvent(response, 'progress', { text })
      }, { signal: abortController.signal })
      if (!response.destroyed) {
        sendStreamEvent(response, 'done', {
          ...result,
          workspace: sanitizeWorkspaceForClient(result.workspace),
        })
      }
    } catch (error) {
      if (!response.destroyed && !abortController.signal.aborted) {
        sendStreamEvent(response, 'error', {
          message: error instanceof Error ? error.message : '证据联动未完成，请稍后重试。',
        })
      }
    } finally {
      stopHeartbeat()
      response.off('close', abortOnDisconnect)
      response.off('close', stopHeartbeat)
      if (!response.destroyed) response.end()
    }
  })

  router.post('/certificates/:certificateId/auto-link', async (request, response) => {
    try {
      const result = await autoLinkCertificate(request.params.certificateId)
      sendWorkspacePayload(response, result)
    } catch (error) {
      const message = error instanceof Error ? error.message : '自动联动失败'
      sendLegacyError(response, 400, message)
    }
  })

  router.post('/certificates/:certificateId/paragraphs/:paragraphId/ai-review', async (request, response) => {
    try {
      const result = await reviewParagraphMatches(request.params.certificateId, request.params.paragraphId)
      sendWorkspacePayload(response, result)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'AI 复核失败'
      sendLegacyError(response, 400, message)
    }
  })

  router.get('/commercial/readiness', async (_request, response) => {
    const workspace = await bootstrap()
    response.json({
      maturityLevel: 'foundation',
      currentStorage: 'json-file',
      currentAuth: 'demo-token',
      readyForNextPhase: [
        'postgresql',
        'rbac',
        'object-storage',
        'ocr-pipeline',
        'llm-orchestration',
      ],
      snapshot: {
        caseCount: workspace.workspace.cases.length,
        evidenceCount: workspace.workspace.evidences.length,
        certificateCount: workspace.workspace.certificates.length,
      },
    })
  })

  router.use((_request, _response, next) => {
    next(new AppError('Legacy API route not found', 404, 'ROUTE_NOT_FOUND'))
  })

  return router
}
