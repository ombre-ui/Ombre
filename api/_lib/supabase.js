// The only module that imports @supabase/ssr. A new client (and cookie jar) is created for every request;
// sharing a server client across requests would leak sessions and drop cache headers.
import { createServerClient } from '@supabase/ssr'
import { createCookieJar } from './cookies.js'

export function createSupabaseForRequest(request, config) {
  const jar = createCookieJar({ request, config })
  const supabase = createServerClient(config.supabaseUrl, config.supabasePublishableKey, {
    cookieOptions: {
      name: config.cookieName,
      path: '/',
      sameSite: 'lax',
      httpOnly: true,
      secure: config.secureCookies,
      // maxAge is capped in the jar; `domain` is intentionally never set.
    },
    cookies: {
      getAll: () => jar.getAll(),
      setAll: (cookies, headers) => jar.setAll(cookies, headers),
      // `encode: 'tokens-only'` is experimental and intentionally NOT used.
    },
    // flowType/autoRefreshToken/detectSessionInUrl/persistSession are fixed by createServerClient.
    // `experimental.appendPkceFlowIdToRedirects` is intentionally NOT enabled (see docs/auth.md).
  })
  return { supabase, jar }
}
