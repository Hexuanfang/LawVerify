import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { env } from '../config/env.js'
import { getStorageRoot } from '../config/paths.js'
import type { StoredObject } from '../commercial/types.js'

export async function storeObject(
  file: Express.Multer.File,
  options?: {
    bucket?: string
    fileName?: string
  },
): Promise<StoredObject> {
  const datePartition = new Date().toISOString().slice(0, 10)
  const bucket = options?.bucket?.trim() || 'evidence'
  const resolvedFileName = options?.fileName?.trim() || file.originalname
  const ext = path.extname(resolvedFileName)
  const key = `${bucket}/${datePartition}/${randomUUID()}${ext}`
  const root = getStorageRoot()
  const fullPath = path.join(root, key)
  await mkdir(path.dirname(fullPath), { recursive: true })
  await writeFile(fullPath, file.buffer)

  return {
    key,
    bucket,
    originalName: resolvedFileName,
    mimeType: file.mimetype || 'application/octet-stream',
    size: file.size,
    url: `${env.STORAGE_PUBLIC_BASE_URL}/${key}`.replace(/\\/g, '/'),
    provider: 'local',
  }
}

export async function readObject(key: string) {
  const normalizedKey = key.replace(/\\/g, '/').replace(/^\/+/, '')
  const root = getStorageRoot()
  const fullPath = path.join(root, normalizedKey)
  return readFile(fullPath)
}
