// Same-origin client for the /api BFF. The browser never talks to Supabase and never holds auth tokens:
// the session lives in an HttpOnly cookie that only the server can read.

export const CSRF_HEADER = 'X-Ombre-Request'

export async function apiRequest(path, { method = 'GET', body } = {}) {
  try {
    const headers = { [CSRF_HEADER]: '1' }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const response = await fetch(path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
    })
    let data = null
    try {
      data = await response.json()
    } catch {
      data = null
    }
    if (response.ok) return { ok: true, status: response.status, data }
    const error = data && data.error ? data.error : { code: 'unknown', message: 'Something went wrong.' }
    return { ok: false, status: response.status, error }
  } catch {
    return {
      ok: false,
      status: 0,
      error: { code: 'network_error', message: 'Couldn’t reach Ombre. Check your connection and try again.' },
    }
  }
}
