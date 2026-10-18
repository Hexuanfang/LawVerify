import { Router, type Request } from 'express'
import multer from 'multer'
import express from 'express'
import { z } from 'zod'
import { createRechargePaymentOrder, getBillingCatalog, getRechargePaymentOrder, listRechargePaymentOrders } from '../billing-service.js'
import { getCurrentActorProfile, loginAccount, registerAccount } from '../commercial/auth-service.js'
import { listAuditLogs } from '../commercial/audit-service.js'
import { createUploadedEvidenceRecord } from '../commercial/file-service.js'
import { createMember, listMembers } from '../commercial/organization-service.js'
import { sendSuccess } from '../core/api-response.js'
import { authenticate, requirePermission } from '../middleware/authenticate.js'
import { storeObject } from '../infrastructure/object-storage.js'
import { isDatabaseEnabled } from '../infrastructure/postgres.js'
import { runWithWorkspaceAccount } from '../store.js'
import {
  getCollaboraSession,
  getWopiFileInfo,
  isCollaboraEnabled,
  readWopiFileContents,
  verifyWopiAccessToken,
  writeWopiFileContents,
} from '../integrations/collabora-service.js'
import { getLlmRuntimeStatus, pingLlm } from '../integrations/llm-service.js'
import { env } from '../config/env.js'
import {
  bootstrap,
  createCase,
  deleteCase,
  deleteEvidence,
  generateCertificate,
  importCertificate,
  importEvidences,
  bindWorkspaceCloudAccount,
  login,
  autoLinkCertificate,
  replaceCaseEvidences,
  listKnowledgeCases,
  listOfficialLegalSources,
  listKnowledgeStatutes,
  getKnowledgeCaseDetail,
  importKnowledgeCases,
  getKnowledgeStatuteDetail,
  importKnowledgeStatutes,
  importKnowledgeFiles,
  recharge,
  recommendKnowledgeFiles,
  reindexKnowledgeFile,
  reviewParagraphMatches,
  rewriteCertificate,
  recommendKnowledgeCases,
  recommendKnowledgeStatutes,
  sanitizeWorkspaceForClient,
  streamGenerateCertificate,
  streamRewriteCertificate,
  summarizeEvidence,
  uploadKnowledgeFiles,
  updateCase,
  updateEvidence,
  updateParagraph,
} from '../service.js'
import type { WorkspaceState } from '../domain.js'

const loginSchema = z.object({
  account: z.string().min(1, '请输入账号。'),
  password: z.string().min(1, '请输入密码或验证码。'),
  loginType: z.enum(['password', 'code']),
})

const createCaseSchema = z.object({
  name: z.string().min(1, '案件名称不能为空。'),
})

const rechargeSchema = z.object({
  amount: z.number().int().positive().default(100),
})

const createRechargeOrderSchema = z.object({
  channel: z.enum(['alipay', 'wechat']),
  packageId: z.string().min(1, '充值套餐不能为空。'),
})

const registerSchema = z.object({
  organizationName: z.string().min(2, '请输入组织名称。'),
  ownerName: z.string().min(2, '请输入负责人姓名。'),
  email: z.string().email('请输入正确邮箱。'),
  password: z.string().min(8, '密码至少 8 位。'),
})

const commercialLoginSchema = z.object({
  email: z.string().email('请输入正确邮箱。'),
  password: z.string().min(8, '密码至少 8 位。'),
})

const bindCloudAccountSchema = z.object({
  email: z.string().email('请输入正确邮箱。'),
  name: z.string().trim().optional(),
  organization: z.string().trim().optional(),
  role: z.string().trim().optional(),
})

const createMemberSchema = z.object({
  email: z.string().email('请输入正确邮箱。'),
  name: z.string().min(2, '请输入成员姓名。'),
  role: z.enum(['owner', 'admin', 'lawyer', 'reviewer', 'assistant', 'viewer']),
  title: z.string().optional(),
})

const uploadSchema = z.object({
  caseId: z.string().uuid().optional(),
})

function getRequestOrigin(request: Request) {
  const forwardedProto = String(request.headers['x-forwarded-proto'] ?? '').split(',')[0]?.trim()
  const forwardedHost = String(request.headers['x-forwarded-host'] ?? request.headers.host ?? '').split(',')[0]?.trim()
  const proto = forwardedProto || request.protocol || 'https'
  const host = forwardedHost || new URL(env.APP_PUBLIC_BASE_URL).host
  return `${proto}://${host}`.replace(/\/$/, '')
}

export function createV1Router() {
  const router = Router()
  const resolveWorkspaceAccount = (request: Request) =>
    request.header('x-workspace-account')?.trim().toLowerCase()
    ?? (typeof request.query.workspaceAccount === 'string'
      ? request.query.workspaceAccount.trim().toLowerCase()
      : null)
  const startEventStream = (response: express.Response) => {
    response.status(200)
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    response.setHeader('Cache-Control', 'no-cache, no-transform')
    response.setHeader('Connection', 'keep-alive')
    response.setHeader('X-Accel-Buffering', 'no')
    response.flushHeaders?.()
  }

  const sendStreamEvent = (response: express.Response, event: string, data: unknown) => {
    response.write(`event: ${event}\n`)
    response.write(`data: ${JSON.stringify(data)}\n\n`)
    response.flush?.()
  }
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } })

  router.use((request, _response, next) => {
    runWithWorkspaceAccount(resolveWorkspaceAccount(request), () => next())
  })

  router.get('/system/health', (_request, response) => {
    sendSuccess(response, {
      ok: true,
      service: 'lawverify-server',
      timestamp: new Date().toISOString(),
    })
  })

  router.get('/system/readiness', async (_request, response) => {
    const { workspace } = await bootstrap()
    const llmStatus = getLlmRuntimeStatus()
    sendSuccess(response, {
      productStage: 'foundation',
      database: {
        enabled: isDatabaseEnabled(),
        provider: 'postgresql',
      },
      capabilities: {
        auth: 'demo-login',
        storage: 'json-file',
        workspace: true,
        evidenceViewer: true,
        certificateLinking: true,
        collabora: isCollaboraEnabled(),
        llmConfigured: llmStatus.configured,
      },
      roadmap: [
        'enterprise-auth-ready',
        'rbac-ready',
        'postgresql-ready',
        'object-storage-ready',
        'ocr-service',
        'llm-evidence-linking',
      ],
      counters: {
        cases: workspace.cases.length,
        evidences: workspace.evidences.length,
        certificates: workspace.certificates.length,
      },
    })
  })

  router.get('/system/llm/status', (_request, response) => {
    sendSuccess(response, getLlmRuntimeStatus())
  })

  router.post('/system/llm/ping', async (_request, response) => {
    const result = await pingLlm()
    sendSuccess(response, result)
  })

  router.get('/integrations/collabora/status', (_request, response) => {
    sendSuccess(response, {
      enabled: isCollaboraEnabled(),
    })
  })

  router.post('/integrations/collabora/certificates/:certificateId/session', async (request, response) => {
    const requestOrigin = getRequestOrigin(request)
    const session = await getCollaboraSession(request.params.certificateId, {
      appBaseUrl: requestOrigin,
      collaboraBaseUrl: `${requestOrigin}${env.COLLABORA_PROXY_PATH}`,
    })
    sendSuccess(response, session)
  })

  router.get('/wopi/files/:fileId', async (request, response) => {
    const accessToken = String(request.query.access_token ?? '')
    const fileId = request.params.fileId

    if (!verifyWopiAccessToken(accessToken, fileId)) {
      response.status(401).json({ message: 'WOPI access token 无效。' })
      return
    }

    const file = await getWopiFileInfo(fileId)
    response.json({
      BaseFileName: file.fileName,
      Size: file.size,
      Version: file.version,
      OwnerId: 'lawverify',
      UserId: 'lawverify-user',
      UserFriendlyName: 'LawVerify User',
      UserCanWrite: env.COLLABORA_WOPI_ALLOW_EDIT,
      ReadOnly: !env.COLLABORA_WOPI_ALLOW_EDIT,
      SupportsUpdate: env.COLLABORA_WOPI_ALLOW_EDIT,
      SupportsLocks: false,
      SupportsRename: false,
      SupportsUserInfo: false,
      HidePrintOption: false,
      HideSaveOption: false,
    })
  })

  router.get('/wopi/files/:fileId/contents', async (request, response) => {
    const accessToken = String(request.query.access_token ?? '')
    const fileId = request.params.fileId

    if (!verifyWopiAccessToken(accessToken, fileId)) {
      response.status(401).json({ message: 'WOPI access token 无效。' })
      return
    }

    const file = await getWopiFileInfo(fileId)
    const contents = await readWopiFileContents(fileId)
    response.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    response.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(file.fileName)}"`)
    response.send(contents)
  })

  router.post(
    '/wopi/files/:fileId/contents',
    express.raw({ type: '*/*', limit: '50mb' }),
    async (request, response) => {
      const accessToken = String(request.query.access_token ?? '')
      const fileId = request.params.fileId

      if (!verifyWopiAccessToken(accessToken, fileId)) {
        response.status(401).json({ message: 'WOPI access token 无效。' })
        return
      }

      const override = String(request.header('x-wopi-override') ?? '').toUpperCase()
      const body = Buffer.isBuffer(request.body) ? request.body : Buffer.from([])

      if (!env.COLLABORA_WOPI_ALLOW_EDIT) {
        response.status(403).json({ message: '当前 Collabora 会话为只读模式。' })
        return
      }

      if (override && override !== 'PUT') {
        response.status(501).json({ message: `暂未支持的 WOPI override: ${override}` })
        return
      }

      const file = await writeWopiFileContents(fileId, body)
      response.setHeader('X-WOPI-ItemVersion', file.version)
      response.status(200).end()
    },
  )

  router.post('/iam/register', async (request, response) => {
    const payload = registerSchema.parse(request.body)
    const result = await registerAccount(payload)
    sendSuccess(response, result)
  })

  router.post('/iam/login', async (request, response) => {
    const payload = commercialLoginSchema.parse(request.body)
    const result = await loginAccount(payload)
    sendSuccess(response, result)
  })

  router.get('/iam/me', authenticate, async (request, response) => {
    const result = await getCurrentActorProfile({
      sub: request.actor!.userId,
      organizationId: request.actor!.organizationId,
      membershipId: request.actor!.membershipId,
      role: request.actor!.role,
      email: request.actor!.email,
    })
    sendSuccess(response, result)
  })

  router.get(
    '/organizations/current/members',
    authenticate,
    requirePermission('member.manage'),
    async (request, response) => {
      const result = await listMembers(request.actor!)
      sendSuccess(response, { members: result })
    },
  )

  router.post(
    '/organizations/current/members',
    authenticate,
    requirePermission('member.manage'),
    async (request, response) => {
      const payload = createMemberSchema.parse(request.body)
      const result = await createMember(request.actor!, payload)
      sendSuccess(response, result)
    },
  )

  router.post(
    '/files/upload',
    authenticate,
    requirePermission('evidence.upload'),
    upload.single('file'),
    async (request, response) => {
      if (!request.file) {
        throw new Error('请选择要上传的文件。')
      }

      const payload = uploadSchema.parse(request.body ?? {})
      const stored = await storeObject(request.file)
      const evidence = await createUploadedEvidenceRecord(request.actor!, {
        caseId: payload.caseId,
        fileName: request.file.originalname,
        mimeType: request.file.mimetype,
        size: request.file.size,
        storageKey: stored.key,
        storageUrl: stored.url,
        provider: stored.provider,
        bucket: stored.bucket,
      })

      sendSuccess(response, {
        evidence,
        object: stored,
      })
    },
  )

  router.get(
    '/audit-logs',
    authenticate,
    requirePermission('audit.read'),
    async (request, response) => {
      const limit = Number(request.query.limit ?? 50)
      const logs = await listAuditLogs(request.actor!.organizationId, Number.isNaN(limit) ? 50 : limit)
      sendSuccess(response, { logs })
    },
  )

  router.post('/auth/login', async (request, response) => {
    const payload = loginSchema.parse(request.body)
    const result = await login(payload)
    sendSuccess(response, result)
  })

  router.post('/auth/cloud-bind', async (request, response) => {
    const payload = bindCloudAccountSchema.parse(request.body ?? {})
    const result = await bindWorkspaceCloudAccount(payload)
    sendSuccess(response, result)
  })

  router.get('/workspace', async (_request, response) => {
    const result = await bootstrap()
    sendSuccess(response, result)
  })

  router.post('/billing/recharge', async (request, response) => {
    const payload = rechargeSchema.parse({
      amount: typeof request.body?.amount === 'number' ? request.body.amount : 100,
    })
    const result = await recharge(payload.amount)
    sendSuccess(response, result)
  })

  router.get('/billing/catalog', async (_request, response) => {
    const result = await getBillingCatalog()
    sendSuccess(response, result)
  })

  router.post('/billing/orders', async (request, response) => {
    const payload = createRechargeOrderSchema.parse(request.body ?? {})
    const result = await createRechargePaymentOrder(payload)
    sendSuccess(response, result)
  })

  router.get('/billing/orders/:orderId', async (request, response) => {
    const result = await getRechargePaymentOrder(request.params.orderId)
    sendSuccess(response, result)
  })

  router.get('/billing/orders', async (request, response) => {
    const limit = Number.parseInt(String(request.query.limit ?? '50'), 10)
    const result = await listRechargePaymentOrders(Number.isNaN(limit) ? 50 : limit)
    sendSuccess(response, result)
  })

  router.post('/cases', async (request, response) => {
    const payload = createCaseSchema.parse(request.body)
    const result = await createCase(payload.name)
    sendSuccess(response, result)
  })

  router.patch('/cases/:caseId', async (request, response) => {
    const result = await updateCase(request.params.caseId, request.body ?? {})
    sendSuccess(response, result)
  })

  router.delete('/cases/:caseId', async (request, response) => {
    const result = await deleteCase(request.params.caseId)
    sendSuccess(response, result)
  })

  router.post('/evidences/import', async (request, response) => {
    const result = await importEvidences(request.body)
    sendSuccess(response, result)
  })

  router.post('/evidences/replace', async (request, response) => {
    const result = await replaceCaseEvidences(request.body)
    sendSuccess(response, result)
  })

  router.patch('/evidences/:evidenceId', async (request, response) => {
    const result = await updateEvidence(request.params.evidenceId, request.body ?? {})
    sendSuccess(response, result)
  })

  router.post('/evidences/:evidenceId/summarize', async (request, response) => {
    const result = await summarizeEvidence(request.params.evidenceId, {
      force: request.body?.force === true,
      cacheOnly: request.body?.cacheOnly === true,
    })
    sendSuccess(response, result)
  })

  router.delete('/evidences/:evidenceId', async (request, response) => {
    const result = await deleteEvidence(request.params.evidenceId)
    sendSuccess(response, result)
  })

  router.post('/certificates/generate', async (request, response) => {
    const result = await generateCertificate(request.body)
    sendSuccess(response, result)
  })

  router.post('/certificates/generate/stream', async (request, response) => {
    startEventStream(response)

    try {
      await streamGenerateCertificate(request.body, async (event) => {
        if (event.type === 'done') {
          sendStreamEvent(response, 'done', {
            ...event,
            workspace: sanitizeWorkspaceForClient(event.workspace as WorkspaceState),
          })
          return
        }

        sendStreamEvent(response, event.type, event)
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : '生成失败'
      sendStreamEvent(response, 'error', { message })
    } finally {
      response.end()
    }
  })

  router.post('/certificates/:certificateId/rewrite', async (request, response) => {
    const result = await rewriteCertificate({
      certificateId: request.params.certificateId,
      evidenceIds: Array.isArray(request.body?.evidenceIds) ? request.body.evidenceIds : [],
      prompt: typeof request.body?.prompt === 'string' ? request.body.prompt : '',
    })
    sendSuccess(response, result)
  })

  router.post('/certificates/:certificateId/rewrite/stream', async (request, response) => {
    startEventStream(response)

    try {
      await streamRewriteCertificate({
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
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : '改写失败'
      sendStreamEvent(response, 'error', { message })
    } finally {
      response.end()
    }
  })

  router.post('/certificates/import', async (request, response) => {
    const result = await importCertificate(request.body)
    sendSuccess(response, result)
  })

  router.patch('/certificates/:certificateId/paragraphs/:paragraphId', async (request, response) => {
    const result = await updateParagraph(
      request.params.certificateId,
      request.params.paragraphId,
      request.body ?? {},
    )
    sendSuccess(response, result)
  })

  router.post('/certificates/:certificateId/auto-link', async (request, response) => {
    const result = await autoLinkCertificate(request.params.certificateId)
    sendSuccess(response, result)
  })

  router.post('/certificates/:certificateId/paragraphs/:paragraphId/ai-review', async (request, response) => {
    const result = await reviewParagraphMatches(request.params.certificateId, request.params.paragraphId)
    sendSuccess(response, result)
  })

  router.get('/knowledge/cases', async (request, response) => {
    const result = await listKnowledgeCases({
      keyword: typeof request.query.keyword === 'string' ? request.query.keyword : undefined,
      focusTag: typeof request.query.focusTag === 'string' ? request.query.focusTag : undefined,
      cause: typeof request.query.cause === 'string' ? request.query.cause : undefined,
    })
    sendSuccess(response, result)
  })

  router.get('/knowledge/cases/:caseId', async (request, response) => {
    const result = await getKnowledgeCaseDetail(request.params.caseId)
    sendSuccess(response, result)
  })

  router.get('/knowledge/statutes', async (request, response) => {
    const result = await listKnowledgeStatutes({
      keyword: typeof request.query.keyword === 'string' ? request.query.keyword : undefined,
      docType: typeof request.query.docType === 'string' ? request.query.docType : undefined,
      effectiveStatus: typeof request.query.effectiveStatus === 'string' ? request.query.effectiveStatus : undefined,
    })
    sendSuccess(response, result)
  })

  router.get('/knowledge/sources', async (_request, response) => {
    const result = await listOfficialLegalSources()
    sendSuccess(response, result)
  })

  router.get('/knowledge/statutes/:documentId', async (request, response) => {
    const result = await getKnowledgeStatuteDetail(request.params.documentId)
    sendSuccess(response, result)
  })

  router.post('/knowledge/statutes/import', async (request, response) => {
    const result = await importKnowledgeStatutes({
      items: Array.isArray(request.body?.items) ? request.body.items : [],
    })
    sendSuccess(response, result)
  })

  router.post('/knowledge/cases/import', async (request, response) => {
    const result = await importKnowledgeCases({
      items: Array.isArray(request.body?.items) ? request.body.items : [],
    })
    sendSuccess(response, result)
  })

  router.post('/knowledge/files/import', async (request, response) => {
    const result = await importKnowledgeFiles({
      files: Array.isArray(request.body?.files) ? request.body.files : [],
    })
    sendSuccess(response, result)
  })

  router.post(
    '/knowledge/files/upload',
    upload.array('files', 200),
    async (request, response) => {
      const files = Array.isArray(request.files) ? request.files : []
      const manifest = typeof request.body?.manifest === 'string'
        ? JSON.parse(request.body.manifest) as Array<{ title?: string; relativePath?: string }>
        : undefined

      const result = await uploadKnowledgeFiles({
        files,
        manifest,
      })
      sendSuccess(response, result)
    },
  )

  router.post('/knowledge/files/:fileId/reindex', async (request, response) => {
    const result = await reindexKnowledgeFile(request.params.fileId)
    sendSuccess(response, result)
  })

  router.post('/knowledge/recommend/files', async (request, response) => {
    const result = await recommendKnowledgeFiles(request.body ?? {})
    sendSuccess(response, result)
  })

  router.post('/knowledge/recommend/cases', async (request, response) => {
    const result = await recommendKnowledgeCases(request.body ?? {})
    sendSuccess(response, result)
  })

  router.post('/knowledge/recommend/statutes', async (request, response) => {
    const result = await recommendKnowledgeStatutes(request.body ?? {})
    sendSuccess(response, result)
  })

  return router
}
