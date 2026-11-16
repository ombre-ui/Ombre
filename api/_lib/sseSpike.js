import { timingSafeEqual } from 'node:crypto'

const enc = new TextEncoder()
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))
const notFound = () => new Response('{"error":{"code":"not_found"}}', { status: 404, headers: { 'Content-Type': 'application/json' } })

// Throwaway spike gate: never in production, and only with the Preview-only token.
function allowed(request) {
  if (process.env.VERCEL_ENV === 'production') return false
  const expected = process.env.SSE_SPIKE_TOKEN
  if (!expected) return false
  const a = Buffer.from(request.headers.get('x-spike-token') || '')
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const done = () => { clearTimeout(t); signal.removeEventListener('abort', done); resolve() }
    const t = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })
}

export function createSseSpikeRoute({ onEvent = () => {} } = {}) {
  return async function sseSpike(request) {
    if (!allowed(request)) return notFound()
    if (request.method !== 'GET') return new Response(null, { status: 405, headers: { Allow: 'GET' } })
    const q = new URL(request.url).searchParams // unknown params (e.g. platform __vf/__vp) are ignored
    const seconds = clamp(Number(q.get('seconds')) || 20, 1, 30)
    const tickMs = clamp(Number(q.get('tickMs')) || 1000, 100, 2000)
    const hbMs = clamp(Number(q.get('hbMs')) || 15000, 1000, 30000)
    const t0 = Date.now()
    const at = () => Date.now() - t0

    const work = new AbortController() // aborted by request abort OR stream cancel
    request.signal.addEventListener('abort', () => { onEvent('abort_observed', { atMs: at() }); work.abort() }, { once: true })
    if (request.signal.aborted) work.abort()

    const stream = new ReadableStream({
      async start(c) {
        const send = (s) => { if (!work.signal.aborted) c.enqueue(enc.encode(s)) }
        send(`event: open\ndata: ${JSON.stringify({ t: 0, serverTs: t0 })}\n\n`)
        onEvent('open', { atMs: at() })
        let lastHb = Date.now()
        const total = Math.round((seconds * 1000) / tickMs)
        for (let i = 1; i <= total; i++) {
          await sleep(tickMs, work.signal)
          if (work.signal.aborted) { onEvent('work_stopped', { atMs: at(), i }); return }
          send(`event: tick\ndata: ${JSON.stringify({ n: i, t: at() })}\n\n`)
          onEvent('tick', { n: i, atMs: at() })
          if (Date.now() - lastHb >= hbMs) { send(': hb\n\n'); lastHb = Date.now(); onEvent('heartbeat', { atMs: at() }) }
        }
        send(`event: done\ndata: ${JSON.stringify({ t: at() })}\n\n`)
        c.close()
        onEvent('completed', { atMs: at() })
      },
      cancel() { onEvent('stream_cancelled', { atMs: at() }); work.abort() },
    })

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  }
}
