export interface ReviewAudit {
  id: string
  account: string
  t: string
  msg: string
  elementId: string
  paragraphId: string
  certificateId: string
}

let database: Promise<IDBDatabase> | undefined
function openDatabase() {
  return database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('lawverify-review-history', 1)
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore('audits', { keyPath: 'id' })
      store.createIndex('document', ['account', 'certificateId'])
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => { database = undefined; reject(request.error) }
    request.onblocked = () => { database = undefined; reject(new Error('本机操作记录数据库暂时被占用')) }
  })
}

export async function readReviewAudits(account: string, certificateId: string): Promise<ReviewAudit[]> {
  const db = await openDatabase()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('audits', 'readonly')
    const request = transaction.objectStore('audits').index('document').getAll([account.trim().toLowerCase(), certificateId])
    transaction.oncomplete = () => resolve((request.result as ReviewAudit[]).sort((a, b) => a.t.localeCompare(b.t)))
    transaction.onabort = () => reject(transaction.error)
    transaction.onerror = () => reject(transaction.error)
  })
}

export async function appendReviewAudit(audit: ReviewAudit) {
  const db = await openDatabase()
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('audits', 'readwrite', { durability: 'strict' })
    transaction.objectStore('audits').add({ ...audit, account: audit.account.trim().toLowerCase() })
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error)
    transaction.onerror = () => reject(transaction.error)
  })
}

export async function removeCaseReviewAudits(account: string, certificateIds: readonly string[]) {
  if (!certificateIds.length) return
  const db = await openDatabase()
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('audits', 'readwrite', { durability: 'strict' })
    const store = transaction.objectStore('audits')
    for (const certificateId of certificateIds) {
      const request = store.index('document').openKeyCursor(IDBKeyRange.only([account.trim().toLowerCase(), certificateId]))
      request.onsuccess = () => {
        const cursor = request.result
        if (cursor) {
          store.delete(cursor.primaryKey)
          cursor.continue()
        }
      }
    }
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error)
    transaction.onerror = () => reject(transaction.error)
  })
}
