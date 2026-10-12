import type { Response } from 'express'

export function sendSuccess<T>(response: Response, data: T) {
  response.json({
    success: true,
    data,
  })
}
