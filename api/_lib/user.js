// Shared building blocks for user-scoped endpoints (A3 pattern, reused by later domains):
//   1. requireUser(ctx)       authenticate server-side with getUser(); the user id comes from the verified
//                             session only, never from the request.
//   2. queries filter on that id AND run under the user's own JWT (publishable key), so RLS is the
//      second, independent ownership check.
//   3. oneRow(ctx, result)    turns a PostgREST result into exactly one row, or a generic ApiError.
import { ApiError, unauthorized, unavailable, isRetryable, isSessionMissing } from './errors.js'

export async function requireUser(ctx) {
  const { supabase } = ctx.supa()
  const { data, error } = await supabase.auth.getUser()
  if (error) {
    if (isRetryable(error)) throw unavailable() // an auth outage must not look like "signed out"
    if (!isSessionMissing(error)) ctx.logAuthError('user.auth.rejected', error)
    throw unauthorized()
  }
  const user = data && data.user
  if (!user || typeof user.id !== 'string' || user.id === '') throw unauthorized()
  return { supabase, user }
}

// Maps a failed PostgREST result to a generic ApiError. Logs name/status/code only, never the message
// (it can contain column values).
export function dbFailure(ctx, event, result) {
  const error = result.error || {}
  const status = typeof result.status === 'number' ? result.status : 0
  const code = typeof error.code === 'string' ? error.code : undefined
  ctx.logAuthError(event, { name: error.name, status, code })
  if (status === 0 || status >= 500) return unavailable() // network failure or database/API outage: retryable
  if (status === 401 || code === 'PGRST301' || code === 'PGRST303') return unauthorized()
  return new ApiError(500, 'internal_error') // permission/constraint/other: never leak details
}

// Exactly one row, or an explicit error. Zero rows is a missing (or RLS-hidden) row: it is reported as 404,
// never treated as success and never created here (no insert grant, no upsert).
export function oneRow(ctx, event, result) {
  if (result.error) throw dbFailure(ctx, event, result)
  const rows = result.data
  if (!Array.isArray(rows)) throw new ApiError(500, 'internal_error')
  if (rows.length === 0) {
    ctx.log(`${event}.row_missing`, {})
    throw new ApiError(404, 'not_found')
  }
  if (rows.length > 1) {
    ctx.log(`${event}.multiple_rows`, {})
    throw new ApiError(500, 'internal_error')
  }
  return rows[0]
}
