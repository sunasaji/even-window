// even-window — the index→grey lookup (src/client/grey.ts: levelOf / greyOf / GREY_LUT).
//
// The scheme claims to be exact, not a quantisation: palette channel values get a code, the
// 15-bit key is injective over the 16 palette colours, and anything else lands on a sentinel
// and takes the luminance fallback. These cases check that claim against an independent
// reference implementation.
//
// The palette and ramp are restated here so the reference is independent of the code under
// test. If GREY_RAMP or X11_ANSI is edited in the source, these fail and should.

import { describe, expect, it } from 'vitest'
import { greyOf, LEVEL_BY_ANSI, LEVEL_STEP, levelOf, RAMP_GREYS } from '../src/client/grey.ts'
import { clientSource } from './helpers/source.ts'

/** src/client/grey.ts X11_ANSI */
const PALETTE: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0],
  [205, 0, 0],
  [0, 205, 0],
  [205, 205, 0],
  [0, 0, 238],
  [205, 0, 205],
  [0, 205, 205],
  [229, 229, 229],
  [127, 127, 127],
  [255, 0, 0],
  [0, 255, 0],
  [255, 255, 0],
  [92, 92, 255],
  [255, 0, 255],
  [0, 255, 255],
  [255, 255, 255],
]
/** src/client/grey.ts GREY_RAMP */
const RAMP: readonly number[] = [0, 2, 7, 12, 1, 4, 9, 14, 8, 3, 10, 13, 6, 5, 11, 15]

/** The reference: a Map on the packed 24-bit RGB, with a luminance fallback, and the polarity
 *  flip applied last. */
const refMap = new Map<number, number>()
PALETTE.forEach((rgb, i) => {
  const lvl = Math.max(0, Math.min(15, RAMP[i] ?? 15))
  refMap.set((rgb[0] << 16) | (rgb[1] << 8) | rgb[2], Math.round((lvl / 15) * 255))
})
function greyRef(r: number, g: number, b: number, inverted = false): number {
  const m = refMap.get((r << 16) | (g << 8) | b)
  const v = m !== undefined ? m : Math.round(0.299 * r + 0.587 * g + 0.114 * b)
  return inverted ? 255 - v : v
}

describe('greyOf / levelOf — palette colours are exact, off-palette pixels snap to the ramp', () => {
  // The tile ships as a colour-type 3 PNG whose palette is exactly the sixteen ramp levels, so
  // every pixel is a palette entry: a 0..255 value that is not a multiple of 17 cannot be
  // expressed, and the off-palette luminance fallback is quantised. Palette colours are exact.

  it('matches the reference on every palette colour, both polarities', () => {
    for (const [r, g, b] of PALETTE) {
      for (const inv of [false, true]) {
        expect(greyOf(r, g, b, inv)).toBe(greyRef(r, g, b, inv))
      }
    }
  })

  it('snaps an OFF-palette pixel to the ramp instead of passing a value the panel cannot show', () => {
    const off = [
      [17, 23, 29],
      [1, 2, 3],
      [100, 110, 120],
      [200, 10, 60],
    ] as const
    for (const [r, g, b] of off) {
      const v = greyOf(r, g, b)
      expect(v % 17).toBe(0) // on the ramp
      expect(v).toBe(Math.round(greyRef(r, g, b) / 17) * 17) // nearest level to the reference
    }
  })

  it('never produces a value off the ramp, for any input', () => {
    let s = 0x2f6e2b1
    const next = (): number => {
      s = (s * 1103515245 + 12345) & 0x7fffffff
      return (s >> 7) & 0xff
    }
    for (let k = 0; k < 20000; k++) {
      const v = greyOf(next(), next(), next())
      expect(v % 17).toBe(0)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(255)
    }
  })

  it('levelOf is the primary rule and greyOf is exactly 17x it', () => {
    let s = 0x51f3c7
    const next = (): number => {
      s = (s * 1103515245 + 12345) & 0x7fffffff
      return (s >> 7) & 0xff
    }
    for (let k = 0; k < 5000; k++) {
      const r = next(),
        g = next(),
        b = next()
      for (const inv of [false, true]) {
        const lvl = levelOf(r, g, b, inv)
        expect(lvl).toBeGreaterThanOrEqual(0)
        expect(lvl).toBeLessThanOrEqual(15)
        expect(greyOf(r, g, b, inv)).toBe(lvl * LEVEL_STEP)
      }
    }
  })

  it('inverts by flipping the level, so the palette can stay constant', () => {
    // The PLTE is handed to the firmware unchanged on every push; polarity moves the index.
    for (const [r, g, b] of [...PALETTE, [17, 23, 29] as const]) {
      expect(levelOf(r, g, b, true)).toBe(15 - levelOf(r, g, b, false))
    }
  })

  it('matches the reference on the grey diagonal where the diagonal is on the ramp', () => {
    for (let lvl = 0; lvl <= 15; lvl++) {
      const v = lvl * LEVEL_STEP
      expect(greyOf(v, v, v)).toBe(Math.round(greyRef(v, v, v) / 17) * 17)
    }
  })
})

describe('RAMP_GREYS — the palette the glasses are handed', () => {
  it('is the sixteen ramp levels, evenly spaced, black to white', () => {
    expect(RAMP_GREYS).toHaveLength(16)
    expect(RAMP_GREYS[0]).toBe(0)
    expect(RAMP_GREYS[15]).toBe(255)
    for (let i = 1; i < 16; i++) expect(RAMP_GREYS[i]! - RAMP_GREYS[i - 1]!).toBe(LEVEL_STEP)
  })

  it('agrees with greyOf on every palette colour, which is what makes the index meaningful', () => {
    for (const [r, g, b] of PALETTE) {
      expect(RAMP_GREYS[levelOf(r, g, b)]).toBe(greyOf(r, g, b))
    }
  })
})

describe('the LUT scheme itself', () => {
  it('maps the 16 palette colours onto 16 distinct levels, so none is silently merged', () => {
    const levels = PALETTE.map(([r, g, b]) => greyOf(r, g, b))
    expect(new Set(levels).size).toBe(16)
  })

  it('leaves room in the code field — the shift cannot overflow for this palette', () => {
    // The key packs three channel codes 5 bits apart. Codes are assigned 1.. per distinct
    // channel value, so the invariant is "distinct channel values < 31". Today it is 7.
    const distinct = new Set(PALETTE.flat())
    expect(distinct.size).toBeLessThan(31)
    expect([...distinct].sort((a, b) => a - b)).toEqual([0, 92, 127, 205, 229, 238, 255])
  })
})

// ── the sixteen-entry table the derive reads ──────────────────────────────────────────────
//
// The tile arrives as ANSI palette indices, so the derive is a sixteen-entry read. The table
// is built from `levelOf`, so agreement is by construction and checkable at runtime.

describe('LEVEL_BY_ANSI — the table the derive actually reads', () => {
  it('agrees with levelOf on all sixteen entries, both polarities', () => {
    for (let i = 0; i < 16; i++) {
      const c = PALETTE[i]!
      expect(LEVEL_BY_ANSI[0]![i]).toBe(levelOf(c[0], c[1], c[2], false))
      expect(LEVEL_BY_ANSI[1]![i]).toBe(levelOf(c[0], c[1], c[2], true))
    }
  })

  it('is the ramp, and its inverse', () => {
    expect([...LEVEL_BY_ANSI[0]!]).toEqual(RAMP.map(v => Math.max(0, Math.min(15, v))))
    for (let i = 0; i < 16; i++) expect(LEVEL_BY_ANSI[1]![i]).toBe(15 - LEVEL_BY_ANSI[0]![i]!)
  })

  it('covers every index an indexed PNG can carry', () => {
    for (const t of LEVEL_BY_ANSI) {
      expect(t).toHaveLength(16)
      for (const v of t) {
        expect(v).toBeGreaterThanOrEqual(0)
        expect(v).toBeLessThanOrEqual(15)
      }
    }
  })
})

describe('the shape of the arrival and the derive', () => {
  const src = clientSource()
  const arrival = src.fn('processTile')
  const body = src.fn('deriveGrey')

  it('the arrival touches no canvas, Image or Blob', () => {
    // A canvas round trip would expand indices to RGBA only for the push path to turn them
    // back.
    for (const gone of ['getImageData', 'drawImage', 'createObjectURL', 'new Image', 'tileCtx']) {
      expect(arrival.has(gone), gone).toBe(false)
    }
    expect(arrival.has('indexPlaneFromPng')).toBe(true)
  })

  it('and the decode canvas is gone from the module entirely', () => {
    expect(src.has('function tileCtx')).toBe(false)
  })

  it('the derive is a table read, not a per-pixel rule', () => {
    expect(body.has('LEVEL_BY_ANSI[invert ? 1 : 0]')).toBe(true)
    expect(body.has('map[ansi[q]! & 15]')).toBe(true)
    expect(body.has('0.299')).toBe(false) // no luminance fallback: every pixel is an index
    expect(body.has('GREY_LUT')).toBe(false)
  })

  it('fills the green plane only in green mode, with one store per pixel', () => {
    const loop = body.between('for (let q = 0', 'if (statsOn) sample')
    expect(loop.has('if (green) mirrorU32[q]')).toBe(true)
    const colour = src.fn('drawMirrorColour')
    expect(colour.has('mirrorU32[q] = ANSI_U32')).toBe(true)
  })

  it('runs the loop at dequeue, not on arrival', () => {
    expect(arrival.has('deriveGrey(')).toBe(false)
    expect(arrival.has('publishTile(i)')).toBe(true)
    const pump = src.fn('pumpTiles')
    expect(pump.indexOf('deriveGrey(i)')).toBeGreaterThan(-1)
    expect(pump.indexOf('await encodeTilePng')).toBeGreaterThan(pump.indexOf('deriveGrey(i)'))
  })

  it('drops an inflate that finished after a newer frame for the same quadrant', () => {
    // The inflate is async, so two arrivals for one quadrant can complete out of order; a late
    // one must not overwrite a newer plane.
    const iSeq = arrival.indexOf('const seq = ++tileSeq[i]')
    const iAwait = arrival.indexOf('await indexPlaneFromPng')
    const iGuard = arrival.indexOf('if (seq !== tileSeq[i]) return')
    expect(iSeq).toBeGreaterThan(-1)
    expect(iAwait).toBeGreaterThan(iSeq) // stamped before the await
    expect(iGuard).toBeGreaterThan(iAwait) // checked after it
    expect(arrival.indexOf('tileAnsi[i] = ansi')).toBeGreaterThan(iGuard)
  })

  it('repaints the colour mirror when the cursor moves, without waiting for a tile', () => {
    // vPad is steered by watching the mirror; on a still screen no tile arrives.
    const cur = src.fn('refreshCursorTiles')
    expect(cur.has('drawMirrorColour(q)')).toBe(true)
    expect(cur.has('publishTile(q)')).toBe(true)
  })
})
