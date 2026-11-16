// Thin adapter: Vercel's Node (req, res) handler <-> Web-standard (Request) => Response route.
// Only needed because the routes are written against Web Request/Response so they can be unit tested
// without a server. The body is read from the stream here (bounded) so an oversized body is rejected
// before anything is buffered, and no framework body parser sees it. The limit is the route's own
// (route.maxBodyBytes, set by createRoute) and defaults to MAX_BODY_BYTES.
import { MAX_BODY_BYTES } from './pipeline.js'

const DROP_REQUEST_HEADERS = new Set(['host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'content-length', 'expect'])
const EVENT_STREAM = /^text\/event-stream/i // [spike] only this content type is streamed

class TooLarge extends Error {}

async function readLimited(req, limit) {
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > limit) throw new TooLarge()
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new TooLarge()
    chunks.push(chunk)
  }
  if (size === 0 && Number.isFinite(declared) && declared > 0 && req.body != null) {
    // Safety net: the platform consumed the stream before us. Re-serialize the parsed body (still bounded).
    const text = typeof req.body === 'string' ? req.body : Buffer.isBuffer(req.body) ? req.body.toString('utf8') : JSON.stringify(req.body)
    if (Buffer.byteLength(text, 'utf8') > limit) throw new TooLarge()
    return Buffer.from(text, 'utf8')
  }
  return Buffer.concat(chunks)
}

function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'private, no-store, no-cache, max-age=0, must-revalidate')
  res.end(JSON.stringify(body))
}

// [spike] Resolves on drain, or immediately if the response is already closed/destroyed, so it cannot hang.
function waitDrain(res) {
  return new Promise((resolve) => {
    if (res.destroyed || res.writableEnded) return resolve()
    const done = () => { res.off('drain', done); res.off('close', done); resolve() }
    res.once('drain', done)
    res.once('close', done)
  })
}

// [spike] Names only (messages can carry secrets), same convention as the pipeline logger.
function defaultOnStreamEnd({ outcome, errName }) {
  if (outcome === 'error') console.error(JSON.stringify({ event: 'api.stream_error', errName }))
}

// [spike] SSE-only path. Headers/status/cookies are already set on res. Returns exactly one of:
//   completed     the stream finished, res.end() was called once, and the response flushed
//   client_abort  the response closed/was destroyed before it finished; the reader was cancelled
//   error         the stream or the response failed; the connection is destroyed (never ended cleanly)
async function pipeStream(res, response) {
  const reader = response.body.getReader()
  // Premature = the socket went away before the response finished flushing. 'close' alone is not evidence.
  const premature = () => res.destroyed && !res.writableFinished
  let outcome = 'completed'
  let errName
  res.once('close', () => {
    if (res.writableFinished) return
    reader.cancel().catch(() => {})
  })
  res.on('error', (e) => {
    if (!premature()) {
      outcome = 'error'
      errName = (e && e.name) || 'Error'
    }
  })
  res.flushHeaders()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (premature()) {
        outcome = 'client_abort'
        break
      }
      if (done) break
      if (!res.write(value)) await waitDrain(res)
    }
  } catch (e) {
    if (premature()) outcome = 'client_abort'
    else {
      outcome = 'error'
      errName = (e && e.name) || 'Error'
    }
  } finally {
    if (outcome === 'error') res.destroy()
    else if (!res.writableEnded && !res.destroyed) res.end()
  }
  return { outcome, errName }
}

export function toNode(route, options = {}) {
  const limit = typeof route.maxBodyBytes === 'number' ? route.maxBodyBytes : MAX_BODY_BYTES
  const onStreamEnd = typeof options.onStreamEnd === 'function' ? options.onStreamEnd : defaultOnStreamEnd
  return async function handler(req, res) {
    try {
      // [spike] A client disconnect before the response finished aborts the request signal.
      const abort = new AbortController()
      res.on('close', () => { if (!res.writableFinished) abort.abort() })

      const headers = new Headers()
      for (const [key, value] of Object.entries(req.headers)) {
        if (DROP_REQUEST_HEADERS.has(key.toLowerCase()) || value === undefined) continue
        headers.append(key, Array.isArray(value) ? value.join(', ') : value)
      }
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
      const body = hasBody ? await readLimited(req, limit) : undefined
      // The request host is never trusted or used; only the path matters to the routes.
      const request = new Request(`http://internal.invalid${req.url}`, {
        method: req.method,
        headers,
        body: body && body.length > 0 ? body : undefined,
        signal: abort.signal, // [spike]
      })

      const response = await route(request)

      res.statusCode = response.status
      for (const [key, value] of response.headers) {
        if (key.toLowerCase() !== 'set-cookie') res.setHeader(key, value)
      }
      const cookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []
      if (cookies.length > 0) res.setHeader('Set-Cookie', cookies)

      // [spike] Headers are fully copied above; only now may an SSE response flush them.
      if (response.body && EVENT_STREAM.test(response.headers.get('content-type') || '')) {
        onStreamEnd(await pipeStream(res, response))
        return
      }
      res.end(Buffer.from(await response.arrayBuffer()))
    } catch (error) {
      // [spike] Once headers are out a JSON error cannot be sent: cut the connection so the client sees a failure.
      if (res.headersSent) { res.destroy(); return }
      if (error instanceof TooLarge) {
        sendJson(res, 413, { error: { code: 'payload_too_large', message: 'The request was too large.' } })
      } else {
        sendJson(res, 500, { error: { code: 'internal_error', message: 'Something went wrong.' } })
      }
    }
  }
}
