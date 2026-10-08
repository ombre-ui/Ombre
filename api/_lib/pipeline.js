import { randomUUID } from 'node:crypto'
import { ApiError, methodNotAllowed } from './errors.js'
import { checkRequestOrigin } from './csrf.js'
import { parseJsonObject } from './validate.js'
import { describeAuthError } from './logger.js'

export const MAX_BODY_BYTES = 4096
const NO_STORE = 'private, no-store, no-cache, max-age=0, must-revalidate'

function baseHeaders(requestId) {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': NO_STORE,
    Pragma: 'no-cache',
    Expires: '0',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    Vary: 'Origin, Cookie',
    'X-Request-Id': requestId,
  }
}

async function readBody(request) {
  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new ApiError(413, 'payload_too_large')
  const text = await request.text()
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) throw new ApiError(413, 'payload_too_large')
  return text
}

// Builds a route: (Request) => Promise<Response>.
//   options.methods   allowed methods (others -> 405)
//   options.body      array of allowed JSON keys, or null for routes without a body
//   fn(ctx)           returns { status?, body } or throws ApiError
export function createRoute({ getConfig, createSupabase, logger }, options, fn) {
  const methods = options.methods
  const allowedKeys = options.body ?? null

  return async function route(request) {
    const started = Date.now()
    const requestId = randomUUID()
    const url = new URL(request.url)
    let status = 500
    let apiError
    let jar = null
    let extraHeaders = {}
    let payload

    try {
      if (!methods.includes(request.method)) throw methodNotAllowed(methods)

      const config = getConfig()
      const origin = checkRequestOrigin(request, config)

      let body
      if (allowedKeys) {
        const type = (request.headers.get('content-type') || '').toLowerCase()
        if (!/^application\/json(\s*;.*)?$/.test(type)) throw new ApiError(415, 'unsupported_media_type')
        body = parseJsonObject(await readBody(request), allowedKeys)
      } else if (request.method !== 'GET' && request.method !== 'HEAD') {
        await readBody(request) // enforce the size limit even when the body is ignored
      }

      let supa = null
      const ctx = {
        request,
        url,
        requestId,
        config,
        origin,
        body,
        supa() {
          if (!supa) {
            supa = createSupabase(request, config)
            jar = supa.jar
          }
          return supa
        },
        log(event, fields) {
          logger.info(event, { requestId, ...fields })
        },
        logAuthError(event, error) {
          logger.warn(event, { requestId, ...describeAuthError(error) })
        },
      }

      const result = await fn(ctx)
      status = result.status ?? 200
      payload = result.body ?? {}
    } catch (error) {
      if (error instanceof ApiError) {
        apiError = error
        status = error.status
        payload = { error: { code: error.code, message: error.publicMessage, requestId } }
        extraHeaders = error.headers || {}
      } else {
        // Unknown failure: log name only (messages can carry secrets), answer generically.
        status = 500
        logger.error('api.unhandled', { requestId, errName: error && typeof error.name === 'string' ? error.name : 'Error' })
        payload = { error: { code: 'internal_error', message: 'Something went wrong.', requestId } }
      }
    }

    const headers = new Headers(baseHeaders(requestId))
    for (const [k, v] of Object.entries(extraHeaders)) headers.set(k, v)
    if (jar) {
      for (const [k, v] of Object.entries(jar.extraHeaders())) {
        if (k.toLowerCase() !== 'cache-control') headers.set(k, v)
      }
      for (const cookie of jar.setCookieHeaders()) headers.append('Set-Cookie', cookie)
    }

    logger.info('api.request', {
      requestId,
      method: request.method,
      path: url.pathname,
      status,
      durationMs: Date.now() - started,
      apiError: apiError ? apiError.code : undefined,
    })

    return new Response(JSON.stringify(payload), { status, headers })
  }
}
