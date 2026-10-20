import { randomUUID } from 'node:crypto'
import { ApiError, methodNotAllowed } from './errors.js'
import { checkRequestOrigin } from './csrf.js'
import { parseJsonObject } from './validate.js'
import { matchPath, parseQuery } from './params.js'
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

async function readBody(request, limit) {
  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > limit) throw new ApiError(413, 'payload_too_large')
  const text = await request.text()
  if (Buffer.byteLength(text, 'utf8') > limit) throw new ApiError(413, 'payload_too_large')
  return text
}

// Which JSON keys a request may carry. options.body is either
//   - an array of keys: every method of the route takes a JSON body with exactly those keys (A2 routes), or
//   - an object keyed by method ({ PATCH: ['displayName'] }): only the listed methods take a JSON body,
//     all other methods (GET) are bodyless, or
//   - null/undefined: no body.
function allowedKeysFor(bodyOption, method) {
  if (Array.isArray(bodyOption)) return bodyOption
  if (bodyOption && typeof bodyOption === 'object' && Object.prototype.hasOwnProperty.call(bodyOption, method)) {
    return bodyOption[method]
  }
  return null
}

// Builds a route: (Request) => Promise<Response>.
//   options.methods        allowed methods (others -> 405)
//   options.body           see allowedKeysFor
//   options.maxBodyBytes   request body limit for this route (default MAX_BODY_BYTES). Exposed as
//                          route.maxBodyBytes so the Node adapter enforces the same limit while streaming.
//   options.path           optional path template such as '/api/conversations/:id/messages'. Path parameters
//                          must be canonical lowercase UUIDs (400 otherwise); a non-matching path is 404.
//                          Result: ctx.params.
//   options.query          optional map of allowed query parameter -> parser. Unknown or repeated parameters are
//                          rejected (400). Without this option the query string is not inspected (A2/A3 routes).
//                          Result: ctx.query.
//   fn(ctx)                returns { status?, body } or throws ApiError. status 204 sends no body.
export function createRoute({ getConfig, createSupabase, logger }, options, fn) {
  const methods = options.methods
  const bodyOption = options.body ?? null
  const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES

  async function route(request) {
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

      const params = options.path ? matchPath(url.pathname, options.path) : {}
      const query = options.query ? parseQuery(url, options.query) : {}

      const allowedKeys = allowedKeysFor(bodyOption, request.method)
      let body
      if (allowedKeys) {
        const type = (request.headers.get('content-type') || '').toLowerCase()
        if (!/^application\/json(\s*;.*)?$/.test(type)) throw new ApiError(415, 'unsupported_media_type')
        body = parseJsonObject(await readBody(request, maxBodyBytes), allowedKeys)
      } else if (request.method !== 'GET' && request.method !== 'HEAD') {
        await readBody(request, maxBodyBytes) // enforce the size limit even when the body is ignored
      }

      let supa = null
      const ctx = {
        request,
        url,
        requestId,
        config,
        origin,
        body,
        params,
        query,
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
      payload = status === 204 ? null : (result.body ?? {})
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

    // A 204 response must not carry a body.
    return new Response(status === 204 ? null : JSON.stringify(payload), { status, headers })
  }

  route.maxBodyBytes = maxBodyBytes
  return route
}
