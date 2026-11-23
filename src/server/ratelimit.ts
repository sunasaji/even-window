// ratelimit.ts — a token bucket for the gate-exempt routes (docs/security.md,
// docs/decisions/open-route-rate-limit.md).
//
// The routes that answer before authentication are work anyone can make this host do; the
// session redeem runs an asymmetric verify per attempt. This bounds that CPU and memory. It is
// not an authorization control, and the caller applies it to `open: true` routes only — an
// authenticated client is supposed to be chatty.
//
// Two buckets: per source, so one noisy peer cannot starve another; and global, because
// behind `tailscale serve` every request arrives from 127.0.0.1. The per-source map is
// bounded: idle buckets are dropped and the table has a hard cap.

/** Deliberately loose: a real client needs one challenge + one session per session, plus one
 *  `GET /api/auth/pair/status` per two seconds while pairing. */
export interface LimitOpts {
  /** Burst size per source. */
  burst?: number
  /** Sustained refill, tokens per second, per source. */
  perSec?: number
  /** Burst size for all sources together. */
  globalBurst?: number
  /** Sustained refill for all sources together. */
  globalPerSec?: number
  /** Max tracked sources. Beyond this the fullest are dropped (see `evict`). */
  maxSources?: number
}

/** `last === null` means never spent from. A sentinel rather than `0`, because 0 is a
 *  legitimate timestamp for an injected clock. */
interface Bucket {
  tokens: number
  last: number | null
}

export interface Limiter {
  /** Spend one token for `source`. `false` ⇒ refuse the request (429). */
  take(source: string, now?: number): boolean
  /** Seconds the caller should advertise in `retry-after` — always ≥1. */
  retryAfterSec(): number
  /** Tracked source count, for tests and for the eviction assertion. */
  size(): number
}

export function createLimiter(o: LimitOpts = {}): Limiter {
  const burst = o.burst ?? 30
  const perSec = o.perSec ?? 3
  const globalBurst = o.globalBurst ?? 120
  const globalPerSec = o.globalPerSec ?? 12
  const maxSources = o.maxSources ?? 1024

  const sources = new Map<string, Bucket>()
  const global: Bucket = { tokens: globalBurst, last: null }

  /** Refill in place and spend one token if there is one. Time-based, so there is no timer;
   *  the refill is clamped to the burst, so idleness does not bank credit. */
  const spend = (b: Bucket, cap: number, rate: number, now: number): boolean => {
    const elapsed = b.last === null ? 0 : Math.max(0, now - b.last) / 1000
    b.tokens = Math.min(cap, b.tokens + elapsed * rate)
    b.last = now
    if (b.tokens < 1) return false
    b.tokens -= 1
    return true
  }

  /** Projected tokens without spending — "how un-limited is this source right now". */
  const peek = (b: Bucket, now: number): number => {
    const elapsed = b.last === null ? 0 : Math.max(0, now - b.last) / 1000
    return Math.min(burst, b.tokens + elapsed * perSec)
  }

  /** Make room, dropping the fullest first. A source currently being refused has the fewest
   *  tokens, so a flood cannot evict its own record by rotating through fresh sources; a
   *  source at its burst has no state worth keeping. */
  const evict = (now: number): void => {
    while (sources.size > maxSources) {
      let worstKey: string | null = null
      let worstTokens = -1
      for (const [k, b] of sources) {
        const t = peek(b, now)
        if (t > worstTokens) {
          worstTokens = t
          worstKey = k
        }
      }
      if (worstKey === null) break
      sources.delete(worstKey)
    }
  }

  return {
    take(source, now = Date.now()) {
      // Global first, and spent even when the per-source bucket would also refuse: that is
      // what caps a flood from many sources.
      const okGlobal = spend(global, globalBurst, globalPerSec, now)
      let b = sources.get(source)
      if (!b) {
        b = { tokens: burst, last: null }
        sources.set(source, b)
        // Evict after inserting: the new arrival is the fullest entry, so a one-shot source
        // goes before a flood's record.
        if (sources.size > maxSources) evict(now)
      }
      const okSource = spend(b, burst, perSec, now)
      return okGlobal && okSource
    },
    retryAfterSec() {
      return Math.max(1, Math.ceil(1 / perSec))
    },
    size() {
      return sources.size
    },
  }
}

/** The source key for a request: its remote address, or `'-'` when node cannot tell.
 *  `X-Forwarded-For` is deliberately not consulted: anything that can reach this port can set
 *  it and so mint a fresh bucket per request. The global bucket covers the proxied topology. */
export function limitSource(remoteAddress: string | undefined): string {
  return remoteAddress && remoteAddress.length > 0 ? remoteAddress : '-'
}
