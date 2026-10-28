import { Router, type NextFunction, type Request, type Response } from 'express'

import { config } from '../config.js'
import { AppError } from '../core/app-error.js'
import { sendSuccess } from '../http.js'
import { sitePlans } from '../mock-data.js'
import { getReleaseSha256 } from '../release-checksum.js'
import { buildReleaseDownloadUrl, getLatestPublicRelease, listPublicReleases, resolveReleaseDownloadAsset } from '../release-service.js'

export const siteRouter = Router()

siteRouter.get('/site/config', (_request, response) => {
  sendSuccess(response, {
    siteName: 'LawVerify',
    appName: config.CLOUD_APP_NAME,
    webOrigin: config.primaryWebOrigin,
    supportEmail: 'support@lawverify.com',
    accountCenterUrl: `${config.primaryWebOrigin}/console`,
  })
})

siteRouter.get('/plans', (_request, response) => {
  sendSuccess(response, {
    items: sitePlans,
  })
})

siteRouter.get('/releases/latest', async (request, response) => {
  const platform = request.query.platform === undefined ? 'win32' : String(request.query.platform)
  const arch = request.query.arch === undefined ? 'x64' : String(request.query.arch)
  const release = await getLatestPublicRelease(platform, arch)
  sendSuccess(response, release)
})

siteRouter.get('/releases', async (_request, response) => {
  const items = await listPublicReleases()
  sendSuccess(response, {
    items,
  })
})

siteRouter.get('/releases/:releaseId/checksum', async (request, response) => {
  const asset = await resolveReleaseDownloadAsset(String(request.params.releaseId))
  const sha256 = await getReleaseSha256(asset.filePath)
  response.setHeader('Cache-Control', 'no-cache')
  response.setHeader('Content-Disposition', `attachment; filename="${asset.fileName}.sha256"`)
  response.type('text/plain').send(`${sha256}  ${asset.fileName}\n`)
})

async function downloadRelease(request: Request, response: Response, next: NextFunction, immutable = false) {
  const asset = await resolveReleaseDownloadAsset(String(request.params.releaseId))
  const sha256 = await getReleaseSha256(asset.filePath)
  if (!immutable && config.RELEASE_DOWNLOAD_BASE_URL) {
    response.redirect(302, buildReleaseDownloadUrl(asset.id, sha256, asset.fileName))
    return
  }
  if (immutable && (request.params.sha256 !== sha256 || request.params.fileName !== asset.fileName)) {
    throw new AppError('安装包已更新，请从下载中心获取最新版本。', 404, 'RELEASE_NOT_FOUND')
  }
  response.download(asset.filePath, asset.fileName, {
    headers: {
      'Cache-Control': immutable
        ? 'public, max-age=31536000, immutable, no-transform'
        : 'public, max-age=0, must-revalidate, no-transform',
      'ETag': `"${sha256}"`,
    },
  }, (error) => {
    if (!error || request.aborted || response.destroyed) return
    if (response.headersSent) {
      response.destroy()
    } else if ((error as Error & { status?: number }).status === 416) {
      response.status(416).setHeader('Content-Length', '0')
      response.end()
    } else {
      next(error)
    }
  })
}

siteRouter.get('/releases/:releaseId/download', downloadRelease)
siteRouter.get('/releases/:releaseId/files/:sha256/:fileName', (request, response, next) => {
  return downloadRelease(request, response, next, true)
})
