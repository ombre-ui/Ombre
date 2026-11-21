import { loadConfig } from './config.js'
import { createLogger } from './logger.js'
import { createSupabaseForRequest } from './supabase.js'
import { createRoutes } from './routes.js'
import { createUserRoutes } from './userRoutes.js'
import { createWorkspaceRoutes } from './workspaceRoutes.js'
import { createWorkspaceDispatcher } from './workspaceDispatch.js'
import { createAiRuntime } from './ai/runtime.js'

let cachedConfig = null
function getConfig() {
  if (!cachedConfig) cachedConfig = loadConfig() // throws ConfigError on bad env; failures are not cached
  return cachedConfig
}

const deps = {
  getConfig,
  createSupabase: createSupabaseForRequest,
  logger: createLogger(),
  ai: createAiRuntime({ env: process.env }), // lazy: bad AI config surfaces as 503 ai_unavailable per request
}

const workspaceResources = createWorkspaceRoutes(deps)

// Auth routes (A2) and user-data routes (A3) are one function per file. The A4 workspace routes share the same
// dependencies and request pipeline but are served by ONE catch-all function (routes.workspace) because of the
// Hobby plan's 12-function limit; see api/_lib/workspaceDispatch.js.
export const routes = {
  ...createRoutes(deps),
  ...createUserRoutes(deps),
  ...workspaceResources,
  workspace: createWorkspaceDispatcher(deps, workspaceResources),
}
