// Theme handling. Supabase (user_settings.theme: 'system' | 'light' | 'dark') is authoritative once the
// settings have loaded. localStorage 'ombre-theme' is only a validated pre-hydration cache of that
// *preference*, so the login pages and the first paint after reload use the last confirmed value. It is
// written only after the server has confirmed a value, and corrected as soon as the real value loads.

export const THEME_CACHE_KEY = 'ombre-theme'
export const THEME_PREFERENCES = Object.freeze(['system', 'light', 'dark'])
const DARK_QUERY = '(prefers-color-scheme: dark)'

export function isThemePreference(value) {
  return typeof value === 'string' && THEME_PREFERENCES.includes(value)
}

// Returns a valid cached preference, or 'system'. Anything else in the cache (corrupt, hand-edited, an
// unknown value) is ignored and never reaches the DOM.
export function readCachedTheme() {
  try {
    const stored = window.localStorage.getItem(THEME_CACHE_KEY)
    return isThemePreference(stored) ? stored : 'system'
  } catch {
    return 'system'
  }
}

export function cacheTheme(preference) {
  if (!isThemePreference(preference)) return
  try {
    window.localStorage.setItem(THEME_CACHE_KEY, preference)
  } catch {
    // storage unavailable: the cache is optional
  }
}

export function systemPrefersDark() {
  try {
    return Boolean(window.matchMedia && window.matchMedia(DARK_QUERY).matches)
  } catch {
    return false
  }
}

// 'system' follows the OS; explicit values win. Always returns 'light' or 'dark'.
export function resolveTheme(preference, systemDark = systemPrefersDark()) {
  if (preference === 'dark') return 'dark'
  if (preference === 'light') return 'light'
  return systemDark ? 'dark' : 'light'
}

export function applyTheme(resolved) {
  document.documentElement.setAttribute('data-theme', resolved === 'dark' ? 'dark' : 'light')
}

// Subscribes to OS theme changes. Returns an unsubscribe function.
export function watchSystemTheme(onChange) {
  try {
    const mq = window.matchMedia(DARK_QUERY)
    const handler = (event) => onChange(event.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  } catch {
    return () => {}
  }
}

// Called once before React renders: applies the cached preference (no network, no auth).
export function initTheme() {
  applyTheme(resolveTheme(readCachedTheme()))
}
