// A5.1 S4-C: POST /api/conversations/:id/generate  { messageId }
//
// Complete-response generation only (no streaming). The handler runs after the shared pipeline has validated the
// method, Origin/CSRF, JSON, the request-key allowlist and the :id UUID, and it follows the approved lifecycle:
//
//   requireUser -> runtime config (before any DB read) -> messageId -> owner-scoped conversation + target ->
//   save_history -> target checks -> replay (200, no provider call) -> latest/limit -> in-flight guard ->
//   context + trusted prompt + provider via generateReply() -> append_assistant_message RPC (one transient retry)
//
// The provider is called at most once per request and never retried. The client supplies only messageId: the system
// prompt, mentor, provider and model all come from the server. Logs carry only the approved structured fields.
import { ApiError, aiFailed, aiTimeout, aiUnavailable, conflict, notFound, unauthorized, unavailable } from '../errors.js'
import { requireUser } from '../user.js'
import { parseUuid } from '../params.js'
import { allRows, singleRow } from '../workspaceDb.js'
import { CONVERSATIONS_TABLE, CONVERSATION_COLUMNS, MESSAGES_TABLE, MESSAGE_COLUMNS, OWNER_COLUMN, rowToMessage } from '../workspaceData.js'
import { SETTINGS_OWNER_COLUMN, SETTINGS_TABLE } from '../userData.js'
import { AiProviderError } from './provider.js'
import { ContextError, loadHistoryRows } from './context.js'
import { PromptError } from './prompts.js'
import { AiOutputError, generateReply } from './generate.js'

export const GENERATE_BODY_KEYS = Object.freeze(['messageId'])
export const APPEND_RPC = 'append_assistant_message'
export const IN_FLIGHT_RETRY_AFTER_SECONDS = '2'
const CONVERSATION_MESSAGE_CAP = 500

const internalError = () => new ApiError(500, 'internal_error')

function resolveRuntime(ctx, ai) {
  let runtime = null
  try {
    runtime = ai && typeof ai.getRuntime === 'function' ? ai.getRuntime() : null
  } catch {
    runtime = null
  }
  const usable =
    runtime !== null &&
    typeof runtime === 'object' &&
    runtime.provider !== null &&
    typeof runtime.provider === 'object' &&
    typeof runtime.provider.generate === 'function' &&
    runtime.config !== null &&
    typeof runtime.config === 'object'
  if (!usable) {
    ctx.log('ai.generate', { outcome: 'config_unavailable' })
    throw aiUnavailable()
  }
  return runtime
}

function replyLogFields(reply, mentorId, outcome) {
  const meta = reply.meta
  return {
    provider: meta.provider,
    model: meta.model,
    outcome,
    latencyMs: meta.latencyMs,
    promptChars: meta.promptChars,
    historyMessages: meta.historyMessages,
    replyChars: meta.replyChars,
    usageIn: reply.usage?.in,
    usageOut: reply.usage?.out,
    mentorId,
  }
}

// Provider/output/prompt/context failures -> the approved public errors. Nothing from the provider is exposed.
function mapGenerationError(ctx, error, { config, mentorId, started }) {
  if (error instanceof ApiError) return error
  const base = { provider: config.provider, model: config.model, latencyMs: Math.round(performance.now() - started), mentorId }
  if (error instanceof AiProviderError) {
    ctx.log('ai.generate', { ...base, outcome: String(error.kind) })
    if (error.kind === 'timeout') return aiTimeout()
    if (error.kind === 'malformed' || error.kind === 'refused') return aiFailed()
    return aiUnavailable()
  }
  if (error instanceof AiOutputError) {
    ctx.log('ai.generate', { ...base, outcome: 'output_invalid', replyChars: error.replyChars })
    return aiFailed()
  }
  if (error instanceof PromptError) {
    ctx.log('ai.generate', { ...base, outcome: 'prompt_error' })
    return internalError()
  }
  if (error instanceof ContextError) {
    ctx.log('ai.generate', { ...base, outcome: 'context_error' })
    return internalError()
  }
  return error
}

async function callAppend(supabase, args) {
  try {
    return await supabase.rpc(APPEND_RPC, args)
  } catch {
    return { data: null, error: { name: 'NetworkError' }, status: 0 }
  }
}

function statusOf(result) {
  return typeof result.status === 'number' ? result.status : 0
}

const isTransient = (result) => Boolean(result.error) && (statusOf(result) === 0 || statusOf(result) >= 500)

// Persistence failures are mapped here, independently of the generic dbError mapper. Only reached after the single
// transient retry has been spent, so a transient status here means "exhausted".
function mapPersistError(ctx, result) {
  const error = result.error || {}
  const status = statusOf(result)
  const code = typeof error.code === 'string' ? error.code : undefined
  ctx.logAuthError('ai.generate.persist', { name: error.name, status, code })
  if (status === 0 || status >= 500) return unavailable()
  if (status === 401 || code === 'PGRST301' || code === 'PGRST303' || code === '28000') return unauthorized()
  switch (code) {
    case 'OL002':
      return conflict('conflict')
    case '42501':
      return conflict('history_disabled')
    case 'OL001':
      return conflict('limit_reached')
    case '23514':
      return aiFailed()
    case '23503':
      return notFound()
    default:
      return internalError()
  }
}

async function persistReply(ctx, supabase, args) {
  let result = await callAppend(supabase, args)
  if (isTransient(result)) {
    ctx.log('ai.generate.persist_retry', { outcome: 'persist_retry' })
    result = await callAppend(supabase, args)
  }
  if (result.error) throw mapPersistError(ctx, result)
  const data = result.data
  const valid =
    data !== null &&
    typeof data === 'object' &&
    typeof data.replayed === 'boolean' &&
    data.message !== null &&
    typeof data.message === 'object' &&
    typeof data.message.id === 'string'
  if (!valid) throw internalError()
  return data
}

export function createGenerateHandler({ ai } = {}) {
  // Per-instance in-flight guard keyed by (userId, messageId). Cross-instance races are settled by the RPC.
  const inFlight = new Set()

  return async function generate(ctx) {
    const { supabase, user } = await requireUser(ctx)

    // Configuration is checked before any conversation/message read.
    const { provider, config } = resolveRuntime(ctx, ai)

    const messageId = parseUuid(ctx.body.messageId)
    const conversationId = ctx.params.id

    const conversation = singleRow(
      ctx,
      'ai.generate.conversation',
      await supabase.from(CONVERSATIONS_TABLE).select(CONVERSATION_COLUMNS).eq('id', conversationId).eq(OWNER_COLUMN, user.id),
    )
    const target = singleRow(
      ctx,
      'ai.generate.target',
      await supabase
        .from(MESSAGES_TABLE)
        .select(MESSAGE_COLUMNS)
        .eq('id', messageId)
        .eq('conversation_id', conversationId)
        .eq(OWNER_COLUMN, user.id),
    )

    // save_history is read owner-scoped; a missing or ambiguous settings row fails closed.
    const settings = allRows(
      ctx,
      'ai.generate.settings',
      await supabase.from(SETTINGS_TABLE).select('save_history').eq(SETTINGS_OWNER_COLUMN, user.id),
    )
    if (settings.length !== 1 || settings[0].save_history !== true) throw conflict('history_disabled')

    if (target.role !== 'user' || target.is_demo !== false) throw conflict('conflict')

    // A genuine assistant reply already follows the target: replay it, no provider call.
    const next = allRows(
      ctx,
      'ai.generate.replay',
      await supabase
        .from(MESSAGES_TABLE)
        .select(MESSAGE_COLUMNS)
        .eq('conversation_id', conversationId)
        .eq(OWNER_COLUMN, user.id)
        .eq('seq', target.seq + 1)
        .eq('role', 'assistant')
        .eq('is_demo', false),
    )
    if (next.length > 1) throw internalError()
    if (next.length === 1) {
      ctx.log('ai.generate', { outcome: 'replayed', mentorId: conversation.mentor_id })
      return { status: 200, body: { message: rowToMessage(next[0]) } }
    }

    if (conversation.message_count !== target.seq) throw conflict('conflict')
    if (target.seq >= CONVERSATION_MESSAGE_CAP) throw conflict('limit_reached')

    const key = `${user.id}:${messageId}`
    if (inFlight.has(key)) throw new ApiError(409, 'conflict', { headers: { 'Retry-After': IN_FLIGHT_RETRY_AFTER_SECONDS } })
    inFlight.add(key)
    try {
      const started = performance.now()
      let reply
      try {
        const rows = await loadHistoryRows(ctx, {
          supabase,
          conversationId,
          userId: user.id,
          targetSeq: target.seq,
          limit: config.historyMaxMessages,
        })
        reply = await generateReply({
          provider,
          config,
          mentorId: conversation.mentor_id,
          rows,
          targetSeq: target.seq,
          signal: AbortSignal.timeout(config.timeoutMs),
        })
      } catch (error) {
        throw mapGenerationError(ctx, error, { config, mentorId: conversation.mentor_id, started })
      }

      let persisted
      try {
        persisted = await persistReply(ctx, supabase, {
          p_conversation_id: conversationId,
          p_user_message_id: messageId,
          p_content: reply.text,
        })
      } catch (error) {
        ctx.log('ai.generate', replyLogFields(reply, conversation.mentor_id, 'persist_failed'))
        throw error
      }

      ctx.log('ai.generate', replyLogFields(reply, conversation.mentor_id, persisted.replayed ? 'replayed' : 'created'))
      return { status: persisted.replayed ? 200 : 201, body: { message: rowToMessage(persisted.message) } }
    } finally {
      inFlight.delete(key)
    }
  }
}
