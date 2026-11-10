// The single serverless function behind all nine A4 workspace URLs (/api/projects, /api/conversations,
// /api/saved, /api/library and their /:id and /:id/messages forms).
//
// Vercel's Hobby plan allows 12 functions per deployment and A2/A3 already use 11, so A4 is dispatched by
// resource family inside one function (api/_lib/workspaceDispatch.js). The public URLs reach it through the
// rewrites in vercel.json, which keep the original request path (the platform does not rewrite req.url).
// A catch-all file (api/[...path].js) was tried first and does not match multi-segment paths here.
import { toNode } from './_lib/node.js'
import { routes } from './_lib/real.js'

export default toNode(routes.workspace)
