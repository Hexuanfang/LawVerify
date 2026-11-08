import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import type multer from 'multer'
import type { RequestHandler } from 'express'
import { AppError } from '../core/app-error.js'
import { env } from '../config/env.js'
import { getWorkspaceDataDir } from '../config/paths.js'

let activeUploads = 0
const maxBatchBytes = env.MAX_UPLOAD_BATCH_MB * 1024 * 1024
export const maxUploadBatchBytes = maxBatchBytes
export const maxEvidenceFileBytes = env.MAX_EVIDENCE_FILE_MB * 1024 * 1024

// Bound the aggregate payload, not just each file. Two concurrent batches maximum.
export const reserveUpload: RequestHandler = (request, response, next) => {
  if (Number(request.header('content-length') ?? 0) > maxBatchBytes) {
    next(new AppError(`本批材料超过${env.MAX_UPLOAD_BATCH_MB}MB，请拆分后上传。`, 413, 'UPLOAD_BATCH_TOO_LARGE'))
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

export type UploadedFile = Express.Multer.File & {
  path: string
  contentHash: string
}

// 上传按文件落盘：内存占用与文件大小无关，几百页的扫描件也能直接接入。
export function boundedFileStorage(): multer.StorageEngine {
  return {
    async _handleFile(request, file, callback) {
      const tempDir = path.join(getWorkspaceDataDir(), 'upload-tmp')
      try {
        await mkdir(tempDir, { recursive: true })
      } catch (error) {
        callback(error as Error)
        return
      }

      const tempPath = path.join(tempDir, randomUUID())
      const hash = createHash('sha256')
      const target = createWriteStream(tempPath)
      let size = 0
      let settled = false

      const fail = (error: Error) => {
        if (settled) {
          return
        }
        settled = true
        target.destroy()
        void rm(tempPath, { force: true })
        callback(error)
      }

      file.stream.on('data', (chunk: Buffer) => {
        hash.update(chunk)
        size += chunk.length
      })
      file.stream.once('error', fail)
      target.once('error', fail)
      target.once('finish', () => {
        if (settled) {
          return
        }
        settled = true
        callback(null, {
          path: tempPath,
          size,
          contentHash: hash.digest('hex'),
        } as unknown as Express.Multer.File)
      })

      file.stream.pipe(target)
    },
    _removeFile(_request, file, callback) {
      const tempPath = (file as Partial<UploadedFile>).path
      if (tempPath) {
        void rm(tempPath, { force: true })
      }
      callback(null)
    },
  }
}
