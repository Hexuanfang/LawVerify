export interface ReviewAudit {
  id: string
  account: string
  t: string
  msg: string
  elementId: string
  paragraphId: string
  certificateId: string
  caseId?: string
}

let database: Promise<IDBDatabase> | undefined
function openDatabase() {
  return database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('lawverify-review-history', 2)
    request.onupgradeneeded = () => {
      const store = request.result.objectStoreNames.contains('audits') ? request.transaction!.objectStore('audits')
        : request.result.createObjectStore('audits', { keyPath: 'id' })
      if (!store.indexNames.contains('document')) store.createIndex('document', ['account', 'certificateId'])
      store.createIndex('case', ['account', 'caseId', 'certificateId'])
    }
    request.onsuccess = () => {
      const db = request.result
      db.onversionchange = () => { db.close(); database = undefined }
      resolve(db)
    }
    request.onerror = () => { database = undefined; reject(request.error) }
    request.onblocked = () => { database = undefined; reject(new Error('本机操作记录数据库暂时被占用')) }
  })
}

async function readAudits(index: 'document' | 'case', key: string[]): Promise<ReviewAudit[]> {
  const db = await openDatabase()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('audits', 'readonly')
    const request = transaction.objectStore('audits').index(index).getAll(key)
    transaction.oncomplete = () => resolve((request.result as ReviewAudit[]).sort((a, b) => a.t.localeCompare(b.t)))
    transaction.onabort = () => reject(transaction.error)
    transaction.onerror = () => reject(transaction.error)
  })
}

export function readReviewAudits(account: string, certificateId: string) {
  return readAudits('document', [account.trim().toLowerCase(), certificateId])
}

export function readCaseAssistantAudits(account: string, caseId: string) {
  return readAudits('case', [account.trim().toLowerCase(), caseId, ''])
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

export async function removeCaseReviewAudits(account: string, certificateIds: readonly string[], caseId: string) {
  const db = await openDatabase()
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('audits', 'readwrite', { durability: 'strict' })
    const store = transaction.objectStore('audits')
    const owner = account.trim().toLowerCase()
    const remove = (index: 'document' | 'case', key: string[]) => {
      const request = store.index(index).openKeyCursor(IDBKeyRange.only(key))
      request.onsuccess = () => {
        const cursor = request.result
        if (cursor) {
          store.delete(cursor.primaryKey)
          cursor.continue()
        }
      }
    }
    for (const certificateId of certificateIds) remove('document', [owner, certificateId])
    remove('case', [owner, caseId, ''])
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error)
    transaction.onerror = () => reject(transaction.error)
  })
}
