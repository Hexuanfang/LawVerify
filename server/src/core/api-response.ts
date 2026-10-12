import type { Response } from 'express'

export function sendSuccess<T>(
  response: Response,
  data: T,
  meta?: Record<string, unknown>,
) {
  response.json({
    success: true,
    requestId: response.locals.requestId,
    data,
    meta,
  })
}

export function sendLegacyError(response: Response, statusCode: number, message: string) {
  response.status(statusCode).json({ message })
}
