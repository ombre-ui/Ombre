// Thin adapter: Vercel's Node (req, res) handler <-> Web-standard (Request) => Response route.
// Only needed because the routes are written against Web Request/Response so they can be unit tested
// without a server. The body is read from the stream here (bounded) so an oversized body is rejected
// before anything is buffered, and no framework body parser sees it.
import { MAX_BODY_BYTES } from './pipeline.js'

const DROP_REQUEST_HEADERS = new Set(['host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'content-length', 'expect'])

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

export function toNode(route) {
  return async function handler(req, res) {
    try {
      const headers = new Headers()
      for (const [key, value] of Object.entries(req.headers)) {
        if (DROP_REQUEST_HEADERS.has(key.toLowerCase()) || value === undefined) continue
        headers.append(key, Array.isArray(value) ? value.join(', ') : value)
      }
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
      const body = hasBody ? await readLimited(req, MAX_BODY_BYTES) : undefined
      // The request host is never trusted or used; only the path matters to the routes.
      const request = new Request(`http://internal.invalid${req.url}`, {
        method: req.method,
        headers,
        body: body && body.length > 0 ? body : undefined,
      })

      const response = await route(request)

      res.statusCode = response.status
      for (const [key, value] of response.headers) {
        if (key.toLowerCase() !== 'set-cookie') res.setHeader(key, value)
      }
      const cookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []
      if (cookies.length > 0) res.setHeader('Set-Cookie', cookies)
      res.end(Buffer.from(await response.arrayBuffer()))
    } catch (error) {
      if (error instanceof TooLarge) {
        sendJson(res, 413, { error: { code: 'payload_too_large', message: 'The request was too large.' } })
      } else {
        sendJson(res, 500, { error: { code: 'internal_error', message: 'Something went wrong.' } })
      }
    }
  }
}
