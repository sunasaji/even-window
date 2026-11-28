// pinhole-window — the client's own log: the on-screen buffer's stamp format, and the throttle
// that lets it be forwarded to the server without becoming a tile-rate firehose.
//
// The frame pump logs one line per tile push at the capture rate, so "POST each line as it
// happens" would be ~40 requests a second from a phone. The forwarder guarantees four
// properties, each tested below:
//
//   1. lines are batched — many lines, one request;
//   2. at most one request is in flight, so a slow server cannot be stampeded;
//   3. requests are spaced by at least LOG_FLUSH_MS;
//   4. the queue is bounded, and an overflow is reported rather than silent.

import { describe, expect, it } from 'vitest'
import {
  LOG_BATCH_MAX,
  LOG_BUFFER_MAX,
  LOG_FLUSH_MS,
  LOG_QUEUE_MAX,
  LogForwarder,
  type LogLine,
  logStamp,
} from '../src/client/debugLog.ts'
import type { NavClock } from '../src/client/navDebounce.ts'
import { clientSource } from './helpers/source.ts'

/** A hand-rolled clock, so the spacing is asserted in virtual time and the test stays fast and
 *  deterministic. Same shape as the NavDebouncer's injected clock. */
class FakeClock implements NavClock {
  t = 1_000_000
  private seq = 0
  private timers = new Map<number, { at: number; fn: () => void }>()

  now(): number {
    return this.t
  }
  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.seq
    this.timers.set(id, { at: this.t + ms, fn })
    return id
  }
  clearTimeout(h: unknown): void {
    this.timers.delete(h as number)
  }

  /** Advance virtual time and run everything that came due, in order. */
  advance(ms: number): void {
    this.t += ms
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, v]) => v.at <= this.t)
        .sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) return
      this.timers.delete(due[0])
      due[1].fn()
    }
  }
}

/** Let queued microtasks (the forwarder's own `await post(...)`) run to completion. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

function line(n: number): LogLine {
  return { t: 1_000_000 + n, m: `line ${n}` }
}

/** A forwarder plus a record of every batch it sent. `hold` makes a request hang so "one in
 *  flight" is observable. */
function harness(opts: { hold?: boolean; fail?: boolean } = {}) {
  const clock = new FakeClock()
  const batches: LogLine[][] = []
  let release: (() => void) | null = null
  const fwd = new LogForwarder(async lines => {
    batches.push(lines)
    if (opts.fail) throw new Error('network down')
    if (opts.hold)
      await new Promise<void>(res => {
        release = res
      })
  }, clock)
  return {
    clock,
    batches,
    fwd,
    release: (): void => {
      release?.()
      release = null
    },
  }
}

describe('logStamp — every line is ordered and gapped, not just listed', () => {
  it('is HH:MM:SS.mmm, zero-padded', () => {
    const d = new Date(2026, 9, 10, 4, 5, 6, 7)
    expect(logStamp(d.getTime())).toBe('04:05:06.007')
  })

  it('pads milliseconds to three digits so columns line up when pasted into a report', () => {
    const base = new Date(2026, 9, 10, 13, 30, 0, 0).getTime()
    expect(logStamp(base + 12)).toBe('13:30:00.012')
    expect(logStamp(base + 123)).toBe('13:30:00.123')
  })
})

describe('LogForwarder — batching', () => {
  it('sends nothing until the flush window elapses', async () => {
    const { clock, batches, fwd } = harness()
    fwd.push(line(1))
    fwd.push(line(2))
    await settle()
    expect(batches).toEqual([])
    clock.advance(LOG_FLUSH_MS)
    await settle()
    expect(batches).toHaveLength(1)
    expect(batches[0]?.map(l => l.m)).toEqual(['line 1', 'line 2'])
  })

  it('collapses many lines into one request — the whole point', async () => {
    const { clock, batches, fwd } = harness()
    for (let i = 0; i < LOG_BATCH_MAX; i++) fwd.push(line(i))
    clock.advance(LOG_FLUSH_MS)
    await settle()
    expect(batches).toHaveLength(1)
    expect(batches[0]).toHaveLength(LOG_BATCH_MAX)
  })

  it('caps one request at LOG_BATCH_MAX and carries the remainder in the next one', async () => {
    const { clock, batches, fwd } = harness()
    for (let i = 0; i < LOG_BATCH_MAX + 5; i++) fwd.push(line(i))
    clock.advance(LOG_FLUSH_MS)
    await settle()
    expect(batches).toHaveLength(1)
    expect(batches[0]).toHaveLength(LOG_BATCH_MAX)
    expect(fwd.pending()).toBe(5)
    clock.advance(LOG_FLUSH_MS)
    await settle()
    expect(batches).toHaveLength(2)
    expect(batches[1]).toHaveLength(5)
  })

  it('does not re-send: a flushed line is gone from the queue', async () => {
    const { clock, batches, fwd } = harness()
    fwd.push(line(1))
    clock.advance(LOG_FLUSH_MS)
    await settle()
    clock.advance(LOG_FLUSH_MS * 4)
    await settle()
    expect(batches).toHaveLength(1)
  })
})

describe('LogForwarder — at most one request in flight', () => {
  it('queues instead of stampeding a slow server', async () => {
    const { clock, batches, fwd, release } = harness({ hold: true })
    fwd.push(line(1))
    clock.advance(LOG_FLUSH_MS)
    await settle()
    expect(batches).toHaveLength(1) // in flight, unresolved

    for (let i = 2; i < 10; i++) fwd.push(line(i))
    clock.advance(LOG_FLUSH_MS * 5)
    await settle()
    // Still exactly one: nothing may start while the first has not answered.
    expect(batches).toHaveLength(1)
    expect(fwd.pending()).toBe(8)

    release()
    await settle()
    clock.advance(LOG_FLUSH_MS)
    await settle()
    expect(batches).toHaveLength(2)
    expect(batches[1]).toHaveLength(8)
  })
})

describe('LogForwarder — a tile-rate stream cannot become a request-rate stream', () => {
  it('turns 10 seconds of 40 lines/s into a handful of requests, not hundreds', async () => {
    const { clock, batches, fwd } = harness()
    // 10fps capture x 4 tiles = 40 lines/s, which is the realistic worst case.
    for (let tick = 0; tick < 100; tick++) {
      for (let i = 0; i < 4; i++) fwd.push(line(tick * 4 + i))
      clock.advance(100)
      await settle()
    }
    // One request per flush window at most: 10s / 700ms ≈ 15, and never one per line.
    expect(batches.length).toBeLessThanOrEqual(Math.ceil(10_000 / LOG_FLUSH_MS) + 1)
    expect(batches.length).toBeGreaterThan(0)
    for (const b of batches) expect(b.length).toBeLessThanOrEqual(LOG_BATCH_MAX + 1)
  })
})

describe('LogForwarder — a bounded queue that admits what it dropped', () => {
  it('drops the oldest past LOG_QUEUE_MAX and reports the count in the next batch', async () => {
    const { clock, batches, fwd, release } = harness({ hold: true })
    // Park a request in flight so the queue genuinely backs up.
    fwd.push(line(0))
    clock.advance(LOG_FLUSH_MS)
    await settle()
    expect(batches).toHaveLength(1)

    for (let i = 1; i <= LOG_QUEUE_MAX + 7; i++) fwd.push(line(i))
    expect(fwd.pending()).toBe(LOG_QUEUE_MAX)
    expect(fwd.droppedCount()).toBe(7)

    release()
    await settle()
    clock.advance(LOG_FLUSH_MS)
    await settle()
    const second = batches[1] ?? []
    // The marker is prepended, so the gap is visible exactly where it happened.
    expect(second[0]?.m).toContain('7 line(s) DROPPED')
    // …and the oldest survivors follow it — the newest lines are the ones kept.
    expect(second[1]?.m).toBe('line 8')
    expect(fwd.droppedCount()).toBe(0)
  })
})

describe('LogForwarder — instrumentation may never break the thing it instruments', () => {
  it('swallows a failed request and keeps forwarding afterwards', async () => {
    const clock = new FakeClock()
    const batches: LogLine[][] = []
    let failNext = true
    const fwd = new LogForwarder(async lines => {
      batches.push(lines)
      if (failNext) {
        failNext = false
        throw new Error('network down')
      }
    }, clock)

    fwd.push(line(1))
    clock.advance(LOG_FLUSH_MS)
    await settle()
    expect(batches).toHaveLength(1) // sent, and rejected

    // A rejection must not wedge `inFlight`, or the log would go permanently silent after the
    // first dropped packet.
    fwd.push(line(2))
    clock.advance(LOG_FLUSH_MS)
    await settle()
    expect(batches).toHaveLength(2)
    expect(batches[1]?.map(l => l.m)).toEqual(['line 2'])
  })

  it('a failing transport does not leave an unhandled rejection or a stuck queue', async () => {
    const { clock, batches, fwd } = harness({ fail: true })
    for (let i = 0; i < 3; i++) {
      fwd.push(line(i))
      clock.advance(LOG_FLUSH_MS)
      await settle()
    }
    expect(batches).toHaveLength(3)
    expect(fwd.pending()).toBe(0)
  })
})

describe('the wiring, scanned from source', () => {
  const src = clientSource()

  it('forwards through authFetch, not apiPost — apiPost logs on failure and would recurse', () => {
    // `apiPost` ends its catch with `log(...)`. If the forwarder used it, a failed flush would
    // append a line to the very queue being flushed. Comments are stripped first: the one
    // above the call names apiPost to say why it is not used.
    const code = src.fn('logForwarder').code()
    expect(code.has("authFetch('/api/debug/log'")).toBe(true)
    expect(code.has('apiPost')).toBe(false)
  })

  it('only forwards when ?debug=1 — a normal run makes no extra requests at all', () => {
    const body = src.fn('log')
    expect(body.has('function log(line: string)')).toBe(true)
    expect(body.has('if (DEBUG_EVENTS) logForwarder.push(e)')).toBe(true)
  })

  it('keeps one logger: nothing in the client writes a log line except log()', () => {
    // A second sink would diverge from the panel the moment anyone used it.
    expect(src.count('logForwarder.push(')).toBe(1)
  })

  it('bounds the on-screen buffer as well as the forward queue', () => {
    expect(LOG_BUFFER_MAX).toBeGreaterThan(LOG_BATCH_MAX)
    expect(src.has('if (logLines.length > LOG_BUFFER_MAX) logLines.shift()')).toBe(true)
  })
})
