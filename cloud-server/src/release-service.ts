import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'

import { config } from './config.js'
import { AppError } from './core/app-error.js'
import { releases as fallbackReleases } from './mock-data.js'
import type { ReleaseItem } from './types.js'

type LocalReleaseAsset = ReleaseItem & {
  fileName: string
  filePath: string
}

function buildReleaseDownloadUrl(releaseId: string) {
  return `${config.CLOUD_PUBLIC_BASE_URL}/api/web/releases/${encodeURIComponent(releaseId)}/download`
}

function getReleaseDirectory() {
  return path.resolve(config.cloudServerRoot, '..', 'app', 'release')
}

function formatSizeLabel(bytes: number) {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function normalizeReleaseId(fileName: string) {
  return fileName.replace(/[^a-zA-Z0-9.-]+/g, '-').toLowerCase()
}

function inferVersion(fileName: string) {
  const matched = fileName.match(/(?:LawVerify|LexVerify)-Setup-([^.]+\.[^.]+\.[^.]+)\.exe/i)
  return matched?.[1] ?? 'unknown'
}

async function getLocalReleaseAssets(): Promise<LocalReleaseAsset[]> {
  try {
    const directory = getReleaseDirectory()
    const fileNames = await readdir(directory)
    const installerFiles = fileNames.filter((item) => /^(?:LawVerify|LexVerify)-Setup-.*\.exe$/i.test(item))

    const assets = await Promise.all(installerFiles.map(async (fileName) => {
      const filePath = path.join(directory, fileName)
      const fileStat = await stat(filePath)
      const releaseId = normalizeReleaseId(fileName)
      return {
        id: releaseId,
        version: inferVersion(fileName),
        channel: 'stable',
        sizeLabel: formatSizeLabel(fileStat.size),
        publishedAt: fileStat.mtime.toISOString(),
        sha256: '本地构建产物，待补充校验值',
        notes: [
          '当前下载源来自本地 app/release 目录中的真实安装包。',
          '建议在发布正式版本前补充 SHA256 与更新说明。',
        ],
        downloadUrl: buildReleaseDownloadUrl(releaseId),
        fileName,
        filePath,
      }
    }))

    return assets.sort((left, right) => new Date(right.publishedAt).getTime() - new Date(left.publishedAt).getTime())
  } catch {
    return []
  }
}

export async function listPublicReleases() {
  const localAssets = await getLocalReleaseAssets()
  if (localAssets.length) {
    return localAssets.map<ReleaseItem>(({ fileName: _fileName, filePath: _filePath, ...item }) => item)
  }

  return fallbackReleases.map((item) => ({
    ...item,
    downloadUrl: buildReleaseDownloadUrl(item.id),
  }))
}

export async function getLatestPublicRelease() {
  const items = await listPublicReleases()
  return items[0] ?? null
}

export async function resolveReleaseDownloadAsset(releaseId: string) {
  const localAssets = await getLocalReleaseAssets()
  const matched = localAssets.find((item) => item.id === releaseId)

  if (!matched) {
    const fallbackMatched = fallbackReleases.find((item) => item.id === releaseId)
    if (fallbackMatched && localAssets.length) {
      return localAssets[0]
    }

    throw new AppError('当前未找到可下载的 Windows 安装包。', 404, 'RELEASE_NOT_FOUND')
  }

  return matched
}
