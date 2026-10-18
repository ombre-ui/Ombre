// Same-origin client for /api/user/*. All requests here share one serial queue (profile and settings
// only), and a 401 triggers one session re-check and at most one retry.
import { apiRequest } from '../auth/api.js'
import { createSerialQueue } from './serialQueue.js'

const enqueue = createSerialQueue()

// reauth(): re-validates the session (the provider passes AuthProvider.refresh, which is single-flight).
// If the session is really gone it flips auth state to unauthenticated and the route guard takes over; if it
// was merely stale it has been rotated, and the single retry below succeeds. A second 401 is returned as is.
async function call(path, options, reauth) {
  const result = await apiRequest(path, options)
  if (!result.ok && result.status === 401 && typeof reauth === 'function') {
    await reauth()
    return apiRequest(path, options)
  }
  return result
}

export function requestUserResource(path, options, reauth) {
  return enqueue(() => call(path, options, reauth))
}

export const PROFILE_PATH = '/api/user/profile'
export const SETTINGS_PATH = '/api/user/settings'
