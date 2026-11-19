import test from 'node:test'
import assert from 'node:assert/strict'
import { AI_DEFAULTS, AiConfigError, SUPPORTED_PROVIDERS, isFakeProviderAllowed, loadAiConfig } from '../../api/_lib/ai/config.js'
import { ConfigError } from '../../api/_lib/config.js'

const base = (over = {}) => ({ AI_PROVIDER: 'fake', AI_MODEL: 'fake-model', VERCEL_ENV: 'preview', ...over })

test('the approved defaults are exactly: 1500 output tokens, 60000 input characters, 40 history messages', () => {
  assert.deepEqual({ ...AI_DEFAULTS }, { maxOutputTokens: 1500, inputCharBudget: 60000, historyMaxMessages: 40, timeoutMs: 30000 })
  assert.ok(Object.isFrozen(AI_DEFAULTS))
  assert.deepEqual([...SUPPORTED_PROVIDERS], ['fake'])
})

test('a minimal environment yields a frozen config with the approved defaults and nothing else', () => {
  const config = loadAiConfig(base())
  assert.deepEqual({ ...config }, {
    provider: 'fake',
    model: 'fake-model',
    maxOutputTokens: 1500,
    inputCharBudget: 60000,
    historyMaxMessages: 40,
    timeoutMs: 30000,
  })
  assert.ok(Object.isFrozen(config))
})

test('overrides are parsed as whole numbers and trimmed', () => {
  const config = loadAiConfig(base({
    AI_PROVIDER: ' fake ',
    AI_MODEL: '  meta/llama-3.1-70b-instruct ',
    AI_MAX_OUTPUT_TOKENS: ' 800 ',
    AI_INPUT_CHAR_BUDGET: '30000',
    AI_HISTORY_MAX_MESSAGES: '10',
    AI_TIMEOUT_MS: '5000',
  }))
  assert.deepEqual({ ...config }, {
    provider: 'fake',
    model: 'meta/llama-3.1-70b-instruct',
    maxOutputTokens: 800,
    inputCharBudget: 30000,
    historyMaxMessages: 10,
    timeoutMs: 5000,
  })
  // a blank numeric variable means "use the default"
  assert.equal(loadAiConfig(base({ AI_MAX_OUTPUT_TOKENS: '   ' })).maxOutputTokens, 1500)
})

test('errors are AiConfigError (a ConfigError), name the variable, and never echo a value', () => {
  const failures = [
    base({ AI_PROVIDER: undefined }),
    base({ AI_PROVIDER: '' }),
    base({ AI_PROVIDER: 'SECRET-PROVIDER-VALUE' }),
    base({ AI_MODEL: undefined }),
    base({ AI_MODEL: 'SECRET model with spaces' }),
    base({ AI_MAX_OUTPUT_TOKENS: 'SECRET-NUMBER' }),
    base({ AI_TIMEOUT_MS: '999999999' }),
    base({ VERCEL_ENV: 'production' }),
  ]
  for (const env of failures) {
    try {
      loadAiConfig(env)
      assert.fail('expected a config error')
    } catch (error) {
      assert.ok(error instanceof AiConfigError, String(error))
      assert.ok(error instanceof ConfigError)
      assert.equal(error.name, 'AiConfigError')
      assert.ok(!error.message.includes('SECRET'), error.message)
      assert.match(error.message, /AI_PROVIDER|AI_MODEL|AI_MAX_OUTPUT_TOKENS|AI_TIMEOUT_MS|fake AI provider/)
    }
  }
})

test('only the fake provider is supported in S4', () => {
  for (const provider of ['nvidia', 'cloudflare', 'openai', 'FAKE', 'fake2']) {
    assert.throws(() => loadAiConfig(base({ AI_PROVIDER: provider })), AiConfigError, provider)
  }
})

test('model ids use the probe charset: accepted and rejected examples', () => {
  for (const model of ['fake-model', 'meta/llama-3.1-70b-instruct', '@cf/meta/llama-3.1-8b-instruct', 'a'.repeat(128), 'v1.2:latest']) {
    assert.equal(loadAiConfig(base({ AI_MODEL: model })).model, model, model)
  }
  for (const model of ['has space', 'semi;colon', 'new\nline', 'quote"d', 'a'.repeat(129), '@@double', 'back\\slash', 'ünïcode']) {
    assert.throws(() => loadAiConfig(base({ AI_MODEL: model })), AiConfigError, JSON.stringify(model))
  }
})

test('numeric variables reject non-integers and out-of-range values on both sides', () => {
  const bounds = {
    AI_MAX_OUTPUT_TOKENS: [1, 8192],
    AI_INPUT_CHAR_BUDGET: [1000, 400000],
    AI_HISTORY_MAX_MESSAGES: [1, 200],
    AI_TIMEOUT_MS: [1000, 120000],
  }
  for (const [name, [min, max]] of Object.entries(bounds)) {
    assert.doesNotThrow(() => loadAiConfig(base({ [name]: String(min) })), `${name} min`)
    assert.doesNotThrow(() => loadAiConfig(base({ [name]: String(max) })), `${name} max`)
    assert.throws(() => loadAiConfig(base({ [name]: String(min - 1) })), AiConfigError, `${name} below`)
    assert.throws(() => loadAiConfig(base({ [name]: String(max + 1) })), AiConfigError, `${name} above`)
    for (const junk of ['1.5', 'abc', '1e3', '-1', '0x10', '1 000', '+5']) {
      assert.throws(() => loadAiConfig(base({ [name]: junk })), AiConfigError, `${name}=${junk}`)
    }
  }
})

test('the fake provider is refused in production and in any unknown environment (fail closed)', () => {
  const matrix = [
    [{ VERCEL_ENV: 'production' }, false],
    [{ VERCEL_ENV: ' production ' }, false],
    [{ VERCEL_ENV: 'Production' }, false],
    [{ VERCEL_ENV: 'staging' }, false],
    [{ VERCEL_ENV: 'preview' }, true],
    [{ VERCEL_ENV: 'development' }, true],
    [{ VERCEL_ENV: 'preview', NODE_ENV: 'production' }, true], // Vercel previews build with NODE_ENV=production
    [{ VERCEL_ENV: 'production', NODE_ENV: 'development' }, false],
    [{ NODE_ENV: 'production' }, false],
    [{ NODE_ENV: ' production ' }, false],
    [{ NODE_ENV: 'development' }, true],
    [{ NODE_ENV: 'test' }, true],
    [{}, true],
  ]
  for (const [env, allowed] of matrix) {
    assert.equal(isFakeProviderAllowed(env), allowed, JSON.stringify(env))
    const full = { AI_PROVIDER: 'fake', AI_MODEL: 'fake-model', ...env }
    if (allowed) assert.equal(loadAiConfig(full).provider, 'fake')
    else assert.throws(() => loadAiConfig(full), /fake AI provider is not allowed/)
  }
})

test('the config holds no secret: unrelated and credential-looking variables are never copied', () => {
  const config = loadAiConfig(base({ AI_API_KEY: 'SECRET-KEY', NVIDIA_API_KEY: 'SECRET-NVIDIA', SUPABASE_PUBLISHABLE_KEY: 'SECRET-SUPA' }))
  assert.deepEqual(Object.keys(config).sort(), ['historyMaxMessages', 'inputCharBudget', 'maxOutputTokens', 'model', 'provider', 'timeoutMs'])
  assert.ok(!JSON.stringify(config).includes('SECRET'))
  assert.ok(!Object.keys(config).some((key) => /apikey|api_key|secret|password|credential/i.test(key)))
})
