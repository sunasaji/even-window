// LatestAsyncWriter: serial per key, latest-wins, no unhandled rejections.

import { describe, expect, it } from 'vitest'
import { LatestAsyncWriter } from '../src/shared/latestAsyncWriter.ts'

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: unknown) => void } {
  let resolve!: () => void
  let reject!: (e: unknown) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('LatestAsyncWriter', () => {
  const tick = () => new Promise<void>(res => setTimeout(res, 0))

  it('an in-flight write is not cancelled, and the latest queued value runs after it', async () => {
    const w = new LatestAsyncWriter<string, number>()
    const applied: number[] = []
    const gate = deferred()

    const p1 = w.write('k', 1, async v => {
      applied.push(v)
      await gate.promise
    })
    await tick() // let write #1 actually start (applies are scheduled on a microtask)
    expect(applied).toEqual([1]) // in flight, blocked on the gate; cannot be cancelled

    const p2 = w.write('k', 2, async v => {
      applied.push(v)
    })
    const p3 = w.write('k', 3, async v => {
      applied.push(v)
    })
    gate.resolve()
    await Promise.all([p1, p2, p3])
    expect(applied).toEqual([1, 3]) // 2 was superseded before it ran → never applied
  })

  it('writes raised in one turn collapse to the last value only', async () => {
    // Nothing has started yet, so every earlier value is stale by the time the queue turns.
    const w = new LatestAsyncWriter<string, number>()
    const applied: number[] = []
    await Promise.all(
      [1, 2, 3, 4, 5].map(v =>
        w.write('k', v, async x => {
          applied.push(x)
        }),
      ),
    )
    expect(applied).toEqual([5])
  })

  it('never runs two applies for one key concurrently', async () => {
    const w = new LatestAsyncWriter<string, number>()
    const applied: number[] = []
    let active = 0
    let maxActive = 0
    const apply = async (v: number) => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise<void>(res => setTimeout(res, 2))
      applied.push(v)
      active--
    }
    // Raised across separate turns so each write really starts before the next is queued.
    const writes: Promise<void>[] = []
    for (const v of [1, 2, 3, 4, 5]) {
      writes.push(w.write('k', v, apply))
      await tick()
    }
    await Promise.all(writes)
    expect(maxActive).toBe(1) // strictly serial
    expect(applied[0]).toBe(1) // the first write was already running
    expect(applied[applied.length - 1]).toBe(5) // the newest value owns the final state
    expect([...applied].sort((a, b) => a - b)).toEqual(applied) // never applied out of order
    // Intermediate values may be coalesced away: a write queued behind an in-flight one is
    // superseded if a newer value arrives before it starts.
    expect(applied.length).toBeLessThanOrEqual(5)
  })

  it('keys are independent', async () => {
    const w = new LatestAsyncWriter<string, number>()
    const applied: string[] = []
    await Promise.all([
      w.write('a', 1, async v => {
        applied.push(`a${v}`)
      }),
      w.write('b', 1, async v => {
        applied.push(`b${v}`)
      }),
    ])
    expect(applied.sort()).toEqual(['a1', 'b1'])
  })

  it('a rejected apply does not break the chain, and the caller can catch it', async () => {
    const w = new LatestAsyncWriter<string, number>()
    const applied: number[] = []
    const failing = w.write('k', 1, async () => {
      throw new Error('boom')
    })
    await expect(failing).rejects.toThrow('boom')
    await w.write('k', 2, async v => {
      applied.push(v)
    })
    expect(applied).toEqual([2])
  })

  it('an unawaited rejected write does not produce an unhandled rejection', async () => {
    // Cleanup must observe both outcomes without creating a second rejected promise.
    const w = new LatestAsyncWriter<string, number>()
    const seen: unknown[] = []
    const onUnhandled = (e: unknown) => {
      seen.push(e)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      void w
        .write('k', 1, async () => {
          throw new Error('dropped')
        })
        .catch(() => {})
      await new Promise<void>(res => setTimeout(res, 20))
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
    expect(seen).toEqual([])
  })
})
