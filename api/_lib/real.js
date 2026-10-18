import { loadConfig } from './config.js'
import { createLogger } from './logger.js'
import { createSupabaseForRequest } from './supabase.js'
import { createRoutes } from './routes.js'
import { createUserRoutes } from './userRoutes.js'

let cachedConfig = null
function getConfig() {
  if (!cachedConfig) cachedConfig = loadConfig() // throws ConfigError on bad env; failures are not cached
  return cachedConfig
}

const deps = {
  getConfig,
  createSupabase: createSupabaseForRequest,
  logger: createLogger(),
}

// Auth routes (A2) and user-data routes (A3) share one set of dependencies and one request pipeline.
export const routes = { ...createRoutes(deps), ...createUserRoutes(deps) }
