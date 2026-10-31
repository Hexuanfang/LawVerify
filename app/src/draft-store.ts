export interface ParagraphDraft {
  key: string
  text: string
  richText: string
  baseText: string
  baseRichText: string
  revision: string
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

export async function readDraft(key: string): Promise<ParagraphDraft | undefined> {
  const db = await openDatabase()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('paragraphs', 'readonly')
    const request = transaction.objectStore('paragraphs').get(key)
    transaction.oncomplete = () => resolve(request.result)
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
