// pinhole-window — invert (polarity), the client-side grey-derivation flip.
//
// The glasses are an optical see-through panel: black emits nothing and is transparent, bright
// emits. The flip lives in the index→grey stage: one arithmetic op, no re-encode, and the
// capture and tile diff are untouched.

import { describe, expect, it } from 'vitest'
import { parseInvert } from '../src/client/flags.ts'
import { greyOf } from '../src/client/grey.ts'
import { applyOverlayTransition, type PlaneOps } from '../src/client/overlay.ts'
import { clientSource } from './helpers/source.ts'

// The ANSI palette entries the ramp is defined on (src/client/grey.ts X11_ANSI).
const BLACK = [0, 0, 0] as const
const WHITE = [255, 255, 255] as const
const RED = [205, 0, 0] as const
const OFF_PALETTE = [17, 23, 29] as const // nothing an indexed PNG should produce

describe('greyOf — the ramp, then the flip', () => {
  it('black is dark and white is lit when invert is off (the see-through default)', () => {
    expect(greyOf(...BLACK, false)).toBe(0)
    expect(greyOf(...WHITE, false)).toBe(255)
  })

  it('black becomes lit and white becomes dark when invert is on', () => {
    expect(greyOf(...BLACK, true)).toBe(255)
    expect(greyOf(...WHITE, true)).toBe(0)
  })

  it('is exactly 255 - level for every palette entry, including the off-palette fallback', () => {
    for (const [r, g, b] of [BLACK, WHITE, RED, OFF_PALETTE]) {
      expect(greyOf(r, g, b, true)).toBe(255 - greyOf(r, g, b, false))
    }
  })

  it('is its own inverse: flipping twice is identity', () => {
    for (const [r, g, b] of [BLACK, WHITE, RED, OFF_PALETTE]) {
      const v = greyOf(r, g, b, false)
      expect(255 - (255 - v)).toBe(v)
    }
  })

  it('defaults to not inverted, so an un-passed flag can never silently light the lens', () => {
    expect(greyOf(...WHITE)).toBe(greyOf(...WHITE, false))
    expect(greyOf(...BLACK)).toBe(0)
  })

  it('stays in 0..255 (what gets packed into the pushed grey tile)', () => {
    for (const [r, g, b] of [BLACK, WHITE, RED, OFF_PALETTE]) {
      for (const inv of [false, true]) {
        const v = greyOf(r, g, b, inv)
        expect(v).toBeGreaterThanOrEqual(0)
        expect(v).toBeLessThanOrEqual(255)
      }
    }
  })
})

describe('parseInvert — ?invert=1 → localStorage → default off', () => {
  it('treats the usual truthy spellings as on', () => {
    for (const s of ['1', 'true', 'on', 'yes', 'TRUE', ' On ']) expect(parseInvert(s)).toBe(true)
  })

  it('treats the usual falsy spellings as off', () => {
    for (const s of ['0', 'false', 'off', 'no', 'OFF']) expect(parseInvert(s)).toBe(false)
  })

  it('reads a bare `?invert` (empty value) as on: presence is the flag', () => {
    expect(parseInvert('')).toBe(true)
  })

  it('returns null for absent or unparseable values, so the next source decides', () => {
    expect(parseInvert(null)).toBeNull()
    expect(parseInvert(undefined)).toBeNull()
    expect(parseInvert('maybe')).toBeNull()
    expect(parseInvert('2')).toBeNull()
  })

  it('null from the query falls through to storage, and null from both means off', () => {
    // The resolution the client performs, spelled out so the default is pinned.
    const resolve = (q: string | null, ls: string | null): boolean =>
      parseInvert(q) ?? parseInvert(ls) ?? false
    expect(resolve('1', null)).toBe(true)
    expect(resolve(null, '1')).toBe(true)
    expect(resolve('0', '1')).toBe(false) // the query wins over storage
    expect(resolve(null, null)).toBe(false) // default off
    expect(resolve('nonsense', '1')).toBe(true)
  })
})

describe('a flip must get the glass consistent again', () => {
  // Everything already on the glass was derived with the old polarity, so an unchanged
  // quadrant diffs byte-equal against lastTiles and would never re-send. The flip reuses the
  // overlay transition (syncOverlay → applyOverlayTransition(' ', planeOps)); this pins the
  // ordering that depends on.
  function recorder() {
    const calls: string[] = []
    const ops: PlaneOps = {
      standDown: async () => {
        calls.push('standDown')
      },
      blankTiles: async () => {
        calls.push('blankTiles')
      },
      writeOverlay: async c => {
        calls.push(`writeOverlay:${c === ' ' ? 'blank' : 'text'}`)
      },
      resetBaseline: () => {
        calls.push('resetBaseline')
      },
      repaintTiles: () => {
        calls.push('repaintTiles')
      },
    }
    return { calls, ops }
  }

  it('resets the diff baseline and repaints all four tiles, in that order', async () => {
    const { calls, ops } = recorder()
    await applyOverlayTransition(' ', ops) // the transition a flip re-states with no menu up
    expect(calls).toEqual(['standDown', 'writeOverlay:blank', 'resetBaseline', 'repaintTiles'])
    expect(calls.indexOf('resetBaseline')).toBeLessThan(calls.indexOf('repaintTiles'))
    // A flip with no overlay up is a hide, so it must not blank the tiles it is about to
    // repaint.
    expect(calls).not.toContain('blankTiles')
  })

  it('exactly one rebuild call site, and the flip is not a caller (docs/glasses.md)', () => {
    //   * there is exactly one `bridge.rebuildPageContainer(` in the client (`rebuildPage`);
    //   * its only callers are `establishPage` (the mandatory follow-up) and the retry for a
    //     page that never established at all;
    //   * the invert flip is not among them.
    const src = clientSource()
    expect(src.count('bridge.rebuildPageContainer(')).toBe(1)
    // The definition + its two callers, each named below so a third has to come through this
    // test.
    expect(src.count('rebuildPage(')).toBeLessThanOrEqual(3)
    expect(src.has("const rb = await rebuildPage('establish')")).toBe(true)
    // The retry for a page that never established (glasses absent at load). It only runs while
    // `established` is false, when there is no stream to disturb, and stops when it succeeds.
    expect(src.has("const rb = await rebuildPage('re-establish')")).toBe(true)
    expect(src.has('if (established || !sdk || !bridge) return')).toBe(true)
    // `established` is assigned in exactly one place. If it were set before the create, a page
    // that failed to establish would claim it had, and `establishPage` refuses re-entry on that
    // flag.
    expect(src.count('established = true')).toBe(1)
    // No menu-register scheduler and no `menuObject`: the app registers no items in the
    // firmware's menu (docs/glasses.md). Asserted as constructs, not as words.
    expect(src.has('function scheduleMenuRegister')).toBe(false)
    expect(src.has('menuObject:')).toBe(false)
    // Neither the frame pump nor the flip may reach a rebuild.
    expect(src.fn('pumpTiles').has('rebuildPage')).toBe(false)
    expect(src.fn('setInvert').has('rebuildPage')).toBe(false)
  })

  it('the flip goes through syncOverlay (the serialised pump-aware path), not a raw push', () => {
    const src = clientSource()
    const body = src.fn('setInvert')
    expect(body.has('refreshGrey()')).toBe(true) // re-derive the cached tiles with new polarity
    expect(body.has('syncOverlay()')).toBe(true) // → resetBaseline → repaintTiles, serialised
    expect(body.has('updateImageRawData')).toBe(false)
    expect(body.has('pushImage')).toBe(false)
  })
})
