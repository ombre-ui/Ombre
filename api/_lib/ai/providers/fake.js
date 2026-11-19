// TEST-ONLY AI provider. It makes no network call, holds no credential and produces canned text. It is refused
// in production by loadAiConfig() (see isFakeProviderAllowed) and every default reply starts with
// FAKE_REPLY_PREFIX, so a reply it produced can never be mistaken for a real one (for example on a preview).
//
// Deterministic: the default reply is a pure function of the request (no clock, no randomness).
// Inspectable: every accepted call is recorded in `calls` with the exact system prompt, the ordered messages
// (copied, so later mutation of the caller's array cannot change the record), model, maxOutputTokens and the very
// AbortSignal object the caller passed.
// Scriptable: `script` is an array (behaviour for call 0, 1, 2, ...; calls past the end use the default
// behaviour) or a function (call, index) => behaviour. A behaviour is undefined (default) or an object:
//   { reply: string | (call) => string }   exact text, no prefix
//   { oversize: true | n }                 n code points of text (default 8001, one past the message limit)
//   { blank: true }                        whitespace-only text
//   { returns: any }                       returned as-is, to exercise validation of a malformed result
//   { throw: kind, status? }               reject with AiProviderError(kind)
//   { hang: true }                         never settle until the signal aborts
//   { wait: thenable }                     settle only after the thenable does (or the signal aborts)
//   { finishReason, usage }                override those fields of a produced result
// `throw`, `hang`, `reply`, `oversize`, `blank` and `returns` are mutually exclusive; `wait` combines with any.
import { createHash } from 'node:crypto'
import {
  AiProviderError,
  FINISH_REASONS,
  PROVIDER_ERROR_KINDS,
  assertGenerateRequest,
} from '../provider.js'

export const FAKE_PROVIDER_ID = 'fake'
export const FAKE_REPLY_PREFIX = '[FAKE PROVIDER - TEST ONLY]'
export const FAKE_OVERSIZE_DEFAULT = 8001
const ECHO_CODE_POINTS = 60

const PRODUCERS = ['reply', 'oversize', 'blank', 'returns', 'throw', 'hang']
const BEHAVIOR_KEYS = [...PRODUCERS, 'wait', 'status', 'finishReason', 'usage']

const codePoints = (text) => Array.from(text).length

function validateBehavior(behavior) {
  if (behavior === undefined) return behavior
  if (behavior === null || typeof behavior !== 'object' || Array.isArray(behavior)) {
    throw new TypeError('A fake provider behaviour must be undefined or an object.')
  }
  for (const key of Object.keys(behavior)) {
    if (!BEHAVIOR_KEYS.includes(key)) throw new TypeError(`Unknown fake provider behaviour field: ${key}`)
  }
  if (PRODUCERS.filter((key) => key in behavior).length > 1) {
    throw new TypeError('A fake provider behaviour may use only one of reply, oversize, blank, returns, throw, hang.')
  }
  if ('reply' in behavior && typeof behavior.reply !== 'string' && typeof behavior.reply !== 'function') {
    throw new TypeError('reply must be a string or a function.')
  }
  if ('oversize' in behavior && behavior.oversize !== true && !(Number.isInteger(behavior.oversize) && behavior.oversize > 0)) {
    throw new TypeError('oversize must be true or a positive integer.')
  }
  if ('blank' in behavior && behavior.blank !== true) throw new TypeError('blank must be true.')
  if ('hang' in behavior && behavior.hang !== true) throw new TypeError('hang must be true.')
  if ('throw' in behavior && !PROVIDER_ERROR_KINDS.includes(behavior.throw)) {
    throw new TypeError('throw must be an AiProviderError kind.')
  }
  if ('status' in behavior && !('throw' in behavior)) throw new TypeError('status is only valid with throw.')
  if ('finishReason' in behavior && !FINISH_REASONS.includes(behavior.finishReason)) {
    throw new TypeError('finishReason is not a known finish reason.')
  }
  if ('wait' in behavior && typeof behavior.wait?.then !== 'function') throw new TypeError('wait must be a thenable.')
  return behavior
}

// A deadline (AbortSignal.timeout) is a timeout; any other abort is an abort.
function abortError(signal) {
  return new AiProviderError(signal.reason && signal.reason.name === 'TimeoutError' ? 'timeout' : 'aborted')
}

function untilSettledOrAborted(thenable, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError(signal))
    const onAbort = () => reject(abortError(signal))
    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve(thenable).then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

function defaultText(call) {
  const digest = createHash('sha256')
    .update(JSON.stringify([call.system, call.messages, call.model, call.maxOutputTokens]))
    .digest('hex')
    .slice(0, 16)
  const lastUser = [...call.messages].reverse().find((m) => m.role === 'user')
  const echo = Array.from(lastUser.content.replace(/\s+/g, ' ').trim()).slice(0, ECHO_CODE_POINTS).join('')
  return `${FAKE_REPLY_PREFIX} ${digest} | re: ${echo}`
}

export function createFakeProvider({ script } = {}) {
  if (script !== undefined && typeof script !== 'function' && !Array.isArray(script)) {
    throw new TypeError('script must be an array or a function.')
  }
  if (Array.isArray(script)) script.forEach(validateBehavior)

  const calls = []
  let served = 0

  function nextBehavior(call) {
    const index = served
    served += 1
    if (typeof script === 'function') return validateBehavior(script(call, index))
    if (Array.isArray(script)) return script[index]
    return undefined
  }

  async function generate(request) {
    assertGenerateRequest(request)
    const call = Object.freeze({
      system: request.system,
      messages: Object.freeze(request.messages.map((m) => Object.freeze({ role: m.role, content: m.content }))),
      model: request.model,
      maxOutputTokens: request.maxOutputTokens,
      signal: request.signal, // the caller's real AbortSignal, by identity
    })
    calls.push(call)
    const behavior = nextBehavior(call) ?? {}

    if (call.signal.aborted) throw abortError(call.signal)
    if ('wait' in behavior) await untilSettledOrAborted(behavior.wait, call.signal)
    if ('hang' in behavior) await untilSettledOrAborted(new Promise(() => {}), call.signal)
    if ('throw' in behavior) throw new AiProviderError(behavior.throw, { status: behavior.status })
    if ('returns' in behavior) return behavior.returns

    let text
    if ('reply' in behavior) text = typeof behavior.reply === 'function' ? behavior.reply(call) : behavior.reply
    else if ('oversize' in behavior) text = 'x'.repeat(behavior.oversize === true ? FAKE_OVERSIZE_DEFAULT : behavior.oversize)
    else if ('blank' in behavior) text = '  \n \t '
    else text = defaultText(call)

    // Characters, not tokens: this provider has no tokenizer. The shape is what matters.
    const inputChars = codePoints(call.system) + call.messages.reduce((sum, m) => sum + codePoints(m.content), 0)
    return {
      text,
      finishReason: behavior.finishReason ?? 'stop',
      usage: behavior.usage !== undefined ? behavior.usage : { in: inputChars, out: codePoints(text) },
      provider: FAKE_PROVIDER_ID,
      model: call.model,
    }
  }

  function reset() {
    calls.length = 0
    served = 0
  }

  return { id: FAKE_PROVIDER_ID, calls, generate, reset }
}
