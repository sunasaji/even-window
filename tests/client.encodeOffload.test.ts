// even-window — the encode worker's fallback. Pure: the port is injected, so there is no real
// `Worker` here.
//
// The worker is an optimisation; the tile reaching the glasses is not. Every failure mode below
// must still produce bytes (src/client/encodeOffload.ts): no `Worker` constructor, a chunk that
// 404s, a worker that throws on real input, and a worker that never answers.

import { describe, expect, it, vi } from 'vitest'
import {
  EncodeOffload,
  OFFLOAD_TIMEOUT_MS,
  type OffloadReply,
  type OffloadRequest,
  type PortEvents,
} from '../src/client/encodeOffload.ts'

const IDX = new Uint8Array([1, 2, 3, 4])
const FROM_WORKER = new Uint8Array([0xaa])
const FROM_MAIN = new Uint8Array([0xbb])

/** A port that records what it was sent and lets a test answer by hand. */
function harness(options: { openThrows?: boolean } = {}) {
  const sent: OffloadRequest[] = []
  const log: string[] = []
  let events: PortEvents | null = null
  let closed = 0
  const timers: { fn: () => void; ms: number }[] = []
  const offload = new EncodeOffload({
    openPort: e => {
      if (options.openThrows) throw new Error('Worker is not defined')
      events = e
      return {
        post: m => {
          sent.push(m)
        },
        close: () => {
          closed++
        },
      }
    },
    fallback: async () => FROM_MAIN,
    log: line => log.push(line),
    setTimer: (fn, ms) => {
      timers.push({ fn, ms })
      return timers.length - 1
    },
    clearTimer: () => {},
  })
  return {
    offload,
    sent,
    log,
    timers,
    get closed() {
      return closed
    },
    reply: (msg: OffloadReply) => events!.reply(msg),
    broke: (reason: string) => events!.broke(reason),
    fireTimer: (i = 0) => timers[i]!.fn(),
  }
}

describe('EncodeOffload — the happy path', () => {
  it('starts unstarted, opens on first use, and returns what the worker produced', async () => {
    const h = harness()
    expect(h.offload.mode).toBe('unstarted')
    const p = h.offload.run(IDX)
    expect(h.offload.mode).toBe('worker')
    expect(h.sent).toEqual([{ id: 1, idx: IDX }])
    h.reply({ id: 1, idat: FROM_WORKER })
    expect(await p).toBe(FROM_WORKER)
    expect(h.log).toHaveLength(1)
    expect(h.log[0]).toContain('worker')
  })

  it('does not transfer the index plane — the pump reuses that buffer', async () => {
    // A transfer would detach it, and the next derive would write into a dead buffer. The test is
    // that the same object is posted and is still readable afterwards.
    const h = harness()
    const p = h.offload.run(IDX)
    expect(h.sent[0]!.idx).toBe(IDX)
    h.reply({ id: 1, idat: FROM_WORKER })
    await p
    expect(Array.from(IDX)).toEqual([1, 2, 3, 4])
  })

  it('gives every request its own id, so a reply cannot settle the wrong tile', async () => {
    const h = harness()
    const a = h.offload.run(IDX)
    const b = h.offload.run(IDX)
    expect(h.sent.map(s => s.id)).toEqual([1, 2])
    const second = new Uint8Array([0xcc])
    h.reply({ id: 2, idat: second })
    h.reply({ id: 1, idat: FROM_WORKER })
    expect(await a).toBe(FROM_WORKER)
    expect(await b).toBe(second)
  })

  it('ignores a reply for an id it is not waiting for', async () => {
    const h = harness()
    const p = h.offload.run(IDX)
    expect(() => h.reply({ id: 999, idat: FROM_WORKER })).not.toThrow()
    h.reply({ id: 1, idat: FROM_WORKER })
    expect(await p).toBe(FROM_WORKER)
    expect(h.offload.mode).toBe('worker') // a stray reply is not a fault
  })

  it('arms the timeout at the documented value', () => {
    const h = harness()
    void h.offload.run(IDX)
    expect(h.timers[0]!.ms).toBe(OFFLOAD_TIMEOUT_MS)
  })
})

describe('EncodeOffload — every failure still produces bytes', () => {
  it('falls back when there is no Worker constructor at all', async () => {
    const h = harness({ openThrows: true })
    expect(await h.offload.run(IDX)).toBe(FROM_MAIN)
    expect(h.offload.mode).toBe('main')
    expect(h.log[0]).toContain('Worker is not defined')
  })

  it('rescues the in-flight tile when the port breaks under it', async () => {
    // This is the load-failure shape: posted, then `onerror`. The tile must not be lost.
    const h = harness()
    const p = h.offload.run(IDX)
    h.broke('onerror: load failed')
    expect(await p).toBe(FROM_MAIN)
    expect(h.offload.mode).toBe('main')
    expect(h.closed).toBe(1)
  })

  it('rescues every in-flight tile, not just the first', async () => {
    const h = harness()
    const a = h.offload.run(IDX)
    const b = h.offload.run(IDX)
    const c = h.offload.run(IDX)
    h.broke('onerror')
    expect(await Promise.all([a, b, c])).toEqual([FROM_MAIN, FROM_MAIN, FROM_MAIN])
  })

  it('treats a worker that reports an error as permanently untrustworthy, and still answers', async () => {
    const h = harness()
    const p = h.offload.run(IDX)
    h.reply({ id: 1, error: 'boom' })
    expect(await p).toBe(FROM_MAIN)
    expect(h.offload.mode).toBe('main')
    expect(h.log.at(-1)).toContain('boom')
  })

  it('treats an empty reply as an error rather than resolving with nothing', async () => {
    const h = harness()
    const p = h.offload.run(IDX)
    h.reply({ id: 1 }) // no idat, no error — a malformed worker
    expect(await p).toBe(FROM_MAIN)
    expect(h.offload.mode).toBe('main')
  })

  it('falls back when the worker never answers', async () => {
    const h = harness()
    const p = h.offload.run(IDX)
    h.fireTimer()
    expect(await p).toBe(FROM_MAIN)
    expect(h.offload.mode).toBe('main')
    expect(h.log.at(-1)).toContain(`${OFFLOAD_TIMEOUT_MS}ms`)
  })

  it('never retries the worker after giving up — the timeout must be paid once, not per tile', async () => {
    const h = harness()
    const first = h.offload.run(IDX)
    h.broke('onerror')
    await first
    const posted = h.sent.length
    expect(await h.offload.run(IDX)).toBe(FROM_MAIN)
    expect(await h.offload.run(IDX)).toBe(FROM_MAIN)
    expect(h.sent.length).toBe(posted) // nothing more was handed to the dead port
    expect(h.timers.length).toBe(1) // and no further timeouts were armed
  })

  it('announces the switch exactly once, however many tiles are caught by it', async () => {
    const h = harness()
    const a = h.offload.run(IDX)
    const b = h.offload.run(IDX)
    h.broke('first')
    h.broke('second') // a late onerror after terminate()
    await Promise.all([a, b])
    await h.offload.run(IDX)
    const switches = h.log.filter(l => l.includes('back on the main thread'))
    expect(switches).toHaveLength(1)
    expect(switches[0]).toContain('first')
  })

  it('propagates a fallback failure rather than hanging the pump', async () => {
    // If the in-process path throws too there is nothing left to do, and the pump has a
    // `catch` that marks the tile failed and moves on. Hanging would stall the drain.
    const boom = new Error('deflate unavailable')
    const offload = new EncodeOffload({
      openPort: () => {
        throw new Error('no Worker')
      },
      fallback: () => Promise.reject(boom),
      log: () => {},
    })
    await expect(offload.run(IDX)).rejects.toBe(boom)
  })

  it('uses real timers by default, so the production path needs no injection', () => {
    // The defaults are exercised nowhere else in this file; a typo in them would only show up on
    // hardware, as a pump that stops after one bad tile.
    vi.useFakeTimers()
    try {
      const log: string[] = []
      const offload = new EncodeOffload({
        openPort: () => ({ post: () => {}, close: () => {} }),
        fallback: async () => FROM_MAIN,
        log: line => log.push(line),
        timeoutMs: 50,
      })
      const p = offload.run(IDX)
      vi.advanceTimersByTime(60)
      expect(offload.mode).toBe('main')
      return expect(p).resolves.toBe(FROM_MAIN)
    } finally {
      vi.useRealTimers()
    }
  })
})
