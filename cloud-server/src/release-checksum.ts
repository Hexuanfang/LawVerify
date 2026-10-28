import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'

const cache = new Map<string, { fingerprint: string; value: Promise<string> }>()

export async function getReleaseSha256(filePath: string): Promise<string> {
  const before = await stat(filePath)
  const fingerprint = `${before.size}:${before.mtimeMs}:${before.ctimeMs}`
  const cached = cache.get(filePath)
  if (cached?.fingerprint === fingerprint) return cached.value

  const value = (async () => {
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(filePath)) hash.update(chunk)
    const after = await stat(filePath)
    if (`${after.size}:${after.mtimeMs}:${after.ctimeMs}` !== fingerprint) {
      throw new Error('Installer changed while calculating its checksum')
    }
    return hash.digest('hex')
  })()
  // Cache concurrent requests too, without loading installers into memory.
  cache.set(filePath, { fingerprint, value })
  try {
    return await value
  } catch (error) {
    if (cache.get(filePath)?.value === value) cache.delete(filePath)
    throw error
  }
}
