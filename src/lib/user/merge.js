// Pure helpers for optimistic updates: the displayed value is always `confirmed` (the last value the server
// returned) with the still-pending patches applied in order. A failed or finished patch is simply removed
// from the pending list, so a failure can never leave a stale optimistic value on screen.

export function mergeSettings(base, patch) {
  const next = { ...base }
  for (const section of Object.keys(patch)) next[section] = { ...base[section], ...patch[section] }
  return next
}

export function mergeProfile(base, patch) {
  return { ...base, ...patch }
}

export function applyPending(confirmed, pending, merge) {
  return pending.reduce((value, entry) => merge(value, entry.patch), confirmed)
}
