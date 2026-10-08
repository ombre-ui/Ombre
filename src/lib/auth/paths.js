// Only in-app paths may be used as post-login targets (prevents open redirects).
const APP_PATH = /^\/app(\/[A-Za-z0-9._~\-/%]*)?(\?[A-Za-z0-9._~\-/%=&]*)?(#[A-Za-z0-9._~\-/%]*)?$/

export function safeInternalPath(value, fallback = '/app/general') {
  if (typeof value !== 'string') return fallback
  if (value.includes('//') || value.includes('\\') || value.includes(':')) return fallback
  return APP_PATH.test(value) ? value : fallback
}

const SERVER_NEXT = new Set(['/app/general', '/reset-password'])

// The server decides where a verified link leads; the client only accepts known destinations.
export function safeServerNext(value) {
  return SERVER_NEXT.has(value) ? value : '/app/general'
}
