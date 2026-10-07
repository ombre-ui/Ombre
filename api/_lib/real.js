import { loadConfig } from './config.js'
import { createLogger } from './logger.js'
import { createSupabaseForRequest } from './supabase.js'
import { createRoutes } from './routes.js'

let cachedConfig = null
function getConfig() {
  if (!cachedConfig) cachedConfig = loadConfig() // throws ConfigError on bad env; failures are not cached
  return cachedConfig
}

export const routes = createRoutes({
  getConfig,
  createSupabase: createSupabaseForRequest,
  logger: createLogger(),
})
