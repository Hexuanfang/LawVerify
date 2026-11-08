import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
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
  // 落盘上传的文件直接搬进存储目录，不再经过内存。
  const uploadedPath = (file as Express.Multer.File & { path?: string; contentHash?: string }).path
  if (uploadedPath) {
    const stored = await storeObjectFromPath({
      path: uploadedPath,
      size: file.size,
      originalname: file.originalname,
      mimetype: file.mimetype,
      contentHash: (file as Express.Multer.File & { contentHash?: string }).contentHash ?? '',
    }, options)
    return stored
  }

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

// 原件落盘后的绝对路径：大文件原件解析时直接读路径，不必再进一次内存。
export function readObjectPath(key: string) {
  const normalizedKey = key.replace(/\\/g, '/').replace(/^\/+/, '')
  const root = getStorageRoot()
  return path.join(root, normalizedKey)
}

// 从落盘的临时文件搬进存储目录：优先改名（同一分区不复制数据），跨分区才复制。
export async function storeObjectFromPath(
  file: { path: string; size: number; originalname: string; mimetype: string; contentHash: string },
  options?: {
    bucket?: string
    fileName?: string
  },
): Promise<StoredObject & { contentHash: string }> {
  const datePartition = new Date().toISOString().slice(0, 10)
  const bucket = options?.bucket?.trim() || 'evidence'
  const resolvedFileName = options?.fileName?.trim() || file.originalname
  const ext = path.extname(resolvedFileName)
  const key = `${bucket}/${datePartition}/${randomUUID()}${ext}`
  const root = getStorageRoot()
  const fullPath = path.join(root, key)
  await mkdir(path.dirname(fullPath), { recursive: true })

  try {
    await rename(file.path, fullPath)
  } catch {
    // 跨分区或目标已存在时退回复制，再清理临时文件。
    await copyFile(file.path, fullPath)
    await rm(file.path, { force: true })
  }

  return {
    key,
    bucket,
    originalName: resolvedFileName,
    mimeType: file.mimetype || 'application/octet-stream',
    size: file.size,
    url: `${env.STORAGE_PUBLIC_BASE_URL}/${key}`.replace(/\\/g, '/'),
    provider: 'local',
    contentHash: file.contentHash,
  }
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
