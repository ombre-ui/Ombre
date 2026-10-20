// Strict parsing of everything a client can put in the URL: path parameters, query parameters and
// pagination cursors. Nothing here is trusted: ids must be canonical lowercase UUIDs, unknown or repeated
// query parameters are rejected, and cursors are decoded and validated field by field.
//
// Cursor values are later placed into a PostgREST `or(...)` filter, so they are validated against tight
// patterns that cannot contain commas, parentheses or other filter syntax.
import { badRequest, notFound } from './errors.js'

// Canonical lowercase UUID (any RFC 4122 version/variant). gen_random_uuid() and crypto.randomUUID() are v4.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value)
}

export function parseUuid(value) {
  if (!isUuid(value)) throw badRequest()
  return value
}

// Matches a pathname against a template such as '/api/conversations/:id/messages'.
// A different path shape is 404; a captured parameter that is not a UUID is 400.
export function matchPath(pathname, template) {
  const want = template.split('/')
  const got = (pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname).split('/')
  if (want.length !== got.length) throw notFound()
  const params = {}
  for (let i = 0; i < want.length; i += 1) {
    if (want[i].startsWith(':')) {
      let decoded
      try {
        decoded = decodeURIComponent(got[i])
      } catch {
        throw notFound()
      }
      params[want[i].slice(1)] = parseUuid(decoded)
    } else if (want[i] !== got[i]) {
      throw notFound()
    }
  }
  return params
}

// spec: { name: (rawString) => parsedValue }. Parameters that are absent are simply not in the result.
export function parseQuery(url, spec) {
  const out = {}
  const seen = new Set()
  for (const name of url.searchParams.keys()) {
    if (seen.has(name)) throw badRequest() // repeated parameter
    seen.add(name)
    if (!Object.prototype.hasOwnProperty.call(spec, name)) throw badRequest() // unknown parameter
  }
  for (const name of seen) out[name] = spec[name](url.searchParams.get(name))
  return out
}

export const DEFAULT_PAGE_SIZE = 20
export const MAX_PAGE_SIZE = 50

export function limitParam({ fallback = DEFAULT_PAGE_SIZE, max = MAX_PAGE_SIZE } = {}) {
  return (raw) => {
    if (!/^[1-9][0-9]{0,3}$/.test(raw)) throw badRequest()
    const n = Number(raw)
    if (n > max) throw badRequest()
    return n
  }
}

export function enumParam(values) {
  return (raw) => {
    if (!values.includes(raw)) throw badRequest()
    return raw
  }
}

export function uuidParam() {
  return (raw) => parseUuid(raw)
}

// A message sequence position: 0..500 (the per-conversation message cap).
export function seqParam() {
  return (raw) => {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(raw)) throw badRequest()
    const n = Number(raw)
    if (n > 500) throw badRequest()
    return n
  }
}

export function cursorParam() {
  return (raw) => decodeCursor(raw)
}

// ---- keyset cursors: base64url(JSON {t: timestamp, i: uuid}) ----

const MAX_CURSOR_LENGTH = 200
const CURSOR_CHARS_RE = /^[A-Za-z0-9_-]+$/
// Postgres timestamptz as PostgREST renders it (microsecond precision, UTC). Only UTC is accepted so the value
// has no '+' and can be placed in a filter and compared exactly.
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|\+00:00)$/

function normalizeTimestamp(value) {
  if (typeof value !== 'string' || !TIMESTAMP_RE.test(value)) return null
  const normalized = value.endsWith('+00:00') ? `${value.slice(0, -6)}Z` : value
  return Number.isNaN(Date.parse(normalized)) ? null : normalized
}

export function encodeCursor({ t, i }) {
  const ts = normalizeTimestamp(t)
  if (ts === null || !isUuid(i)) throw new Error('invalid cursor input')
  return Buffer.from(JSON.stringify({ t: ts, i }), 'utf8').toString('base64url')
}

export function decodeCursor(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_CURSOR_LENGTH || !CURSOR_CHARS_RE.test(raw)) {
    throw badRequest()
  }
  let parsed
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
  } catch {
    throw badRequest()
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw badRequest()
  const keys = Object.keys(parsed)
  if (keys.length !== 2 || !keys.includes('t') || !keys.includes('i')) throw badRequest()
  const t = normalizeTimestamp(parsed.t)
  if (t === null || !isUuid(parsed.i)) throw badRequest()
  return { t, i: parsed.i }
}

// PostgREST `or` filter for "rows after this cursor" when ordering by (column desc, id desc).
// Safe to interpolate: t and i were validated above and contain only [0-9TZ:.-] and [0-9a-f-].
export function keysetAfter(column, cursor) {
  return `${column}.lt.${cursor.t},and(${column}.eq.${cursor.t},id.lt.${cursor.i})`
}

// rows were fetched with limit + 1. Returns the page and the cursor for the next one (or null).
export function paginate(rows, limit, sortColumn) {
  if (rows.length <= limit) return { page: rows, nextCursor: null }
  const page = rows.slice(0, limit)
  const last = page[page.length - 1]
  return { page, nextCursor: encodeCursor({ t: last[sortColumn], i: last.id }) }
}
