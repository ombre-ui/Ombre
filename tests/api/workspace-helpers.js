import { createWorkspaceRoutes } from '../../api/_lib/workspaceRoutes.js'
import { createWorkspaceDispatcher } from '../../api/_lib/workspaceDispatch.js'
import { prodConfig, memoryLogger } from './helpers.js'

export const USER = '8a1d2c3e-4b5f-4a6b-9c7d-0e1f2a3b4c5d'
export const OTHER_USER = '1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5e'
export const ID1 = '3f2b8c1e-7a4d-4e5f-9b6a-1c2d3e4f5a6b'
export const ID2 = '0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d'
export const ID3 = '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d'
// Idempotency (clientRequestId) fixture: an obviously synthetic UUID (v4 shape, so it passes strict parsing). The
// name deliberately avoids words the repository secret scanner treats as credential hints. Existing tests import
// it as KEY1, so that alias is kept.
export const REQUEST_ID_1 = '00000000-0000-4000-8000-000000000001'
export { REQUEST_ID_1 as KEY1 }

// A recording fake of the supabase-js query builder. `handler({ table, ops })` or `handler({ rpc, args })`
// returns the PostgREST-style result { data, error, status }. Every call is recorded in `calls`.
export function fakeSupabase({ user = { id: USER }, authError = null, handler }) {
  const calls = []
  function chain(table) {
    const call = { table, ops: [] }
    calls.push(call)
    const q = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'then') {
            return (resolve, reject) => Promise.resolve(handler({ table, ops: call.ops, call })).then(resolve, reject)
          }
          return (...args) => {
            call.ops.push([prop, ...args])
            return q
          }
        },
      },
    )
    return q
  }
  const supabase = {
    auth: { getUser: async () => (authError ? { data: { user: null }, error: authError } : { data: { user }, error: null }) },
    from: (table) => chain(table),
    rpc: (name, args) => {
      const call = { rpc: name, args, ops: [] }
      calls.push(call)
      return Promise.resolve(handler({ rpc: name, args, call }))
    },
  }
  return { supabase, calls }
}

// Builds the nine routes plus the dispatcher (routes.workspace) exactly as api/_lib/real.js does.
export function buildWorkspace(options) {
  const { lines, logger } = memoryLogger()
  const fake = fakeSupabase(options)
  const deps = {
    getConfig: () => prodConfig(),
    createSupabase: () => ({ supabase: fake.supabase, jar: null }),
    logger,
  }
  const resources = createWorkspaceRoutes(deps)
  const routes = { ...resources, workspace: createWorkspaceDispatcher(deps, resources) }
  return { routes, lines, calls: fake.calls }
}

export const ok = (data) => ({ data, error: null, status: 200 })
export const fail = (code, status = 400) => ({ data: null, error: { code, name: 'PostgrestError', message: 'SECRET-DB-DETAIL' }, status })

export const opsOf = (call, name) => call.ops.filter((o) => o[0] === name)

export const projectRow = (over = {}) => ({
  id: ID1,
  user_id: USER, // present only to prove it is never returned
  name: 'Alpha',
  description: '',
  archived_at: null,
  created_at: '2026-10-20T03:30:00.000001+00:00',
  updated_at: '2026-10-20T03:30:00.000001+00:00',
  ...over,
})

export const conversationRow = (over = {}) => ({
  id: ID1,
  project_id: null,
  mentor_id: null,
  title: 'Hello',
  message_count: 1,
  last_message_at: '2026-10-20T03:30:00.000001+00:00',
  created_at: '2026-10-20T03:30:00.000001+00:00',
  updated_at: '2026-10-20T03:30:00.000001+00:00',
  ...over,
})

export const messageRow = (over = {}) => ({
  id: ID2,
  conversation_id: ID1,
  seq: 1,
  role: 'user',
  content: 'Hello there',
  is_demo: false,
  created_at: '2026-10-20T03:30:00.000001+00:00',
  ...over,
})
