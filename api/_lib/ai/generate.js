// One generation: trusted prompt + context -> provider -> validated reply. Server-only: never imported by src/.
//
// It does not read the database (the caller loads the history rows with context.loadHistoryRows), does not persist
// anything, does not retry, and does not choose HTTP statuses. It uses the S4-A provider contract exactly: the
// request has precisely { system, messages, model, maxOutputTokens, signal }.
//
// Failures a caller must tell apart:
//   AiProviderError   thrown by the provider, passed through untouched (timeout, unavailable, rate_limited, ...)
//   AiOutputError     the provider answered, but the answer is unusable (reason: malformed_result, invalid_text,
//                     blank, oversize). Nothing about the text is kept in the error.
//   PromptError       the conversation's mentor id has no trusted prompt (no fallback exists)
//   ContextError      the stored rows cannot make a valid request
//   TypeError         a programming error (a caller or provider broke its contract)
import { FINISH_REASONS } from './provider.js'
import { resolveSystemPrompt } from './prompts.js'
import { buildContext } from './context.js'

// The database limit for a message. Longer output is a failure: it is never truncated and never given a marker.
export const MAX_REPLY_CODE_POINTS = 8000
export const OUTPUT_FAILURE_REASONS = Object.freeze(['malformed_result', 'invalid_text', 'blank', 'oversize'])

export class AiOutputError extends Error {
  constructor(reason, { replyChars } = {}) {
    if (!OUTPUT_FAILURE_REASONS.includes(reason)) throw new TypeError('Unknown AiOutputError reason.')
    super(reason)
    this.name = 'AiOutputError'
    this.reason = reason
    if (Number.isInteger(replyChars) && replyChars >= 0) this.replyChars = replyChars // a length only, never the text
  }
}

function codePoints(text) {
  let count = 0
  for (const _ of text) count += 1
  return count
}

function normalizeUsage(usage) {
  if (usage === null || typeof usage !== 'object') return null
  const { in: input, out } = usage
  if (!Number.isInteger(input) || input < 0 || !Number.isInteger(out) || out < 0) return null
  return { in: input, out }
}

// Text: a string, well formed, no NUL, not blank, at most 8000 code points, returned exactly as the provider gave it.
// Metadata (finishReason, usage) is kept when valid; invalid metadata is normalized ('other' / null), because it is
// informational and must not fail a good reply.
export function validateProviderResult(result) {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) throw new AiOutputError('malformed_result')
  const { text } = result
  if (typeof text !== 'string') throw new AiOutputError('malformed_result')
  if (!text.isWellFormed() || text.includes('\u0000')) throw new AiOutputError('invalid_text')
  if (text.trim() === '') throw new AiOutputError('blank')
  const replyChars = codePoints(text)
  if (replyChars > MAX_REPLY_CODE_POINTS) throw new AiOutputError('oversize', { replyChars })
  return {
    text,
    finishReason: FINISH_REASONS.includes(result.finishReason) ? result.finishReason : 'other',
    usage: normalizeUsage(result.usage),
    replyChars,
  }
}

// provider: { generate }, config: the loadAiConfig() object (or a compatible one), mentorId: the stored
// conversations.mentor_id (null = General AI), rows/targetSeq: see buildContext. `signal` is optional; by default a
// deadline signal of config.timeoutMs is used.
// Resolves to { text, finishReason, usage, meta } where meta holds only counts and identifiers (safe to log).
export async function generateReply({ provider, config, mentorId, rows, targetSeq, signal }) {
  if (!provider || typeof provider.generate !== 'function') throw new TypeError('provider.generate is required.')
  if (!config || typeof config !== 'object') throw new TypeError('config is required.')

  const system = resolveSystemPrompt(mentorId) // throws PromptError: no fallback
  const context = buildContext({
    systemPrompt: system,
    rows,
    targetSeq,
    inputCharBudget: config.inputCharBudget,
    historyMaxMessages: config.historyMaxMessages,
  })
  const requestSignal = signal === undefined ? AbortSignal.timeout(config.timeoutMs) : signal

  const started = performance.now()
  const result = await provider.generate({
    system: context.system,
    messages: context.messages,
    model: config.model,
    maxOutputTokens: config.maxOutputTokens,
    signal: requestSignal,
  })
  const output = validateProviderResult(result)

  return {
    text: output.text,
    finishReason: output.finishReason,
    usage: output.usage,
    meta: {
      provider: config.provider,
      model: config.model,
      mentorId,
      ...context.stats,
      replyChars: output.replyChars,
      latencyMs: Math.round(performance.now() - started),
    },
  }
}
