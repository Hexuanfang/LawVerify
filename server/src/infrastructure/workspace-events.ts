const listeners = new Map<string, Set<() => void>>()
const keyFor = (account: string | null | undefined) => account?.trim().toLowerCase() ?? ''

export function notifyWorkspaceChanged(account: string | null | undefined) {
  for (const listener of listeners.get(keyFor(account)) ?? []) listener()
}

export function subscribeWorkspaceChanges(account: string | null | undefined, listener: () => void) {
  const key = keyFor(account)
  const group = listeners.get(key) ?? new Set()
  if (group.size >= 8) return null
  group.add(listener)
  listeners.set(key, group)
  return () => {
    group.delete(listener)
    if (!group.size) listeners.delete(key)
  }
}
