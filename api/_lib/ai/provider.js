// AI provider contract. Server-only: this module (like everything under api/_lib/ai) is never imported by src/.
//
// A provider is an object with one method:
//
//   generate({ system, messages, model, maxOutputTokens, signal })
//     system           the trusted system prompt (string, chosen by the server, never by the client)
//     messages         [{ role: 'user' | 'assistant', content }]  roles alternate and the last message is a user message
//     model            provider model id (string)
//     maxOutputTokens  positive integer
//     signal           a real AbortSignal; the provider must stop and reject when it aborts
//   -> Promise<{ text, finishReason: 'stop' | 'length' | 'other', usage: { in, out } | null, provider, model }>
//
// Failures reject with AiProviderError. A provider never throws, returns or logs anything that contains the
// upstream response body, an upstream message, a request payload or a credential: the error carries only a fixed
// `kind` and, optionally, the upstream HTTP status.
//
// Deadline vs abort: when the signal aborts because a deadline passed (AbortSignal.timeout), signal.reason is a
// TimeoutError and the provider rejects with kind 'timeout'; any other abort rejects with kind 'aborted'.

export const PROVIDER_ERROR_KINDS = Object.freeze(['timeout', 'unavailable', 'rate_limited', 'malformed', 'refused', 'aborted'])
export const FINISH_REASONS = Object.freeze(['stop', 'length', 'other'])
export const MESSAGE_ROLES = Object.freeze(['user', 'assistant'])

const REQUEST_KEYS = Object.freeze(['system', 'messages', 'model', 'maxOutputTokens', 'signal'])
const MESSAGE_KEYS = Object.freeze(['content', 'role'])

export class AiProviderError extends Error {
  constructor(kind, options = {}) {
    if (!PROVIDER_ERROR_KINDS.includes(kind)) throw new TypeError('Unknown AiProviderError kind.')
    super(kind) // the message is only the fixed kind: nothing an upstream said can end up in it
    this.name = 'AiProviderError'
    this.kind = kind
    const status = options && options.status
    if (Number.isInteger(status) && status >= 100 && status <= 599) this.status = status
  }
}

export function isAiProviderError(error) {
  return error instanceof AiProviderError
}

// Throws a TypeError (a programming error, never a client error) when a caller does not honour the contract.
// Messages are fixed strings: they never include prompt or message content.
export function assertGenerateRequest(request) {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('The generate request must be an object.')
  }
  for (const key of Object.keys(request)) {
    if (!REQUEST_KEYS.includes(key)) throw new TypeError('The generate request has an unexpected field.')
  }
  if (typeof request.system !== 'string' || request.system.trim() === '') {
    throw new TypeError('The generate request needs a non-empty system prompt.')
  }
  const { messages } = request
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new TypeError('The generate request needs at least one message.')
  }
  let previousRole = null
  for (const message of messages) {
    if (message === null || typeof message !== 'object' || Array.isArray(message)) {
      throw new TypeError('Every message must be an object.')
    }
    const keys = Object.keys(message).sort()
    if (keys.length !== MESSAGE_KEYS.length || keys.some((k, i) => k !== MESSAGE_KEYS[i])) {
      throw new TypeError('A message must have exactly a role and content.')
    }
    if (!MESSAGE_ROLES.includes(message.role)) throw new TypeError('A message role must be user or assistant.')
    if (typeof message.content !== 'string' || message.content.trim() === '') {
      throw new TypeError('A message needs non-empty content.')
    }
    if (message.role === previousRole) throw new TypeError('Message roles must alternate.')
    previousRole = message.role
  }
  if (previousRole !== 'user') throw new TypeError('The last message must be a user message.')
  if (typeof request.model !== 'string' || request.model.trim() === '') {
    throw new TypeError('The generate request needs a model.')
  }
  if (!Number.isInteger(request.maxOutputTokens) || request.maxOutputTokens < 1) {
    throw new TypeError('maxOutputTokens must be a positive integer.')
  }
  if (!(request.signal instanceof AbortSignal)) throw new TypeError('The generate request needs a real AbortSignal.')
  return request
}
