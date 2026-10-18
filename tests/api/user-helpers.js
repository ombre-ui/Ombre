import { createCookieJar } from '../../api/_lib/cookies.js'
import { createUserRoutes } from '../../api/_lib/userRoutes.js'
import { prodConfig, memoryLogger } from './helpers.js'

// Builds the /api/user/* routes on a fake Supabase client whose `from(table)` is supplied by the test.
// `emitCookies(jar, config)` simulates @supabase/ssr calling setAll (for example after a token refresh).
export function buildUserRoutes({ auth = {}, from, config = prodConfig(), emitCookies } = {}) {
  const { lines, logger } = memoryLogger()
  const createSupabase = (request, cfg) => {
    const jar = createCookieJar({ request, config: cfg })
    const supabase = { auth: { ...auth }, from }
    if (emitCookies) emitCookies(jar, cfg)
    return { supabase, jar }
  }
  const routes = createUserRoutes({ getConfig: () => config, createSupabase, logger })
  return { routes, lines, config }
}
