// Usage: SSE_SPIKE_TOKEN=... [VERCEL_BYPASS=...] node client.mjs <url> [full|abort] [abortAfterMs]
const [, , url, mode = 'full', abortAfter = '4000'] = process.argv
if (!url || !['full', 'abort'].includes(mode) || !process.env.SSE_SPIKE_TOKEN) {
  console.error('usage: SSE_SPIKE_TOKEN=... node client.mjs <url> [full|abort] [abortAfterMs]')
  process.exit(2)
}
const t0 = performance.now()
const ms = () => Math.round(performance.now() - t0)
const ac = new AbortController()
const headers = { 'x-spike-token': process.env.SSE_SPIKE_TOKEN }
if (process.env.VERCEL_BYPASS) headers['x-vercel-protection-bypass'] = process.env.VERCEL_BYPASS

const chunks = [], events = [], heartbeats = []
let status, ttfb, abortedAt, endedAt, error, buf = '', timer

try {
  const res = await fetch(url, { headers, signal: ac.signal })
  status = res.status
  ttfb = ms()
  if (mode === 'abort') timer = setTimeout(() => { abortedAt = ms(); ac.abort() }, Number(abortAfter))
  const dec = new TextDecoder()
  for await (const chunk of res.body) {
    const at = ms()
    chunks.push({ at, bytes: chunk.length })
    buf += dec.decode(chunk, { stream: true })
    let i
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, i)
      buf = buf.slice(i + 2)
      if (block.startsWith(':')) heartbeats.push(at)
      else events.push({ at, name: /^event: (.+)$/m.exec(block)?.[1] })
    }
  }
  endedAt = ms()
} catch (e) {
  error = e.name
  endedAt = ms()
} finally {
  clearTimeout(timer)
}

const evAt = events.map((e) => e.at)
const sawDone = events.some((e) => e.name === 'done')
const completion =
  mode === 'full' ? (sawDone && !error ? 'completed' : 'failed')
  : error === 'AbortError' ? 'aborted_as_requested'
  : 'ended_without_abort'

console.log(JSON.stringify({
  mode, status, completion, error,
  ttfbMs: ttfb,
  firstEventMs: evAt[0],
  lastEventMs: evAt.at(-1),
  eventSpreadMs: evAt.length ? evAt.at(-1) - evAt[0] : 0,
  events: events.length,
  chunks: chunks.length,
  eventsPerChunk: +(events.length / Math.max(1, chunks.length)).toFixed(2),
  heartbeatsAtMs: heartbeats,
  sawDone,
  abortedAtMs: abortedAt,
  endedAtMs: endedAt,
  abortToEndMs: abortedAt != null ? endedAt - abortedAt : undefined,
  chunkTimesMs: chunks.map((c) => c.at),
}, null, 1))
