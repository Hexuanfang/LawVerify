import type { NextFunction, Request, Response } from 'express'
import { sendLegacyError } from '../core/api-response.js'
import { toAppError } from '../core/app-error.js'

export function notFound(_request: Request, response: Response) {
  sendLegacyError(response, 404, '接口不存在')
}

export function errorHandler(
  error: unknown,
  _request: Request,
  response: Response,
  _next: NextFunction,
) {
  const appError = toAppError(error)
  response.status(appError.statusCode).json({
    success: false,
    requestId: response.locals.requestId,
    error: {
      code: appError.code,
      message: appError.message,
      details: appError.details,
    },
  })
}
