import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
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

// 只允许回收证据桶里的上传原件：知识库文件与 Collabora 会话目录不在此列。
const DELETABLE_OBJECT_KEY = /^evidence\/\d{4}-\d{2}-\d{2}\/[A-Za-z0-9._-]+$/

export async function deleteObject(key: string) {
  const normalizedKey = key.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!DELETABLE_OBJECT_KEY.test(normalizedKey)) {
    throw new Error('存储对象 key 不合法，无法删除。')
  }

  const root = getStorageRoot()
  const fullPath = path.join(root, normalizedKey)
  // 二次校验绝对路径仍在存储根目录内，避免 key 越界删除其它文件。
  const relative = path.relative(root, fullPath)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('存储对象路径越界，无法删除。')
  }

  await rm(fullPath, { force: true })
}
