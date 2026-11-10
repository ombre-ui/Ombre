// Maps failed PostgREST results from the workspace tables to generic ApiErrors. Postgres reports the
// SQLSTATE in error.code; the mapping is by code only, so constraint names, column values and SQL text never
// reach a response or a log (only name/status/code are logged, as in A3's dbFailure).
import { ApiError, badRequest, notFound, conflict, unauthorized, unavailable } from './errors.js'

// SQLSTATEs the A4 schema can produce:
//   23503 foreign_key_violation  a referenced parent is missing or belongs to someone else (composite FKs), or
//                                the messages trigger found no such conversation   -> 404
//   23505 unique_violation       duplicate idempotency key / duplicate saved item    -> 409 (routes handle replays first)
//   23514 check_violation        a length/shape CHECK failed                         -> 400
//   22001/22021/22P02/22023      oversize, bad encoding, bad uuid/text input         -> 400
//   OL001 (custom)               per-user row cap or 500-message cap                 -> 409 limit_reached
//   42501 insufficient_privilege RLS denial. On the conversation/message insert paths the only reachable
//                                cause is save_history = false                       -> 409 history_disabled
export function dbError(ctx, event, result, { historyGate = false } = {}) {
  const error = result.error || {}
  const status = typeof result.status === 'number' ? result.status : 0
  const code = typeof error.code === 'string' ? error.code : undefined
  ctx.logAuthError(event, { name: error.name, status, code })

  if (status === 0 || status >= 500) return unavailable() // network failure or database/API outage: retryable
  if (status === 401 || code === 'PGRST301' || code === 'PGRST303') return unauthorized()
  switch (code) {
    case '23503':
      return notFound()
    case '23505':
      return conflict('conflict')
    case 'OL001':
      return conflict('limit_reached')
    case '23514':
    case '22001':
    case '22021':
    case '22P02':
    case '22023':
      return badRequest()
    case '42501':
      return historyGate ? conflict('history_disabled') : new ApiError(500, 'internal_error')
    default:
      return new ApiError(500, 'internal_error') // anything else: never leak details
  }
}

export function isUniqueViolation(result) {
  return Boolean(result.error) && result.error.code === '23505'
}

// All rows of a successful result, or a thrown ApiError.
export function allRows(ctx, event, result, options) {
  if (result.error) throw dbError(ctx, event, result, options)
  if (!Array.isArray(result.data)) throw new ApiError(500, 'internal_error')
  return result.data
}

// Exactly one row. Zero rows is a missing (or RLS-hidden) row: always 404, never 403, so a foreign id and a
// nonexistent id are indistinguishable.
export function singleRow(ctx, event, result, options) {
  const rows = allRows(ctx, event, result, options)
  if (rows.length === 0) {
    ctx.log(`${event}.row_missing`, {})
    throw notFound()
  }
  if (rows.length > 1) {
    ctx.log(`${event}.multiple_rows`, {})
    throw new ApiError(500, 'internal_error')
  }
  return rows[0]
}
