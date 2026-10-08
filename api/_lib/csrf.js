import { forbidden } from './errors.js'

export const CSRF_HEADER = 'x-ombre-request'
export const CSRF_VALUE = '1'
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

// Returns the validated Origin for state-changing requests (or null for safe methods).
//  - Sec-Fetch-Site: cross-site is rejected for every method.
//  - Non-GET requests need an Origin that exactly equals one of APP_ORIGINS (string equality,
//    no normalization, no Referer fallback) AND the custom header. A cross-origin page cannot add
//    the custom header without a CORS preflight, and we never answer preflights.
export function checkRequestOrigin(request, config) {
  if (request.headers.get('sec-fetch-site') === 'cross-site') throw forbidden()
  if (SAFE_METHODS.has(request.method)) return null

  const origin = request.headers.get('origin')
  if (!origin || !config.appOrigins.includes(origin)) throw forbidden()
  if (request.headers.get(CSRF_HEADER) !== CSRF_VALUE) throw forbidden()
  return origin
}
