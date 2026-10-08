import { loadConfig } from '../../api/_lib/config.js'
import { createLogger } from '../../api/_lib/logger.js'
import { createCookieJar } from '../../api/_lib/cookies.js'
import { createRoutes } from '../../api/_lib/routes.js'

export const ORIGIN = 'https://app.example.com'

export function prodConfig(overrides = {}) {
  return loadConfig({
    SUPABASE_URL: 'https://abc.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
    APP_ORIGINS: ORIGIN,
    VERCEL_ENV: 'production',
    ...overrides,
  })
}

export function devConfig() {
  return loadConfig({
    SUPABASE_URL: 'http://127.0.0.1:54321',
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
    APP_ORIGINS: 'http://localhost:3000',
    VERCEL_ENV: 'development',
  })
}

export function memoryLogger() {
  const lines = []
  return { lines, logger: createLogger({ write: (l) => lines.push(l), now: () => new Date(0) }) }
}

export function makeRequest(path, options = {}) {
  const { method = 'POST', body, headers = {}, csrf = true, cookie } = options
  // An explicit `origin: undefined` means "send no Origin header".
  const origin = 'origin' in options ? options.origin : ORIGIN
  const h = new Headers(headers)
  if (origin) h.set('origin', origin)
  if (csrf) h.set('x-ombre-request', '1')
  if (cookie) h.set('cookie', cookie)
  let payload
  if (body !== undefined) {
    h.set('content-type', 'application/json')
    payload = typeof body === 'string' ? body : JSON.stringify(body)
  }
  return new Request(`http://internal.invalid${path}`, { method, headers: h, body: payload })
}

// A fake Supabase auth client. `auth` overrides individual methods. setAll is driven by `emit`.
export function fakeSupabaseFactory(auth, { config, emitCookies } = {}) {
  const created = []
  const factory = (request, cfg) => {
    const jar = createCookieJar({ request, config: cfg })
    const supabase = { auth: { ...auth } }
    created.push({ jar, supabase })
    if (emitCookies) emitCookies(jar, cfg)
    return { supabase, jar }
  }
  factory.created = created
  return factory
}

export function buildRoutes({ auth = {}, config = prodConfig(), emitCookies } = {}) {
  const { lines, logger } = memoryLogger()
  const createSupabase = fakeSupabaseFactory(auth, { config, emitCookies })
  const routes = createRoutes({ getConfig: () => config, createSupabase, logger })
  return { routes, lines, createSupabase, config }
}

export async function json(response) {
  return JSON.parse(await response.text())
}
