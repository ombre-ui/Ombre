// Server-only AI configuration. Never imported by src/. It is separate from loadConfig() on purpose: routes that do
// not generate (auth, projects, ...) and their tests must not need any AI environment.
//
// S4 knows one provider, 'fake' (test-only, refused in production). No credential exists yet: the real provider
// and its key arrive in S5. Errors name the variable that is wrong and never echo a value.
import { ConfigError } from '../config.js'

export class AiConfigError extends ConfigError {
  constructor(message) {
    super(message)
    this.name = 'AiConfigError'
  }
}

export const SUPPORTED_PROVIDERS = Object.freeze(['fake'])

// timeoutMs is a placeholder: S5 sets the real value against the verified function duration limit.
export const AI_DEFAULTS = Object.freeze({
  maxOutputTokens: 1500,
  inputCharBudget: 60000,
  historyMaxMessages: 40,
  timeoutMs: 30000,
})

// Same shape the A5.0 probe accepts for a model id (an optional leading "@", then a restricted charset).
const MODEL_RE = /^@?[A-Za-z0-9._:/-]{1,128}$/
const INTEGER_RE = /^[0-9]{1,9}$/

// The fake provider produces canned text and must never answer real users. Fail closed: it is allowed only when
// the runtime says preview or development, or says nothing and is not a production Node process.
export function isFakeProviderAllowed(env = process.env) {
  const vercelEnv = String(env.VERCEL_ENV ?? '').trim()
  if (vercelEnv === 'preview' || vercelEnv === 'development') return true
  if (vercelEnv === '') return String(env.NODE_ENV ?? '').trim() !== 'production'
  return false // production, or any value this code does not know
}

function wholeNumber(env, name, fallback, min, max) {
  const raw = env[name]
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback
  const text = String(raw).trim()
  if (!INTEGER_RE.test(text)) throw new AiConfigError(`${name} must be a whole number.`)
  const value = Number(text)
  if (value < min || value > max) throw new AiConfigError(`${name} must be between ${min} and ${max}.`)
  return value
}

export function loadAiConfig(env = process.env) {
  const provider = String(env.AI_PROVIDER ?? '').trim()
  if (!provider) throw new AiConfigError('AI_PROVIDER is not configured.')
  if (!SUPPORTED_PROVIDERS.includes(provider)) throw new AiConfigError('AI_PROVIDER is not a supported provider.')
  if (provider === 'fake' && !isFakeProviderAllowed(env)) {
    throw new AiConfigError('The fake AI provider is not allowed in this environment.')
  }

  const model = String(env.AI_MODEL ?? '').trim()
  if (!model) throw new AiConfigError('AI_MODEL is not configured.')
  if (!MODEL_RE.test(model)) throw new AiConfigError('AI_MODEL is not a valid model id.')

  return Object.freeze({
    provider,
    model,
    maxOutputTokens: wholeNumber(env, 'AI_MAX_OUTPUT_TOKENS', AI_DEFAULTS.maxOutputTokens, 1, 8192),
    inputCharBudget: wholeNumber(env, 'AI_INPUT_CHAR_BUDGET', AI_DEFAULTS.inputCharBudget, 1000, 400000),
    historyMaxMessages: wholeNumber(env, 'AI_HISTORY_MAX_MESSAGES', AI_DEFAULTS.historyMaxMessages, 1, 200),
    timeoutMs: wholeNumber(env, 'AI_TIMEOUT_MS', AI_DEFAULTS.timeoutMs, 1000, 120000),
  })
}
