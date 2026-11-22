// A5.1 S4-C: the server-side AI runtime the generation route receives as deps.ai.
//
// getRuntime() resolves { provider, config } from the server environment object it was created with. It throws
// AiConfigError when the configuration is missing or invalid (including the fake provider in production), and
// the route turns that into 503 ai_unavailable before any database read. Only a successful resolution is cached,
// so a failure never sticks. There is no real provider yet (S4-A ships only the fake one); a real provider is
// added to PROVIDER_FACTORIES in a later stage and nothing the client sends can influence this choice.
import { AiConfigError, loadAiConfig } from './config.js'
import { createFakeProvider } from './providers/fake.js'

export const PROVIDER_FACTORIES = Object.freeze({
  fake: () => createFakeProvider(),
})

export function createAiRuntime({ env, providers = PROVIDER_FACTORIES } = {}) {
  if (env === null || typeof env !== 'object') throw new TypeError('createAiRuntime requires an env object.')
  let cached = null

  function getRuntime() {
    if (cached) return cached
    const config = loadAiConfig(env)
    const factory = Object.hasOwn(providers, config.provider) ? providers[config.provider] : undefined
    if (typeof factory !== 'function') throw new AiConfigError('AI_PROVIDER has no provider implementation.')
    const provider = factory(config)
    if (provider === null || typeof provider !== 'object' || typeof provider.generate !== 'function') {
      throw new AiConfigError('The AI provider implementation is invalid.')
    }
    cached = Object.freeze({ provider, config })
    return cached
  }

  return Object.freeze({ getRuntime })
}
