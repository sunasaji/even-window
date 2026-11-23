// even-window — the capture-side frame diff (tiles.ts processFrame).
//
// Two diffs sit in front of the BLE link:
//
//   1. the whole-frame short-circuit — one memcmp over the rgb24 frame, so a static screen is
//      never quantised;
//   2. the per-tile diff — `lastTileRaw[t].equals(tile)`, so a change in the left half pushes
//      TL and BL and nothing else.
//
// (1) is pure work avoidance: it may never change which `tile` events come out.
//
// The cases are ordered on purpose: `lastTileRaw` / `prevFrame` are module-level with no
// reset hook (a reattach keeps priming from the previous capture's tiles, docs/platform.md),
// so the baseline carries from one case to the next. Vitest gives this file its own module
// instance.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { subscribe } from '../src/server/stream.ts'
import { processFrame } from '../src/server/tiles.ts'
import { FRAME_BYTES, SCREEN_W, TILE_H, TILE_W, tileOrigin } from '../src/shared/geom.ts'
import type { StreamEvent } from '../src/shared/types.ts'

/** Collect the emitted tile indices. Subscribing also primes (avail, windows, retained
 *  tiles), so only `tile` events are kept and the file subscribes once, not per case. */
const emitted: number[] = []
subscribe((ev: StreamEvent) => {
  if (ev.t === 'tile') emitted.push(ev.i)
})
const drain = (): number[] => emitted.splice(0, emitted.length).sort()

/** A black 576x288 rgb24 frame with one white pixel in each quadrant of `lit`. Every frame is
 *  the full screen state, never a delta, as the capture hands it to processFrame. */
function frame(...lit: number[]): Buffer {
  const f = Buffer.alloc(FRAME_BYTES)
  for (const t of lit) {
    const [tx, ty] = tileOrigin(t)
    const o = ((ty + (TILE_H >> 1)) * SCREEN_W + tx + (TILE_W >> 1)) * 3
    f[o] = 255
    f[o + 1] = 255
    f[o + 2] = 255
  }
  return f
}

describe('processFrame — the capture-side diff', () => {
  // The baseline after each case is noted, since the next case diffs against it.

  it('the first frame ever emits all four tiles (there is no baseline to diff against)', () => {
    processFrame(frame())
    expect(drain()).toEqual([0, 1, 2, 3]) // baseline: all blank
  })

  it('an identical frame emits nothing — this is the short-circuit', () => {
    processFrame(frame())
    processFrame(frame())
    expect(drain()).toEqual([]) // baseline: all blank
  })

  it('a changed frame emits only the quadrant that changed', () => {
    processFrame(frame(2))
    expect(drain()).toEqual([2]) // baseline: BL lit
  })

  it('and re-sending that same frame goes quiet again', () => {
    processFrame(frame(2))
    expect(drain()).toEqual([]) // baseline: BL lit
  })

  it('lighting a second quadrant emits that one only — BL is already on the glass', () => {
    processFrame(frame(1, 2))
    expect(drain()).toEqual([1]) // baseline: TR + BL lit
  })

  it('a frame that differs in bytes but not after quantisation emits nothing', () => {
    // The two diffs are not redundant: 16-colour quantisation maps many distinct rgb24 frames
    // onto the same tile. The memcmp lets this frame through; the per-tile diff stops it.
    const f = frame(1, 2)
    f[0] = 3
    f[1] = 3
    f[2] = 3 // near-black, still quantises to ANSI 0
    processFrame(f)
    expect(drain()).toEqual([]) // baseline: TR + BL lit
  })
})

// ── and the structural half ────────────────────────────────────────────────────────────────
// The cases above cannot detect the short-circuit's absence (it is pure work avoidance), so
// the ordering it depends on is pinned by reading the source.

describe('processFrame — the shape of the hot path', () => {
  const body = (() => {
    const src = readFileSync(new URL('../src/server/tiles.ts', import.meta.url), 'utf8')
    return src.slice(src.indexOf('export function processFrame'))
  })()

  it('checks the whole frame before it quantises', () => {
    const iFrame = body.indexOf('prevFrame.equals(frame)')
    const iLut = body.indexOf('indexLut()')
    expect(iFrame).toBeGreaterThan(-1)
    expect(iLut).toBeGreaterThan(iFrame) // the memcmp must come before the 165,888-pixel loop
  })

  it('copies into a preallocated prevFrame rather than retaining the capture buffer', () => {
    // Retaining the capture buffer would pin the chunk behind it, and a copy per frame would
    // be garbage at every tick.
    expect(body).toContain('frame.copy(prevFrame)')
    expect(body).not.toMatch(/prevFrame\s*=/)
  })

  it('still keeps the per-tile diff — the frame check does not replace it', () => {
    expect(body).toContain('prev?.equals(tile)')
  })
})
