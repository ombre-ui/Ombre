// Path-shape dispatch for the single Vercel function that serves the A4 workspace URLs.
//
// Vercel's Hobby plan allows 12 serverless functions per deployment and A2/A3 already use 11, so the nine A4
// routes cannot each be their own file. They are served by one function (api/workspace.js, reached through the
// rewrites in vercel.json) that picks the route by URL shape and hands the untouched Request to it. Nothing
// about the routes changes: each is still built by createRoute (Origin/CSRF, JSON-only, body allowlists, strict
// UUID/query/cursor parsing, requireUser, RLS-scoped queries, generic errors), and each re-validates its own
// path template and methods. This module only chooses; it does no authentication, parsing or data access.
//
// Scope: only the four A4 resource families are dispatched. Every other path that reaches this function
// gets the pipeline's generic 404.
import { createRoute } from './pipeline.js'
import { notFound } from './errors.js'
import { PLATFORM_REWRITE_PARAMS } from './params.js'
import { MESSAGE_BODY_MAX_BYTES } from './workspaceData.js'

// URL parts after splitting '/api/<family>/<id>/<sub>' on '/': ['', 'api', family, id, sub].
const FAMILIES = {
  projects: { 3: 'projectsIndex', 4: 'projectById' },
  conversations: { 3: 'conversationsIndex', 4: 'conversationById' },
  saved: { 3: 'savedIndex', 4: 'savedById' },
  library: { 3: 'libraryIndex', 4: 'libraryById' },
}

// deps: the same { getConfig, createSupabase, logger } the routes were built with.
// resources: the nine routes returned by createWorkspaceRoutes(deps).
export function createWorkspaceDispatcher(deps, resources) {
  // Any path this function receives that is not one of the nine routes: the pipeline's generic 404.
  const unknown = createRoute(deps, { methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] }, async () => {
    throw notFound()
  })
  const routes = { ...resources, unknown }

  // Returns the route that should handle this pathname (the generic 404 route when none does).
  function select(pathname) {
    const trimmed = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
    const parts = trimmed.split('/')
    if (parts.length < 3 || parts[0] !== '' || parts[1] !== 'api') return routes.unknown
    const family = parts[2]
    if (family === 'conversations' && parts.length === 5 && parts[4] === 'messages') return routes.conversationMessages
    const shapes = Object.prototype.hasOwnProperty.call(FAMILIES, family) ? FAMILIES[family] : null
    const name = shapes ? shapes[parts.length] : undefined
    return name ? routes[name] : routes.unknown
  }

  async function workspace(request) {
    const url = new URL(request.url)
    // Diagnostic: which platform rewrite parameters (names only, never values) reached the function.
    deps.logger.info('workspace.dispatch', { rewriteParams: PLATFORM_REWRITE_PARAMS.filter((name) => url.searchParams.has(name)) })
    return select(url.pathname)(request)
  }

  // The Node adapter buffers up to this many bytes before the route runs. It is the largest per-route limit
  // (messages); every route still enforces its own, smaller limit on the body (413 above it).
  workspace.maxBodyBytes = MESSAGE_BODY_MAX_BYTES
  workspace.select = select
  return workspace
}
