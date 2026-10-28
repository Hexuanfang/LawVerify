import type multer from 'multer'
import type { RequestHandler } from 'express'
import { AppError } from '../core/app-error.js'

let activeUploads = 0
const maxBatchBytes = 128 * 1024 * 1024

// Bound the aggregate payload, not just each file. Two concurrent batches maximum.
export const reserveUpload: RequestHandler = (request, response, next) => {
  if (Number(request.header('content-length') ?? 0) > maxBatchBytes) {
    next(new AppError('本批材料超过128MB，请拆分后上传。', 413, 'UPLOAD_BATCH_TOO_LARGE'))
    return
  }
  if (activeUploads >= 2) {
    next(new AppError('正在接收其他材料，请稍后重试。', 429, 'UPLOAD_BUSY'))
    return
  }
  activeUploads++
  let released = false
  const release = () => { if (!released) { released = true; activeUploads-- } }
  response.once('close', release)
  response.once('finish', release)
  next()
}

export function boundedMemoryStorage(): multer.StorageEngine {
  const totals = new WeakMap<object, number>()
  return {
    _handleFile(request, file, callback) {
      const chunks: Buffer[] = []
      let size = 0
      let finished = false
      const finish = (error?: Error) => {
        if (finished) return
        finished = true
        file.stream.removeListener('data', count)
        file.stream.removeListener('end', ended)
        file.stream.removeListener('error', failed)
        if (error) { chunks.length = 0; callback(error); return }
        callback(null, { buffer: Buffer.concat(chunks, size), size })
      }
      const failed = (error: Error) => finish(error)
      const ended = () => finish()
      const count = (chunk: Buffer) => {
        const bytes = (totals.get(request) ?? 0) + chunk.length
        totals.set(request, bytes)
        if (bytes > maxBatchBytes) {
          file.stream.destroy(new AppError('本批材料超过128MB，请拆分后上传。', 413, 'UPLOAD_BATCH_TOO_LARGE'))
          return
        }
        chunks.push(chunk)
        size += chunk.length
      }
      file.stream.on('data', count)
      file.stream.once('end', ended)
      file.stream.once('error', failed)
    },
    _removeFile(_request, file, callback) { file.buffer = Buffer.alloc(0); callback(null) },
  }
}
