// Builds the provider request context for one generation. Server-only: never imported by src/.
//
// What the context contains, and nothing else:
//   - the trusted system prompt (chosen by prompts.js from the stored mentor id)
//   - this conversation's persisted history through the target user message
// It never includes Memory, Library, Projects, profile or settings data, other conversations, or demo messages.
//
// The builder is pure (rows in, provider messages out). loadHistoryRows() is the only database access, and it is
// scoped by conversation AND authenticated user.
import { allRows } from '../workspaceDb.js'

// Data-driven failures: the stored rows cannot produce a valid request. Codes: invalid_rows, target_missing,
// target_unusable (not a non-demo, non-blank user message), budget_exceeded. Messages never contain content.
export class ContextError extends Error {
  constructor(code) {
    super(code)
    this.name = 'ContextError'
    this.code = code
  }
}

export const HISTORY_COLUMNS = 'seq, role, content, is_demo'
export const MESSAGE_SEPARATOR = '\n\n'

function codePoints(text) {
  let count = 0
  for (const _ of text) count += 1 // counts code points, like the database's char_length
  return count
}

function positiveInteger(value) {
  return Number.isInteger(value) && value >= 1
}

// The newest `limit` non-demo messages of the conversation up to and including the target, newest first. Every
// read is filtered by conversation and by the authenticated user (RLS is a second layer, not the only one).
export async function loadHistoryRows(ctx, { supabase, conversationId, userId, targetSeq, limit }) {
  if (typeof conversationId !== 'string' || conversationId === '') throw new TypeError('conversationId is required.')
  if (typeof userId !== 'string' || userId === '') throw new TypeError('userId is required.')
  if (!positiveInteger(targetSeq) || !positiveInteger(limit)) throw new TypeError('targetSeq and limit must be positive integers.')
  const result = await supabase
    .from('messages')
    .select(HISTORY_COLUMNS)
    .eq('conversation_id', conversationId)
    .eq('user_id', userId)
    .eq('is_demo', false)
    .lte('seq', targetSeq)
    .order('seq', { ascending: false })
    .limit(limit)
  return allRows(ctx, 'ai.history', result)
}

// Consecutive messages with the same role become one message joined by a blank line (the provider contract needs
// alternating roles). Contents are otherwise untouched.
function mergeRuns(messages) {
  const merged = []
  for (const message of messages) {
    const last = merged[merged.length - 1]
    if (last && last.role === message.role) last.content = `${last.content}${MESSAGE_SEPARATOR}${message.content}`
    else merged.push({ role: message.role, content: message.content })
  }
  return merged
}

// Size of the final provider payload in code points: the system prompt plus every merged message (separators
// included).
function payloadSize(systemChars, sizes, messages) {
  let total = systemChars
  messages.forEach((message, i) => {
    total += sizes[i]
    if (i > 0 && messages[i - 1].role === message.role) total += MESSAGE_SEPARATOR.length
  })
  return total
}

// rows: [{ seq, role, content, is_demo }] in any order (anything from the loader, the target included).
// Steps: validate -> keep seq <= targetSeq -> drop demo -> newest `historyMaxMessages` -> oldest first -> drop blank
// -> drop the oldest whole messages until the payload fits the budget -> merge same-role runs.
// The target is the newest row, so every step that removes the oldest messages leaves it in place. No message is
// ever truncated. Returns { system, messages, stats } where `messages` satisfies the S4-A provider contract.
export function buildContext({ systemPrompt, rows, targetSeq, inputCharBudget, historyMaxMessages }) {
  if (typeof systemPrompt !== 'string' || systemPrompt.trim() === '') throw new TypeError('systemPrompt is required.')
  if (!Array.isArray(rows)) throw new TypeError('rows must be an array.')
  if (!positiveInteger(targetSeq)) throw new TypeError('targetSeq must be a positive integer.')
  if (!positiveInteger(inputCharBudget)) throw new TypeError('inputCharBudget must be a positive integer.')
  if (!positiveInteger(historyMaxMessages)) throw new TypeError('historyMaxMessages must be a positive integer.')

  const seen = new Set()
  let target = null
  let droppedDemo = 0
  const history = []
  for (const row of rows) {
    const valid =
      row !== null &&
      typeof row === 'object' &&
      positiveInteger(row.seq) &&
      (row.role === 'user' || row.role === 'assistant') &&
      typeof row.content === 'string' &&
      typeof row.is_demo === 'boolean'
    if (!valid || seen.has(row.seq)) throw new ContextError('invalid_rows')
    seen.add(row.seq)
    if (row.seq > targetSeq) continue // later than the target: not part of this context
    if (row.seq === targetSeq) target = row
    if (row.is_demo) {
      droppedDemo += 1
      continue
    }
    history.push({ seq: row.seq, role: row.role, content: row.content })
  }

  if (target === null) throw new ContextError('target_missing')
  if (target.role !== 'user' || target.is_demo || target.content.trim() === '') throw new ContextError('target_unusable')

  history.sort((a, b) => a.seq - b.seq) // oldest first
  const windowed = history.slice(-historyMaxMessages)
  const droppedByCap = history.length - windowed.length

  const usable = windowed.filter((message) => message.content.trim() !== '')
  const droppedBlank = windowed.length - usable.length

  const systemChars = codePoints(systemPrompt)
  const sizes = usable.map((message) => codePoints(message.content))
  let start = 0
  const kept = () => usable.slice(start)
  while (payloadSize(systemChars, sizes.slice(start), kept()) > inputCharBudget) {
    if (start >= usable.length - 1) throw new ContextError('budget_exceeded') // only the target is left
    start += 1
  }
  const sent = kept()
  const messages = mergeRuns(sent)

  return {
    system: systemPrompt,
    messages,
    stats: {
      historyMessages: sent.length,
      mergedMessages: messages.length,
      droppedDemo,
      droppedByCap,
      droppedBlank,
      droppedByBudget: start,
      promptChars: payloadSize(systemChars, sizes.slice(start), sent),
    },
  }
}
