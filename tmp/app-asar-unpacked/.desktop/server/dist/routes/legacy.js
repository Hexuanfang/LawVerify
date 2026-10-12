import { Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env.js';
import { sendLegacyError } from '../core/api-response.js';
import { AppError } from '../core/app-error.js';
import { bootstrap, createCase, createCloudWorkspaceSession, deleteCase, deleteEvidence, generateCertificate, importCertificate, importEvidences, getEvidenceSourceAsset, bindWorkspaceCloudAccount, login, autoLinkCertificate, replaceCaseEvidences, recharge, reviewParagraphMatches, rewriteCertificate, sanitizeWorkspaceForClient, streamGenerateCertificate, streamRewriteCertificate, summarizeEvidence, updateCase, updateEvidence, updateParagraph, } from '../service.js';
const loginSchema = z.object({
    account: z.string().min(1),
    password: z.string().min(1),
    loginType: z.enum(['password', 'code']),
});
const bindCloudAccountSchema = z.object({
    email: z.string().email('请输入正确邮箱。'),
    name: z.string().trim().optional(),
    organization: z.string().trim().optional(),
    role: z.string().trim().optional(),
});
const createCloudSessionSchema = bindCloudAccountSchema;
const createCaseSchema = z.object({
    name: z.string().min(1, '案件名称不能为空。'),
});
export function createLegacyRouter() {
    const router = Router();
    // #region debug-point A-B-C-D:route-reporting
    const reportLegacyDebug = (hypothesisId, msg, data = {}) => {
        void fetch('http://127.0.0.1:7777/event', {
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
        }).catch(() => { });
    };
    // #endregion
    const sendWorkspacePayload = (response, payload) => {
        const nextPayload = 'workspace' in payload && payload.workspace
            ? {
                ...payload,
                workspace: sanitizeWorkspaceForClient(payload.workspace),
            }
            : payload;
        response.json(nextPayload);
    };
    const proxyCloudRequest = async (request, response) => {
        const targetBaseUrl = (env.CLOUD_API_BASE_URL?.trim() || request.header('x-cloud-base-url')?.trim() || '').replace(/\/$/, '');
        if (!targetBaseUrl) {
            sendLegacyError(response, 503, '当前桌面端未配置平台账户服务地址，请先配置官网地址后再试。');
            return;
        }
        const originalUrl = request.originalUrl || request.url;
        const targetPathWithQuery = originalUrl.startsWith(`${request.baseUrl}`)
            ? originalUrl.slice(request.baseUrl.length)
            : request.url;
        const targetPath = targetPathWithQuery || '/';
        const headers = new Headers();
        const authorization = request.header('authorization');
        const contentType = request.header('content-type');
        const accept = request.header('accept');
        if (authorization) {
            headers.set('authorization', authorization);
        }
        if (contentType) {
            headers.set('content-type', contentType);
        }
        if (accept) {
            headers.set('accept', accept);
        }
        const method = request.method.toUpperCase();
        const requestBody = method === 'GET' || method === 'HEAD'
            ? undefined
            : JSON.stringify(request.body ?? {});
        try {
            const upstream = await fetch(`${targetBaseUrl}${targetPath}`, {
                method,
                headers,
                body: requestBody,
            });
            const payloadText = await upstream.text();
            const upstreamContentType = upstream.headers.get('content-type');
            if (upstreamContentType) {
                response.setHeader('content-type', upstreamContentType);
            }
            response.status(upstream.status).send(payloadText);
        }
        catch (error) {
            sendLegacyError(response, 502, error instanceof Error ? error.message : '平台账户服务暂不可用，请稍后再试。');
        }
    };
    const startEventStream = (response) => {
        response.status(200);
        response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        response.setHeader('Cache-Control', 'no-cache, no-transform');
        response.setHeader('Connection', 'keep-alive');
        response.setHeader('X-Accel-Buffering', 'no');
        response.flushHeaders?.();
    };
    const sendStreamEvent = (response, event, data) => {
        response.write(`event: ${event}\n`);
        response.write(`data: ${JSON.stringify(data)}\n\n`);
        response.flush?.();
    };
    router.get('/health', (_request, response) => {
        response.json({ ok: true });
    });
    router.use('/cloud', (request, response) => {
        void proxyCloudRequest(request, response);
    });
    router.post('/auth/login', async (request, response) => {
        try {
            const payload = loginSchema.parse(request.body);
            const result = await login(payload);
            sendWorkspacePayload(response, result);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : '登录失败';
            sendLegacyError(response, 400, message);
        }
    });
    router.post('/auth/cloud-bind', async (request, response) => {
        try {
            const payload = bindCloudAccountSchema.parse(request.body ?? {});
            const result = await bindWorkspaceCloudAccount(payload);
            sendWorkspacePayload(response, result);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : '绑定失败';
            sendLegacyError(response, 400, message);
        }
    });
    router.post('/auth/cloud-session', async (request, response) => {
        try {
            const payload = createCloudSessionSchema.parse(request.body ?? {});
            const result = await createCloudWorkspaceSession(payload);
            sendWorkspacePayload(response, result);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : '桌面端会话创建失败';
            sendLegacyError(response, 400, message);
        }
    });
    router.get('/workspace', async (request, response) => {
        // #region debug-point A:workspace-route-enter
        reportLegacyDebug('A', 'workspace-route-enter', {
            requestId: request.headers['x-request-id'] ?? null,
        });
        // #endregion
        try {
            const result = await bootstrap();
            // #region debug-point A:workspace-route-success
            reportLegacyDebug('A', 'workspace-route-success', {
                requestId: request.headers['x-request-id'] ?? null,
                caseCount: result.workspace.cases.length,
                evidenceCount: result.workspace.evidences.length,
                certificateCount: result.workspace.certificates.length,
            });
            // #endregion
            sendWorkspacePayload(response, result);
        }
        catch (error) {
            // #region debug-point A:workspace-route-error
            reportLegacyDebug('A', 'workspace-route-error', {
                requestId: request.headers['x-request-id'] ?? null,
                message: error instanceof Error ? error.message : String(error),
            });
            // #endregion
            throw error;
        }
    });
    router.post('/billing/recharge', async (request, response) => {
        const amount = typeof request.body?.amount === 'number' ? request.body.amount : 100;
        const result = await recharge(amount);
        sendWorkspacePayload(response, result);
    });
    router.post('/cases', async (request, response) => {
        try {
            const payload = createCaseSchema.parse(request.body);
            const result = await createCase(payload.name);
            sendWorkspacePayload(response, result);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : '案件创建失败';
            sendLegacyError(response, 400, message);
        }
    });
    router.patch('/cases/:caseId', async (request, response) => {
        const result = await updateCase(request.params.caseId, request.body ?? {});
        sendWorkspacePayload(response, result);
    });
    router.delete('/cases/:caseId', async (request, response) => {
        const result = await deleteCase(request.params.caseId);
        sendWorkspacePayload(response, result);
    });
    router.post('/evidences/import', async (request, response) => {
        const result = await importEvidences(request.body);
        sendWorkspacePayload(response, result);
    });
    router.post('/evidences/replace', async (request, response) => {
        const result = await replaceCaseEvidences(request.body);
        sendWorkspacePayload(response, result);
    });
    router.patch('/evidences/:evidenceId', async (request, response) => {
        const result = await updateEvidence(request.params.evidenceId, request.body ?? {});
        sendWorkspacePayload(response, result);
    });
    router.post('/evidences/:evidenceId/summarize', async (request, response) => {
        const result = await summarizeEvidence(request.params.evidenceId);
        sendWorkspacePayload(response, result);
    });
    router.get('/evidences/:evidenceId/source', async (request, response) => {
        try {
            // #region debug-point D:source-route-enter
            reportLegacyDebug('D', 'source-route-enter', {
                requestId: request.headers['x-request-id'] ?? null,
                evidenceId: request.params.evidenceId,
                accept: request.headers.accept ?? null,
                secFetchDest: request.headers['sec-fetch-dest'] ?? null,
            });
            // #endregion
            const asset = await getEvidenceSourceAsset(request.params.evidenceId);
            response.setHeader('Content-Type', asset.mimeType);
            response.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(asset.fileName)}"`);
            response.removeHeader('X-Frame-Options');
            // #region debug-point B-C:source-route-success
            reportLegacyDebug('B', 'source-route-success', {
                requestId: request.headers['x-request-id'] ?? null,
                evidenceId: request.params.evidenceId,
                mimeType: asset.mimeType,
                fileName: asset.fileName,
                bufferLength: asset.buffer.length,
            });
            // #endregion
            response.send(asset.buffer);
        }
        catch (error) {
            // #region debug-point C:source-route-error
            reportLegacyDebug('C', 'source-route-error', {
                requestId: request.headers['x-request-id'] ?? null,
                evidenceId: request.params.evidenceId,
                message: error instanceof Error ? error.message : String(error),
            });
            // #endregion
            const message = error instanceof Error ? error.message : '读取证据原件失败';
            sendLegacyError(response, 404, message);
        }
    });
    router.delete('/evidences/:evidenceId', async (request, response) => {
        const result = await deleteEvidence(request.params.evidenceId);
        sendWorkspacePayload(response, result);
    });
    router.post('/certificates/generate', async (request, response) => {
        try {
            const result = await generateCertificate(request.body);
            sendWorkspacePayload(response, result);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : '生成失败';
            sendLegacyError(response, 400, message);
        }
    });
    router.post('/certificates/generate/stream', async (request, response) => {
        startEventStream(response);
        try {
            await streamGenerateCertificate(request.body, async (event) => {
                if (event.type === 'done') {
                    sendStreamEvent(response, 'done', {
                        ...event,
                        workspace: sanitizeWorkspaceForClient(event.workspace),
                    });
                    return;
                }
                sendStreamEvent(response, event.type, event);
            });
        }
        catch (error) {
            const message = error instanceof Error ? error.message : '生成失败';
            sendStreamEvent(response, 'error', { message });
        }
        finally {
            response.end();
        }
    });
    router.post('/certificates/:certificateId/rewrite', async (request, response) => {
        try {
            const result = await rewriteCertificate({
                certificateId: request.params.certificateId,
                evidenceIds: Array.isArray(request.body?.evidenceIds) ? request.body.evidenceIds : [],
                prompt: typeof request.body?.prompt === 'string' ? request.body.prompt : '',
            });
            sendWorkspacePayload(response, result);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : '改写失败';
            sendLegacyError(response, 400, message);
        }
    });
    router.post('/certificates/:certificateId/rewrite/stream', async (request, response) => {
        startEventStream(response);
        try {
            await streamRewriteCertificate({
                certificateId: request.params.certificateId,
                evidenceIds: Array.isArray(request.body?.evidenceIds) ? request.body.evidenceIds : [],
                prompt: typeof request.body?.prompt === 'string' ? request.body.prompt : '',
            }, async (event) => {
                if (event.type === 'done') {
                    sendStreamEvent(response, 'done', {
                        ...event,
                        workspace: sanitizeWorkspaceForClient(event.workspace),
                    });
                    return;
                }
                sendStreamEvent(response, event.type, event);
            });
        }
        catch (error) {
            const message = error instanceof Error ? error.message : '改写失败';
            sendStreamEvent(response, 'error', { message });
        }
        finally {
            response.end();
        }
    });
    router.post('/certificates/import', async (request, response) => {
        try {
            const result = await importCertificate(request.body);
            sendWorkspacePayload(response, result);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : '导入失败';
            sendLegacyError(response, 400, message);
        }
    });
    router.patch('/certificates/:certificateId/paragraphs/:paragraphId', async (request, response) => {
        const result = await updateParagraph(request.params.certificateId, request.params.paragraphId, request.body ?? {});
        sendWorkspacePayload(response, result);
    });
    router.post('/certificates/:certificateId/auto-link', async (request, response) => {
        try {
            const result = await autoLinkCertificate(request.params.certificateId);
            sendWorkspacePayload(response, result);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : '自动联动失败';
            sendLegacyError(response, 400, message);
        }
    });
    router.post('/certificates/:certificateId/paragraphs/:paragraphId/ai-review', async (request, response) => {
        try {
            const result = await reviewParagraphMatches(request.params.certificateId, request.params.paragraphId);
            sendWorkspacePayload(response, result);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : 'AI 复核失败';
            sendLegacyError(response, 400, message);
        }
    });
    router.get('/commercial/readiness', async (_request, response) => {
        const workspace = await bootstrap();
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
        });
    });
    router.use((_request, _response, next) => {
        next(new AppError('Legacy API route not found', 404, 'ROUTE_NOT_FOUND'));
    });
    return router;
}
