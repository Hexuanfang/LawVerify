import express, { Router, type Request, type Response, type NextFunction } from 'express'
import path from 'node:path'

export function createParserResourceRouter(directory: string) {
  const router = Router()
  router.use((request, response, next) => {
    if (!/^\/[a-f0-9]{64}\.tar\.gz$/.test(request.path)) {
      response.sendStatus(404)
      return
    }
    next()
  })
  router.use(express.static(directory, {
    index: false, dotfiles: 'deny', fallthrough: false, etag: false, lastModified: false,
    setHeaders(response, file) {
      response.setHeader('Content-Type', 'application/gzip')
      response.setHeader('Cache-Control', 'public, max-age=31536000, immutable, no-transform')
      response.setHeader('ETag', `"${path.basename(file, '.tar.gz')}"`)
    },
  }))
  router.use((error: Error & { status?: number }, _request: Request, response: Response, next: NextFunction) => {
    if (error.status === 404 || error.status === 416) {
      response.status(error.status).end()
      return
    }
    next(error)
  })
  return router
}
