// Per-instance, in-memory sliding-window limiter, used as DEFENSE IN DEPTH for the password-reset code flow.
//
// What it is: a cap on how often one client (IP) or one target (email) can hit the reset-code endpoint on a
// given warm serverless instance. What it is not: a global guarantee. Instances do not share memory, and
// Supabase Auth's own public API (reachable with the publishable key) accepts the same verifications, so the
// authoritative limits (OTP expiry, per-user email interval, token-verification rate limit, email send limit)
// are Supabase Auth settings. See docs/password-reset.md.
import { createHash } from 'node:crypto'

const SWEEP_AT = 10000
const SWEEP_AGE_MS = 2 * 60 * 60 * 1000

export function limiterKey(prefix, value) {
  // Hashed so raw emails/IPs are never held as map keys or ever logged.
  return `${prefix}:${createHash('sha256').update(String(value)).digest('hex')}`
}

export function createMemoryLimiter({ now = () => Date.now() } = {}) {
  const buckets = new Map() // key -> ascending timestamps (ms)

  function sweep(t) {
    if (buckets.size <= SWEEP_AT) return
    for (const [key, list] of buckets) {
      if (list.length === 0 || t - list[list.length - 1] > SWEEP_AGE_MS) buckets.delete(key)
    }
  }

  return {
    // Records an attempt unless the window is already full. { allowed, retryAfterMs }.
    hit(key, { max, windowMs }) {
      const t = now()
      const list = buckets.get(key) || []
      while (list.length && t - list[0] >= windowMs) list.shift()
      if (list.length >= max) {
        buckets.set(key, list)
        return { allowed: false, retryAfterMs: windowMs - (t - list[0]) }
      }
      list.push(t)
      buckets.set(key, list)
      sweep(t)
      return { allowed: true, retryAfterMs: 0 }
    },
    reset(key) {
      buckets.delete(key)
    },
    size() {
      return buckets.size
    },
  }
}
