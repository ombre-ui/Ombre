// A4 workspace routes: projects, conversations, messages, saved items and library items.
//
// Every route follows the A3 pattern:
//   - runs through the shared pipeline (method check, Origin + X-Ombre-Request on writes, JSON-only, body-key
//     allowlist, no-store, request ids, generic errors);
//   - authenticates with requireUser() and takes the owner id from the verified session only;
//   - queries run under the user's own JWT (publishable key), so row level security is a second, independent
//     ownership check. Queries also filter on user_id explicitly (defence in depth);
//   - a foreign or nonexistent id is always 404 (never 403);
//   - responses are built by explicit mappers (workspaceData.js), never raw rows.
// Every route declares its query parameters (query: {} when it takes none), so any other parameter is a 400.
// There is no service-role key anywhere in this file or its dependencies.
import { createRoute } from './pipeline.js'
import { requireUser } from './user.js'
import { ApiError, conflict } from './errors.js'
import {
  DEFAULT_PAGE_SIZE,
  cursorParam,
  enumParam,
  keysetAfter,
  limitParam,
  paginate,
  seqParam,
  uuidParam,
} from './params.js'
import { allRows, dbError, isUniqueViolation, singleRow } from './workspaceDb.js'
import {
  CONVERSATIONS_TABLE,
  CONVERSATION_COLUMNS,
  CONVERSATION_CREATE_KEYS,
  CONVERSATION_PATCH_KEYS,
  LIBRARY_COLUMNS,
  LIBRARY_TABLE,
  MESSAGES_PAGE_DEFAULT,
  MESSAGES_PAGE_MAX,
  MESSAGES_TABLE,
  MESSAGE_BODY_MAX_BYTES,
  MESSAGE_COLUMNS,
  MESSAGE_CREATE_KEYS,
  OWNER_COLUMN,
  PROJECTS_TABLE,
  PROJECT_COLUMNS,
  PROJECT_CREATE_KEYS,
  PROJECT_LIST_SELECT,
  PROJECT_PATCH_KEYS,
  SAVED_COLUMNS,
  SAVED_CREATE_KEYS,
  SAVED_TABLE,
  parseConversationCreate,
  parseConversationPatch,
  parseMessageCreate,
  parseProjectCreate,
  parseProjectPatch,
  parseSavedCreate,
  rowToConversation,
  rowToLibraryItem,
  rowToMessage,
  rowToProject,
  rowToSaved,
} from './workspaceData.js'

const pageQuery = () => ({ limit: limitParam(), cursor: cursorParam() })

export function createWorkspaceRoutes({ getConfig, createSupabase, logger }) {
  const route = (options, fn) => createRoute({ getConfig, createSupabase, logger }, options, fn)

  // ---------------------------------------------------------------- projects

  // GET  /api/projects?status=active|archived&limit&cursor   POST /api/projects
  const projectsIndex = route(
    {
      methods: ['GET', 'POST'],
      path: '/api/projects',
      query: { status: enumParam(['active', 'archived']), ...pageQuery() },
      body: { POST: PROJECT_CREATE_KEYS },
    },
    async (ctx) => {
      const { supabase, user } = await requireUser(ctx)

      if (ctx.request.method === 'POST') {
        const row = parseProjectCreate(ctx.body) // user_id is never sent: the column default and RLS set it
        const result = await supabase.from(PROJECTS_TABLE).insert(row).select(PROJECT_COLUMNS)
        return { status: 201, body: { project: rowToProject(singleRow(ctx, 'workspace.project.create', result)) } }
      }

      const limit = ctx.query.limit ?? DEFAULT_PAGE_SIZE
      let query = supabase.from(PROJECTS_TABLE).select(PROJECT_LIST_SELECT).eq(OWNER_COLUMN, user.id)
      query = (ctx.query.status ?? 'active') === 'archived' ? query.not('archived_at', 'is', null) : query.is('archived_at', null)
      if (ctx.query.cursor) query = query.or(keysetAfter('updated_at', ctx.query.cursor))
      const result = await query.order('updated_at', { ascending: false }).order('id', { ascending: false }).limit(limit + 1)
      const { page, nextCursor } = paginate(allRows(ctx, 'workspace.project.list', result), limit, 'updated_at')
      return { body: { projects: page.map(rowToProject), nextCursor } }
    },
  )

  // GET | PATCH | DELETE /api/projects/:id
  const projectById = route(
    { methods: ['GET', 'PATCH', 'DELETE'], path: '/api/projects/:id', query: {}, body: { PATCH: PROJECT_PATCH_KEYS } },
    async (ctx) => {
      const { supabase, user } = await requireUser(ctx)
      const { id } = ctx.params
      const owned = (q) => q.eq('id', id).eq(OWNER_COLUMN, user.id)

      if (ctx.request.method === 'PATCH') {
        const row = parseProjectPatch(ctx.body)
        const result = await owned(supabase.from(PROJECTS_TABLE).update(row)).select(PROJECT_COLUMNS)
        return { body: { project: rowToProject(singleRow(ctx, 'workspace.project.update', result)) } }
      }
      if (ctx.request.method === 'DELETE') {
        // The conversations.project_fk / library_items.project_fk ON DELETE SET NULL (project_id) detaches
        // conversations and library items; nothing a user wrote is deleted with the project.
        const result = await owned(supabase.from(PROJECTS_TABLE).delete()).select('id')
        singleRow(ctx, 'workspace.project.delete', result)
        return { status: 204 }
      }
      const result = await owned(supabase.from(PROJECTS_TABLE).select(PROJECT_LIST_SELECT))
      return { body: { project: rowToProject(singleRow(ctx, 'workspace.project.read', result)) } }
    },
  )

  // ----------------------------------------------------------- conversations

  // GET /api/conversations?projectId&limit&cursor
  // POST /api/conversations  { content, clientRequestId, mentorId?, projectId? } -> conversation + first message, atomically
  const conversationsIndex = route(
    {
      methods: ['GET', 'POST'],
      path: '/api/conversations',
      query: { projectId: uuidParam(), ...pageQuery() },
      body: { POST: CONVERSATION_CREATE_KEYS },
      maxBodyBytes: MESSAGE_BODY_MAX_BYTES,
    },
    async (ctx) => {
      const { supabase, user } = await requireUser(ctx)

      if (ctx.request.method === 'POST') {
        const input = parseConversationCreate(ctx.body) // validates the mentor id against the catalog
        const result = await supabase.rpc('create_conversation', {
          p_title: input.title,
          p_mentor_id: input.mentorId,
          p_project_id: input.projectId,
          p_content: input.content,
          p_client_request_id: input.clientRequestId,
        })
        if (isUniqueViolation(result)) return replayConversationCreate(ctx, supabase, user, input)
        if (result.error) throw dbError(ctx, 'workspace.conversation.create', result, { historyGate: true })
        const created = result.data
        if (!created || typeof created !== 'object' || !created.conversation || !created.message) {
          throw new ApiError(500, 'internal_error')
        }
        return {
          status: 201,
          body: { conversation: rowToConversation(created.conversation), message: rowToMessage(created.message) },
        }
      }

      const limit = ctx.query.limit ?? DEFAULT_PAGE_SIZE
      let query = supabase.from(CONVERSATIONS_TABLE).select(CONVERSATION_COLUMNS).eq(OWNER_COLUMN, user.id)
      if (ctx.query.projectId) query = query.eq('project_id', ctx.query.projectId)
      if (ctx.query.cursor) query = query.or(keysetAfter('last_message_at', ctx.query.cursor))
      const result = await query.order('last_message_at', { ascending: false }).order('id', { ascending: false }).limit(limit + 1)
      const { page, nextCursor } = paginate(allRows(ctx, 'workspace.conversation.list', result), limit, 'last_message_at')
      return { body: { conversations: page.map(rowToConversation), nextCursor } }
    },
  )

  // A retried create carries the same clientRequestId. The unique index on (user_id, client_request_id) rolled
  // the whole create back, so nothing is orphaned; answer with the original result if the request is identical.
  async function replayConversationCreate(ctx, supabase, user, input) {
    const found = await supabase
      .from(MESSAGES_TABLE)
      .select(MESSAGE_COLUMNS)
      .eq(OWNER_COLUMN, user.id)
      .eq('client_request_id', input.clientRequestId)
    const message = singleRow(ctx, 'workspace.conversation.replay.message', found)
    if (message.seq !== 1 || message.role !== 'user' || message.content !== input.content) throw conflict('conflict')
    const conv = await supabase
      .from(CONVERSATIONS_TABLE)
      .select(CONVERSATION_COLUMNS)
      .eq('id', message.conversation_id)
      .eq(OWNER_COLUMN, user.id)
    const conversation = singleRow(ctx, 'workspace.conversation.replay.conversation', conv)
    if (conversation.mentor_id !== input.mentorId || conversation.project_id !== input.projectId) throw conflict('conflict')
    return { status: 200, body: { conversation: rowToConversation(conversation), message: rowToMessage(message) } }
  }

  // GET | PATCH | DELETE /api/conversations/:id
  const conversationById = route(
    { methods: ['GET', 'PATCH', 'DELETE'], path: '/api/conversations/:id', query: {}, body: { PATCH: CONVERSATION_PATCH_KEYS } },
    async (ctx) => {
      const { supabase, user } = await requireUser(ctx)
      const { id } = ctx.params
      const owned = (q) => q.eq('id', id).eq(OWNER_COLUMN, user.id)

      if (ctx.request.method === 'PATCH') {
        const row = parseConversationPatch(ctx.body) // only title and projectId; a foreign project fails the composite FK -> 404
        const result = await owned(supabase.from(CONVERSATIONS_TABLE).update(row)).select(CONVERSATION_COLUMNS)
        return { body: { conversation: rowToConversation(singleRow(ctx, 'workspace.conversation.update', result)) } }
      }
      if (ctx.request.method === 'DELETE') {
        // Cascades to the conversation's messages and saved items. API-only in A4 (no UI, no bulk delete).
        const result = await owned(supabase.from(CONVERSATIONS_TABLE).delete()).select('id')
        singleRow(ctx, 'workspace.conversation.delete', result)
        return { status: 204 }
      }
      const result = await owned(supabase.from(CONVERSATIONS_TABLE).select(CONVERSATION_COLUMNS))
      return { body: { conversation: rowToConversation(singleRow(ctx, 'workspace.conversation.read', result)) } }
    },
  )

  // ---------------------------------------------------------------- messages

  // GET  /api/conversations/:id/messages?limit&after=<seq>   (ascending by seq; nextCursor is the last seq returned)
  // POST /api/conversations/:id/messages  { role, content, clientRequestId }   (append-only)
  const conversationMessages = route(
    {
      methods: ['GET', 'POST'],
      path: '/api/conversations/:id/messages',
      query: { limit: limitParam({ max: MESSAGES_PAGE_MAX }), after: seqParam() },
      body: { POST: MESSAGE_CREATE_KEYS },
      maxBodyBytes: MESSAGE_BODY_MAX_BYTES,
    },
    async (ctx) => {
      const { supabase, user } = await requireUser(ctx)
      const { id } = ctx.params

      if (ctx.request.method === 'POST') {
        const input = parseMessageCreate(ctx.body)
        const result = await supabase
          .from(MESSAGES_TABLE)
          .insert({
            conversation_id: id,
            role: input.role,
            content: input.content,
            is_demo: input.isDemo, // derived from the role, never from the request
            client_request_id: input.clientRequestId,
          })
          .select(MESSAGE_COLUMNS)
        if (isUniqueViolation(result)) return replayMessage(ctx, supabase, user, id, input)
        return { status: 201, body: { message: rowToMessage(singleRow(ctx, 'workspace.message.create', result, { historyGate: true })) } }
      }

      // One query: the conversation (so a foreign or missing id is a 404, not an empty list) with its messages.
      const limit = ctx.query.limit ?? MESSAGES_PAGE_DEFAULT
      let query = supabase
        .from(CONVERSATIONS_TABLE)
        .select(`id,messages:messages!messages_conversation_fk(${MESSAGE_COLUMNS})`)
        .eq('id', id)
        .eq(OWNER_COLUMN, user.id)
      if (ctx.query.after !== undefined) query = query.gt('messages.seq', ctx.query.after)
      const result = await query
        .order('seq', { referencedTable: 'messages', ascending: true })
        .limit(limit + 1, { referencedTable: 'messages' })
      const conversation = singleRow(ctx, 'workspace.message.list', result)
      const rows = Array.isArray(conversation.messages) ? conversation.messages : []
      const page = rows.slice(0, limit)
      const nextCursor = rows.length > limit ? page[page.length - 1].seq : null
      return { body: { messages: page.map(rowToMessage), nextCursor } }
    },
  )

  async function replayMessage(ctx, supabase, user, conversationId, input) {
    const found = await supabase
      .from(MESSAGES_TABLE)
      .select(MESSAGE_COLUMNS)
      .eq(OWNER_COLUMN, user.id)
      .eq('client_request_id', input.clientRequestId)
    const message = singleRow(ctx, 'workspace.message.replay', found)
    if (message.conversation_id !== conversationId || message.role !== input.role || message.content !== input.content) {
      throw conflict('conflict')
    }
    return { status: 200, body: { message: rowToMessage(message) } }
  }

  // ------------------------------------------------------------------- saved

  // GET /api/saved?limit&cursor   POST /api/saved { conversationId, messageId? }
  const savedIndex = route(
    { methods: ['GET', 'POST'], path: '/api/saved', query: pageQuery(), body: { POST: SAVED_CREATE_KEYS } },
    async (ctx) => {
      const { supabase, user } = await requireUser(ctx)

      if (ctx.request.method === 'POST') {
        const input = parseSavedCreate(ctx.body)
        const result = await supabase
          .from(SAVED_TABLE)
          .insert({ conversation_id: input.conversationId, message_id: input.messageId })
          .select(SAVED_COLUMNS)
        if (isUniqueViolation(result)) {
          // Saving the same target twice is idempotent: return the existing item.
          let existing = supabase
            .from(SAVED_TABLE)
            .select(SAVED_COLUMNS)
            .eq(OWNER_COLUMN, user.id)
            .eq('conversation_id', input.conversationId)
          existing = input.messageId === null ? existing.is('message_id', null) : existing.eq('message_id', input.messageId)
          return { status: 200, body: { item: rowToSaved(singleRow(ctx, 'workspace.saved.replay', await existing)) } }
        }
        return { status: 201, body: { item: rowToSaved(singleRow(ctx, 'workspace.saved.create', result)) } }
      }

      const limit = ctx.query.limit ?? DEFAULT_PAGE_SIZE
      let query = supabase.from(SAVED_TABLE).select(SAVED_COLUMNS).eq(OWNER_COLUMN, user.id)
      if (ctx.query.cursor) query = query.or(keysetAfter('created_at', ctx.query.cursor))
      const result = await query.order('created_at', { ascending: false }).order('id', { ascending: false }).limit(limit + 1)
      const { page, nextCursor } = paginate(allRows(ctx, 'workspace.saved.list', result), limit, 'created_at')
      return { body: { items: page.map(rowToSaved), nextCursor } }
    },
  )

  // DELETE /api/saved/:id
  const savedById = route({ methods: ['DELETE'], path: '/api/saved/:id', query: {} }, async (ctx) => {
    const { supabase, user } = await requireUser(ctx)
    const result = await supabase.from(SAVED_TABLE).delete().eq('id', ctx.params.id).eq(OWNER_COLUMN, user.id).select('id')
    singleRow(ctx, 'workspace.saved.delete', result)
    return { status: 204 }
  })

  // ----------------------------------------------------------------- library

  // GET /api/library?source=user|ombre&limit&cursor   (read-only in A4)
  const libraryIndex = route(
    { methods: ['GET'], path: '/api/library', query: { source: enumParam(['user', 'ombre']), ...pageQuery() } },
    async (ctx) => {
      const { supabase, user } = await requireUser(ctx)
      const limit = ctx.query.limit ?? DEFAULT_PAGE_SIZE
      let query = supabase.from(LIBRARY_TABLE).select(LIBRARY_COLUMNS).eq(OWNER_COLUMN, user.id)
      if (ctx.query.source) query = query.eq('source', ctx.query.source)
      if (ctx.query.cursor) query = query.or(keysetAfter('created_at', ctx.query.cursor))
      const result = await query.order('created_at', { ascending: false }).order('id', { ascending: false }).limit(limit + 1)
      const { page, nextCursor } = paginate(allRows(ctx, 'workspace.library.list', result), limit, 'created_at')
      return { body: { items: page.map(rowToLibraryItem), nextCursor } }
    },
  )

  // GET /api/library/:id
  const libraryById = route({ methods: ['GET'], path: '/api/library/:id', query: {} }, async (ctx) => {
    const { supabase, user } = await requireUser(ctx)
    const result = await supabase.from(LIBRARY_TABLE).select(LIBRARY_COLUMNS).eq('id', ctx.params.id).eq(OWNER_COLUMN, user.id)
    return { body: { item: rowToLibraryItem(singleRow(ctx, 'workspace.library.read', result)) } }
  })

  return {
    projectsIndex,
    projectById,
    conversationsIndex,
    conversationById,
    conversationMessages,
    savedIndex,
    savedById,
    libraryIndex,
    libraryById,
  }
}
