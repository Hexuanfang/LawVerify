import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'

import { config } from './config.js'
import { AppError } from './core/app-error.js'
import { getReleaseSha256 } from './release-checksum.js'
import { parseReleaseFileName } from './release-platform.js'
import type { ReleaseItem } from './types.js'

type LocalReleaseAsset = ReleaseItem & {
  fileName: string
  filePath: string
}

export function buildReleaseDownloadUrl(
  releaseId: string,
  sha256?: string,
  fileName?: string,
  downloadBase = config.RELEASE_DOWNLOAD_BASE_URL,
) {
  if (downloadBase && sha256 && fileName) {
    return `${downloadBase.replace(/\/$/, '')}/${sha256}/${encodeURIComponent(fileName)}`
  }
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

async function getLocalReleaseAssets(): Promise<LocalReleaseAsset[]> {
  try {
    const directory = getReleaseDirectory()
    const fileNames = await readdir(directory)
    const installerFiles = fileNames.filter((item) => parseReleaseFileName(item) !== null)

    const assets = await Promise.all(installerFiles.map(async (fileName) => {
      const filePath = path.join(directory, fileName)
      const fileStat = await stat(filePath)
      const releaseId = normalizeReleaseId(fileName)
      return {
        id: releaseId,
        ...parseReleaseFileName(fileName)!,
        sizeLabel: formatSizeLabel(fileStat.size),
        publishedAt: fileStat.mtime.toISOString(),
        sha256: '',
        notes: [],
        downloadUrl: buildReleaseDownloadUrl(releaseId),
        fileName,
        filePath,
      }
    }))

    return assets.sort((left, right) => {
      const a = left.version.split('.').map(Number)
      const b = right.version.split('.').map(Number)
      return b[0] - a[0] || b[1] - a[1] || b[2] - a[2]
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function toPublicRelease(asset: LocalReleaseAsset): Promise<ReleaseItem> {
  const { fileName: _fileName, filePath, ...item } = asset
  const sha256 = await getReleaseSha256(filePath)
  const base = `${config.CLOUD_PUBLIC_BASE_URL}/api/web/releases/${encodeURIComponent(asset.id)}`
  return {
    ...item,
    sha256,
    downloadUrl: buildReleaseDownloadUrl(asset.id, sha256, asset.fileName),
    checksumUrl: `${base}/checksum`,
  }
}

export async function listPublicReleases() {
  const localAssets = await getLocalReleaseAssets()
  const items: ReleaseItem[] = []
  // Limit disk reads when the release directory contains many historical versions.
  for (const asset of localAssets) items.push(await toPublicRelease(asset))
  return items
}

export async function getLatestPublicRelease(platform = 'win32', arch = 'x64') {
  if (!['win32', 'darwin'].includes(platform) || !['x64', 'arm64'].includes(arch)) {
    throw new AppError('不支持的客户端平台或芯片类型。', 400, 'INVALID_RELEASE_PLATFORM')
  }
  const assets = await getLocalReleaseAssets()
  const latest = assets.find((asset) => asset.platform === platform && asset.arch === arch && asset.channel === 'stable')
  return latest ? toPublicRelease(latest) : null
}

export async function resolveReleaseDownloadAsset(releaseId: string) {
  const localAssets = await getLocalReleaseAssets()
  const matched = localAssets.find((item) => item.id === releaseId)

  if (!matched) {
    throw new AppError('当前未找到可下载的安装包。', 404, 'RELEASE_NOT_FOUND')
  }

  return matched
}
