import { realpathSync, rmSync } from 'node:fs'
import path from 'node:path'

export type CaseFile = `asset:${string}` | `evidence:${string}` | `office:${string}` | `parse:${string}` | `parse-input:${string}`

export const OFFICE_FILE_ID = /^[a-f0-9-]{36}$/i
export const ASSET_HASH = /^[a-f0-9]{64}$/
export const PARSE_ARTIFACT = /^[a-f0-9-]+\.json$/
export const PARSE_INPUT = /^[a-f0-9-]+\.[a-z0-9.]*$/i

export function parseInputName(id: string, fileName: string) {
  return id + (path.extname(fileName).replace(/[^.a-z0-9]/gi, '') || '.png')
}

export function evidenceObjectKey(key: string) {
  const normalized = key.trim().replace(/\\/g, '/').replace(/^\/+/, '')
  const fileName = /^evidence\/\d{4}-\d{2}-\d{2}\/([^/]+)$/.exec(normalized)?.[1]
  if (!fileName || /^[. ]+$/.test(fileName) || /[<>:"|?*\p{Cc}]/u.test(fileName)) return null
  return normalized
}

export function caseFileIdentity(file: CaseFile) {
  if (process.platform !== 'win32') return file
  const normalized = file.startsWith('evidence:') ? file.replace(/[. ]+$/, '') : file
  return normalized.toLowerCase() as CaseFile
}

export function collectCaseFileReferences(data: unknown, files: Set<CaseFile>) {
  const visit = (value: unknown) => {
    if (!value || typeof value !== 'object') return
    const record = value as Record<string, unknown>
    if (typeof record.storageKey === 'string') {
      const key = evidenceObjectKey(record.storageKey)
      if (key) files.add(`evidence:${key}`)
    }
    if (typeof record.__lawverifyAsset === 'string' && ASSET_HASH.test(record.__lawverifyAsset)) {
      files.add(`asset:${record.__lawverifyAsset}`)
    }
    const officeId = (record.officeFile as { id?: unknown } | undefined)?.id
    if (typeof officeId === 'string' && OFFICE_FILE_ID.test(officeId)) files.add(`office:${officeId.toLowerCase()}`)
    const parsing = record.parsing as { artifactKey?: unknown; sourceKey?: unknown } | undefined
    if (typeof parsing?.artifactKey === 'string' && PARSE_ARTIFACT.test(parsing.artifactKey)) {
      files.add(`parse:${parsing.artifactKey}`)
    }
    // 旧版会把内嵌原件按来源哈希留在解析输入目录。
    if (typeof parsing?.sourceKey === 'string' && ASSET_HASH.test(parsing.sourceKey)
      && typeof record.fileName === 'string' && !record.storageKey && (record.sourceDataUrl || record.previewDataUrl)) {
      files.add(`parse-input:${parseInputName(parsing.sourceKey, record.fileName)}`)
    }
    for (const child of Object.values(record)) visit(child)
  }
  visit(data)
}

export function readCaseFileReferences(payload: string, files: Set<CaseFile>) {
  if (/"(?:storageKey|officeFile|__lawverifyAsset|artifactKey|sourceKey)"/.test(payload)) {
    collectCaseFileReferences(JSON.parse(payload), files)
  }
}

export function removeManagedFile(root: string, relativeFile: string) {
  const target = path.resolve(root, relativeFile)
  const relative = path.relative(root, target)
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('文件路径超出应用存储目录。')
  }
  try {
    const canonicalRoot = realpathSync(root)
    const parent = realpathSync(path.dirname(target))
    // 禁止通过子目录的符号链接或联接点跨到用户原件目录。
    if (path.relative(path.join(canonicalRoot, path.dirname(relative)), parent)) {
      throw new Error('文件目录指向了应用存储之外的位置。')
    }
    rmSync(path.join(parent, path.basename(target)), { force: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}
