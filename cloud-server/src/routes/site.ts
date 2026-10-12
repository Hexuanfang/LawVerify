import { Router } from 'express'

import { config } from '../config.js'
import { sendSuccess } from '../http.js'
import { sitePlans } from '../mock-data.js'
import { getLatestPublicRelease, listPublicReleases, resolveReleaseDownloadAsset } from '../release-service.js'

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

siteRouter.get('/releases/latest', async (_request, response) => {
  const release = await getLatestPublicRelease()
  sendSuccess(response, release)
})

siteRouter.get('/releases', async (_request, response) => {
  const items = await listPublicReleases()
  sendSuccess(response, {
    items,
  })
})

siteRouter.get('/releases/:releaseId/download', async (request, response) => {
  const asset = await resolveReleaseDownloadAsset(String(request.params.releaseId))
  response.download(asset.filePath, asset.fileName)
})
