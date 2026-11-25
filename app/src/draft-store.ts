export interface ParagraphDraft {
  key: string
  text: string
  richText: string
  baseText: string
  baseRichText: string
  revision: string
  office?: { bytes: Blob; expectedFileVersion: string }
}

let database: Promise<IDBDatabase> | undefined
function openDatabase() {
  return database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('lawverify-drafts', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('paragraphs', { keyPath: 'key' })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => { database = undefined; reject(request.error) }
    request.onblocked = () => { database = undefined; reject(new Error('Draft database blocked')) }
  })
}

export function draftKey(account: string, certificateId: string, paragraphId: string) {
  return JSON.stringify([account.trim().toLowerCase(), certificateId, paragraphId])
}

export function documentDraftKey(account: string, certificateId: string) {
  return JSON.stringify(['lawverify-document', account.trim().toLowerCase(), certificateId])
}

export async function hasDocumentDraft(account: string, certificateId: string, paragraphs: { id: string }[]) {
  if (await readDraft(documentDraftKey(account, certificateId))) return true
  return (await readDrafts(paragraphs.map(item => draftKey(account, certificateId, item.id)))).some(Boolean)
}

export async function readDraft(key: string): Promise<ParagraphDraft | undefined> {
  const [draft] = await readDrafts([key])
  return draft
}

export async function readDrafts(keys: string[]): Promise<Array<ParagraphDraft | undefined>> {
  if (!keys.length) return []
  const db = await openDatabase()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('paragraphs', 'readonly')
    const store = transaction.objectStore('paragraphs')
    const requests = keys.map(key => store.get(key))
    transaction.oncomplete = () => resolve(requests.map(request => request.result))
    transaction.onabort = () => reject(transaction.error)
    transaction.onerror = () => reject(transaction.error)
  })
}

export async function writeDraft(draft: ParagraphDraft) {
  const db = await openDatabase()
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('paragraphs', 'readwrite', { durability: 'strict' })
    transaction.objectStore('paragraphs').put(draft)
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error)
    transaction.onerror = () => reject(transaction.error)
  })
}

export async function removeDraft(key: string, revision: string) {
  const db = await openDatabase()
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('paragraphs', 'readwrite', { durability: 'strict' })
    const store = transaction.objectStore('paragraphs')
    const request = store.get(key)
    request.onsuccess = () => {
      // An older network save must never discard a newer local edit.
      if (request.result?.revision === revision) store.delete(key)
    }
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error)
    transaction.onerror = () => reject(transaction.error)
  })
}

export async function removeCaseDrafts(account: string, certificateIds: readonly string[]) {
  if (!certificateIds.length) return
  const db = await openDatabase()
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('paragraphs', 'readwrite', { durability: 'strict' })
    const store = transaction.objectStore('paragraphs')
    for (const id of certificateIds) {
      store.delete(documentDraftKey(account, id))
      const prefix = JSON.stringify([account.trim().toLowerCase(), id]).slice(0, -1)
      // 旧版逐段草稿的键以相同的账号和文书 ID 开头，后面是逗号及段落 ID。
      store.delete(IDBKeyRange.bound(`${prefix},`, `${prefix}-`, false, true))
    }
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error)
    transaction.onerror = () => reject(transaction.error)
  })
}
