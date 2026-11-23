// even-window — the token bucket in front of the gate-exempt routes (docs/security.md).
//
// What is bounded is availability, not guessing: `POST /api/auth/session` runs an asymmetric
// verify per attempt, the only unauthenticated CPU this server spends.
//
// Pinned: a legitimate client never hits the limit, a flood is stopped, the per-source map is
// bounded, and a bucket does not bank credit while idle. The clock is injected.

import { describe, expect, it } from 'vitest'
import { createLimiter, limitSource } from '../src/server/ratelimit.ts'

describe('createLimiter', () => {
  it('lets a burst through and then refuses', () => {
    const l = createLimiter({ burst: 5, perSec: 1, globalBurst: 1000, globalPerSec: 1000 })
    for (let i = 0; i < 5; i++) expect(l.take('a', 0), `#${i}`).toBe(true)
    expect(l.take('a', 0)).toBe(false)
  })

  it('refills over time, not per call', () => {
    const l = createLimiter({ burst: 2, perSec: 2, globalBurst: 1000, globalPerSec: 1000 })
    expect(l.take('a', 0)).toBe(true)
    expect(l.take('a', 0)).toBe(true)
    expect(l.take('a', 0)).toBe(false)
    expect(l.take('a', 400)).toBe(false) // 0.8 tokens: not yet one
    expect(l.take('a', 600)).toBe(true) // 1.2 tokens
  })

  it('does not bank credit while idle — a bucket is capped at its burst', () => {
    const l = createLimiter({ burst: 3, perSec: 10, globalBurst: 1000, globalPerSec: 1000 })
    expect(l.take('a', 0)).toBe(true)
    // An hour later it has 3 tokens, not 36000.
    for (let i = 0; i < 3; i++) expect(l.take('a', 3_600_000), `#${i}`).toBe(true)
    expect(l.take('a', 3_600_000)).toBe(false)
  })

  it('keeps sources apart — one noisy peer must not starve another', () => {
    const l = createLimiter({ burst: 2, perSec: 1, globalBurst: 1000, globalPerSec: 1000 })
    expect(l.take('noisy', 0)).toBe(true)
    expect(l.take('noisy', 0)).toBe(true)
    expect(l.take('noisy', 0)).toBe(false)
    expect(l.take('quiet', 0)).toBe(true)
  })

  it('still caps the total, which is the only bucket that bites behind a proxy', () => {
    // Behind `tailscale serve` every request arrives from 127.0.0.1, so per-source degenerates
    // to one bucket — and a flood from many spoofed sources would otherwise get a fresh bucket
    // each. The global bucket is what covers both.
    const l = createLimiter({ burst: 100, perSec: 100, globalBurst: 4, globalPerSec: 1 })
    for (let i = 0; i < 4; i++) expect(l.take(`src-${i}`, 0), `#${i}`).toBe(true)
    expect(l.take('src-99', 0)).toBe(false)
  })

  it('bounds the source table — an unbounded one is the DoS it prevents', () => {
    const l = createLimiter({
      burst: 1,
      perSec: 100,
      globalBurst: 1e6,
      globalPerSec: 1e6,
      maxSources: 8,
    })
    // 500 distinct sources, spread over time so buckets refill and become evictable.
    for (let i = 0; i < 500; i++) l.take(`src-${i}`, i * 100)
    expect(l.size()).toBeLessThanOrEqual(8)
  })

  it('cannot be made to evict the record of an active flood', () => {
    // Eviction drops buckets that have refilled to full. A bucket currently being limited is
    // by definition not full, so a flood cannot wash away its own limit by rotating sources.
    const l = createLimiter({
      burst: 2,
      perSec: 0.001,
      globalBurst: 1e6,
      globalPerSec: 1e6,
      maxSources: 4,
    })
    expect(l.take('flood', 0)).toBe(true)
    expect(l.take('flood', 0)).toBe(true)
    expect(l.take('flood', 0)).toBe(false)
    for (let i = 0; i < 50; i++) l.take(`other-${i}`, 1)
    expect(l.take('flood', 2)).toBe(false) // still refused
  })

  it('advertises a retry-after of at least one second', () => {
    expect(createLimiter({ perSec: 3 }).retryAfterSec()).toBeGreaterThanOrEqual(1)
    expect(createLimiter({ perSec: 0.5 }).retryAfterSec()).toBe(2)
  })
})

describe('the defaults leave a real client alone', () => {
  // The traffic a legitimate device puts on the open routes: one challenge + one session per
  // session establishment, and `GET /api/auth/pair/status` every 2s while a human is pairing.
  it('passes a pairing device polling every 2s for five minutes', () => {
    const l = createLimiter()
    for (let i = 0; i < 150; i++) {
      expect(l.take('10.0.0.9', i * 2000), `poll #${i}`).toBe(true)
    }
  })

  it('passes a re-establish storm: five boots in seven minutes, two calls each', () => {
    // The WebView is torn down and rebuilt often, and each boot does challenge + session.
    const l = createLimiter()
    for (let boot = 0; boot < 5; boot++) {
      const t = boot * 84_000
      expect(l.take('10.0.0.9', t)).toBe(true)
      expect(l.take('10.0.0.9', t + 50)).toBe(true)
    }
  })

  it('stops a verify flood well inside a second', () => {
    const l = createLimiter()
    let allowed = 0
    for (let i = 0; i < 1000; i++) if (l.take('attacker', 0)) allowed += 1
    // The burst, and nothing beyond it.
    expect(allowed).toBeLessThanOrEqual(30)
    expect(allowed).toBeGreaterThan(0)
  })
})

describe('limitSource', () => {
  it('is the socket address, with a fallback that cannot collide with an address', () => {
    expect(limitSource('10.0.0.9')).toBe('10.0.0.9')
    expect(limitSource('::1')).toBe('::1')
    expect(limitSource(undefined)).toBe('-')
    expect(limitSource('')).toBe('-')
  })
})
