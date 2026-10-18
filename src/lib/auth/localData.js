// Legacy cleanup (A3). Before A3 the demo data layer persisted everything (conversations, projects, memory,
// seeded items, a local "profile") to localStorage under this key. Nothing writes it any more; this removes
// what older builds left behind so previously seeded or demo data can never reappear.
// scripts/check-browser-storage.mjs allows this key to be removed here and nowhere else.
export const LEGACY_MOCK_DATA_KEY = 'ombre-mock-data-v1'

export function purgeLegacyLocalData() {
  try {
    window.localStorage.removeItem(LEGACY_MOCK_DATA_KEY)
  } catch {
    // storage unavailable: nothing to remove
  }
}

// Purge, then hard-navigate. The hard navigation is still required on sign-in, sign-out and callback
// completion: it drops every piece of in-memory state (user state and session-only demo data) so nothing
// from one account can be seen by the next.
export function wipeAndNavigate(path) {
  purgeLegacyLocalData()
  window.location.replace(path)
}
