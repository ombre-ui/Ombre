// The single serverless function behind all nine A4 workspace URLs (/api/projects, /api/conversations,
// /api/saved, /api/library and their /:id and /:id/messages forms). Vercel's Hobby plan allows 12 functions
// per deployment and A2/A3 already use 11, so A4 is dispatched by resource family inside one function
// (api/_lib/workspaceDispatch.js). Specific files such as api/auth/*.js and api/user/*.js always take
// precedence over this catch-all; any other path gets the pipeline's generic 404.
import { toNode } from './_lib/node.js'
import { routes } from './_lib/real.js'

export default toNode(routes.workspace)
