export function caseNoteKey(accountId: string, caseId: string) {
  return `lawverify-case-note:${accountId}:${caseId}`
}

export function readCaseNote(accountId: string, caseId: string) {
  try { return localStorage.getItem(caseNoteKey(accountId, caseId)) ?? '' } catch { return '' }
}
