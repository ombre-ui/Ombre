import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '../auth/AuthProvider.jsx'
import { PROFILE_PATH, SETTINGS_PATH, requestUserResource } from './userApi.js'
import { applyPending, mergeProfile, mergeSettings } from './merge.js'
import {
  applyTheme,
  cacheTheme,
  isThemePreference,
  readCachedTheme,
  resolveTheme,
  systemPrefersDark,
  watchSystemTheme,
} from '../theme.js'

/**
 * Real, server-owned state for the signed-in user (profile + settings).
 *
 * Supabase is the source of truth; this provider only talks to the same-origin BFF (/api/user/*). It holds
 * no data until the server has answered: while loading or after a failed load there are no fabricated
 * defaults, only a status the UI renders honestly ('loading' | 'error') with a retry.
 *
 * Edits are optimistic but safe: the value shown is always `confirmed` (what the server last returned) with
 * still-pending patches applied, so a failed save disappears from the screen instead of lingering.
 * Requests are serialized (see userApi.js) and a 401 re-validates the session and retries at most once.
 *
 * This is also the pattern for later user-scoped domains: one resource hook, one BFF path, server-confirmed.
 */

const UserStateContext = createContext(null)

const LOADING = { status: 'loading', data: null, confirmed: null, error: null }
const NOT_READY = { code: 'not_ready', message: 'This hasn’t loaded yet.' }

function failure(result) {
  const error = result && result.error ? result.error : { code: 'unknown', message: 'Something went wrong.' }
  return { code: error.code, message: error.message, status: result ? result.status : 0 }
}

function useUserResource({ path, pick, merge, reauth }) {
  const [state, setState] = useState(LOADING)
  const confirmedRef = useRef(null)
  const pendingRef = useRef([])
  const nextId = useRef(1)
  const generation = useRef(0) // bumps on reload/unmount so late responses are ignored

  const publish = useCallback(() => {
    const confirmed = confirmedRef.current
    setState({ status: 'ready', confirmed, data: applyPending(confirmed, pendingRef.current, merge), error: null })
  }, [merge])

  const load = useCallback(async () => {
    const gen = ++generation.current
    confirmedRef.current = null
    pendingRef.current = []
    setState(LOADING)
    const result = await requestUserResource(path, undefined, reauth)
    if (gen !== generation.current) return
    const value = result.ok && result.data ? result.data[pick] : null
    if (value) {
      confirmedRef.current = value
      publish()
    } else {
      setState({ status: 'error', data: null, confirmed: null, error: failure(result) })
    }
  }, [path, pick, reauth, publish])

  const update = useCallback(
    (patch) => {
      if (confirmedRef.current === null) return Promise.resolve({ ok: false, error: NOT_READY })
      const entry = { id: nextId.current++, patch }
      pendingRef.current = [...pendingRef.current, entry]
      publish()
      const gen = generation.current
      return requestUserResource(path, { method: 'PATCH', body: patch }, reauth).then((result) => {
        if (gen !== generation.current) return { ok: false, error: NOT_READY }
        pendingRef.current = pendingRef.current.filter((e) => e.id !== entry.id)
        const value = result.ok && result.data ? result.data[pick] : null
        if (result.ok) confirmedRef.current = value || merge(confirmedRef.current, patch)
        publish()
        return result.ok ? { ok: true } : { ok: false, error: failure(result) }
      })
    },
    [path, pick, reauth, merge, publish]
  )

  const cancel = useCallback(() => {
    generation.current += 1
  }, [])

  return { state, load, update, cancel }
}

export function UserStateProvider({ children }) {
  const { refresh } = useAuth()
  const profile = useUserResource({ path: PROFILE_PATH, pick: 'profile', merge: mergeProfile, reauth: refresh })
  const settings = useUserResource({ path: SETTINGS_PATH, pick: 'settings', merge: mergeSettings, reauth: refresh })
  const { load: loadProfile, cancel: cancelProfile } = profile
  const { load: loadSettings, cancel: cancelSettings } = settings

  useEffect(() => {
    loadProfile()
    loadSettings() // both go through one serial queue, so they never race a session refresh
    return () => {
      cancelProfile()
      cancelSettings()
    }
  }, [loadProfile, loadSettings, cancelProfile, cancelSettings])

  const reload = useCallback(
    (which) => {
      if (which === 'profile') return loadProfile()
      if (which === 'settings') return loadSettings()
      return Promise.all([loadProfile(), loadSettings()])
    },
    [loadProfile, loadSettings]
  )

  // ---- theme: Supabase is authoritative once loaded; 'ombre-theme' is only a pre-hydration cache ----
  const cachedPreference = useMemo(() => readCachedTheme(), [])
  const serverPreference = settings.state.data && settings.state.data.general ? settings.state.data.general.theme : null
  const confirmedPreference =
    settings.state.confirmed && settings.state.confirmed.general ? settings.state.confirmed.general.theme : null
  const preference = isThemePreference(serverPreference) ? serverPreference : cachedPreference
  const [systemDark, setSystemDark] = useState(() => systemPrefersDark())
  useEffect(() => watchSystemTheme(setSystemDark), [])
  const resolved = resolveTheme(preference, systemDark)
  useEffect(() => {
    applyTheme(resolved)
  }, [resolved])
  useEffect(() => {
    // Only a server-confirmed value is ever cached (never an optimistic one).
    if (isThemePreference(confirmedPreference)) cacheTheme(confirmedPreference)
  }, [confirmedPreference])

  const updateSettings = settings.update
  const toggleTheme = useCallback(
    () => updateSettings({ general: { theme: resolved === 'dark' ? 'light' : 'dark' } }),
    [updateSettings, resolved]
  )

  const value = useMemo(
    () => ({
      profile: profile.state,
      settings: settings.state,
      updateProfile: profile.update,
      updateSettings,
      reload,
      theme: { preference, resolved, ready: settings.state.status === 'ready' },
      toggleTheme,
    }),
    [profile.state, profile.update, settings.state, updateSettings, reload, preference, resolved, toggleTheme]
  )

  return <UserStateContext.Provider value={value}>{children}</UserStateContext.Provider>
}

export function useUserState() {
  const ctx = useContext(UserStateContext)
  if (!ctx) throw new Error('useUserState must be used inside <UserStateProvider>')
  return ctx
}
