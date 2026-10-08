// Minimal A2 isolation for the local demo data (the full removal of local persistence belongs to A3).
// Must equal STORAGE_KEY in src/lib/store.jsx; scripts/check-browser-storage.mjs enforces that.
export const MOCK_DATA_STORAGE_KEY = 'ombre-mock-data-v1'

export function wipeMockData() {
  try {
    window.localStorage.removeItem(MOCK_DATA_STORAGE_KEY)
  } catch {
    // storage unavailable: nothing to wipe
  }
}

// Wipe, then hard-navigate. A hard navigation is required: OmbreDataProvider keeps the data in memory and
// re-persists it on every change, so wiping alone would let the previous session's data reappear.
export function wipeAndNavigate(path) {
  wipeMockData()
  // A mock reply timer can fire between the wipe and the actual unload and re-persist state;
  // wipe once more at the very end of this page's life.
  window.addEventListener('pagehide', wipeMockData, { once: true })
  window.location.replace(path)
}
