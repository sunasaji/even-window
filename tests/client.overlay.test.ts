// pinhole-window — container allocation, the overlay's push ordering, the `zOrderIndex` plan, and
// the quadrant geometry the synthetic cursor is stamped with (`tileIndexAt` / `cursorTilePixel`,
// at the end: the same 2x2 allocation seen from the other side).
//
// The overlay (container 6) is the only glasses UI: the root list, the menu levels, the voice
// dialog and every notice. It is in front of the tiles because every container carries a
// `zOrderIndex`; without one, images composite above text (docs/glasses.md).
//
// The transition ordering matters for the tile diff baseline, which is what these tests pin. No
// transition reaches `rebuildPageContainer`: show and hide are text and image pushes on the
// page that is already established.

import { describe, expect, it } from 'vitest'
import { applyOverlayTransition, blankTilePlan, type PlaneOps } from '../src/client/overlay.ts'
import { cursorTilePixel } from '../src/client/tiles.ts'
import {
  CONTAINER_TOTAL,
  EVENT_LAYER_ID,
  OVERLAY_LAYER_ID,
  SCREEN_H,
  SCREEN_W,
  TILE_H,
  TILE_W,
  TILES,
  tileContainerId,
  tileIndexAt,
  tileOrigin,
  tileZOrder,
  Z_EVENT_LAYER,
  Z_OVERLAY,
} from '../src/shared/geom.ts'
import { clientSource } from './helpers/source.ts'

/** Let every pending microtask run, so "has the next step started yet?" is a fair question. */
const flush = () =>
  new Promise<void>(res => {
    setTimeout(res, 0)
  })

const MENU = 'Windows\n> xterm\n  firefox'
const BLANK = ' '

function recorder(hooks: Partial<PlaneOps> = {}) {
  const calls: string[] = []
  const ops: PlaneOps = {
    standDown: async () => {
      calls.push('standDown')
      await hooks.standDown?.()
    },
    blankTiles: async () => {
      calls.push('blankTiles')
      await hooks.blankTiles?.()
    },
    writeOverlay: async c => {
      calls.push(`writeOverlay:${c === BLANK ? 'blank' : 'menu'}`)
      await hooks.writeOverlay?.(c)
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

describe('container allocation', () => {
  it('the overlay is its own container, not the input-capture layer', () => {
    // isEventCapture:1 lives on exactly one container, so the display surface must never be
    // the one carrying gesture delivery.
    expect(OVERLAY_LAYER_ID).not.toBe(EVENT_LAYER_ID)
    expect(OVERLAY_LAYER_ID).toBe(6)
    expect(EVENT_LAYER_ID).toBe(1)
  })

  it('the overlay id does not collide with any tile', () => {
    const tileIds = Array.from({ length: TILES }, (_v, i) => tileContainerId(i))
    expect(tileIds).toEqual([2, 3, 4, 5])
    expect(tileIds).not.toContain(OVERLAY_LAYER_ID)
  })

  it('containerTotalNum is 6 and within the SDK limits', () => {
    expect(CONTAINER_TOTAL).toBe(6)
    expect(CONTAINER_TOTAL).toBe(1 + TILES + 1) // input layer + tiles + overlay
    expect(CONTAINER_TOTAL).toBeLessThanOrEqual(12) // SDK: containerTotalNum 1..12
    expect(TILES).toBeLessThanOrEqual(4) // SDK: imageObject max 4
    expect(CONTAINER_TOTAL - TILES).toBeLessThanOrEqual(8) // SDK: textObject max 8
  })
})

describe('applyOverlayTransition — show', () => {
  it('stands the pump down, blanks the tiles, and only then writes the overlay', async () => {
    // Standing the pump down stops new frames but does not darken the panel: the G2 keeps the
    // last frame lit, so without this step menu text lands on a bright frozen frame.
    const { calls, ops } = recorder()
    await applyOverlayTransition(MENU, ops)
    expect(calls).toEqual(['standDown', 'blankTiles', 'writeOverlay:menu'])
  })

  it('blanks after the stand-down — never racing an in-flight frame that would re-light it', async () => {
    let release!: () => void
    const gate = new Promise<void>(res => {
      release = res
    })
    const { calls, ops } = recorder({ standDown: () => gate })

    const txn = applyOverlayTransition(MENU, ops)
    await flush()
    expect(calls).toEqual(['standDown'])
    release()
    await txn
    expect(calls).toEqual(['standDown', 'blankTiles', 'writeOverlay:menu'])
  })

  it('writes the overlay strictly after the blanking lands, never over a drawn menu', async () => {
    let release!: () => void
    const gate = new Promise<void>(res => {
      release = res
    })
    const { calls, ops } = recorder({ blankTiles: () => gate })

    const txn = applyOverlayTransition(MENU, ops)
    await flush()
    // Four black pushes are in flight. Writing the text now would put it under them.
    expect(calls).toEqual(['standDown', 'blankTiles'])
    release()
    await txn
    expect(calls).toEqual(['standDown', 'blankTiles', 'writeOverlay:menu'])
    expect(calls.indexOf('blankTiles')).toBeLessThan(calls.indexOf('writeOverlay:menu'))
  })

  it('never resets the baseline or repaints — a tile must not paint over the menu', async () => {
    const { calls, ops } = recorder()
    await applyOverlayTransition(MENU, ops)
    expect(calls).not.toContain('resetBaseline')
    expect(calls).not.toContain('repaintTiles')
  })

  it('waits for an in-flight tile push: no overlay write until standDown resolves', async () => {
    let release!: () => void
    const gate = new Promise<void>(res => {
      release = res
    })
    const { calls, ops } = recorder({ standDown: () => gate })

    const txn = applyOverlayTransition(MENU, ops)
    await flush()
    expect(calls).toEqual(['standDown']) // blocked on the in-flight BLE push
    release()
    await txn
    expect(calls).toContain('writeOverlay:menu')
  })
})

describe('applyOverlayTransition — hide', () => {
  it('clears the overlay, then resets the baseline, then repaints', async () => {
    const { calls, ops } = recorder()
    await applyOverlayTransition(BLANK, ops)
    expect(calls).toEqual(['standDown', 'writeOverlay:blank', 'resetBaseline', 'repaintTiles'])
  })

  it('repaints strictly after the clear lands, never concurrently with it', async () => {
    let release!: () => void
    const gate = new Promise<void>(res => {
      release = res
    })
    const { calls, ops } = recorder({ writeOverlay: () => gate })

    const txn = applyOverlayTransition(BLANK, ops)
    await flush()
    // The blank push is still in flight — repainting now would race text against images on the
    // same plane, and the tiles could land under a half-cleared menu.
    expect(calls).toEqual(['standDown', 'writeOverlay:blank'])
    release()
    await txn
    expect(calls).toEqual(['standDown', 'writeOverlay:blank', 'resetBaseline', 'repaintTiles'])
  })

  it('resets the baseline before repainting, so byte-identical tiles still re-send', async () => {
    // The overlay text physically overwrote the tiles, so the newest bytes may equal lastTiles
    // yet no longer be on screen. Without the reset first, the diff would push nothing.
    const { calls, ops } = recorder()
    await applyOverlayTransition(BLANK, ops)
    expect(calls.indexOf('resetBaseline')).toBeLessThan(calls.indexOf('repaintTiles'))
  })

  it('stands the pump down before clearing, even on the hide path', async () => {
    const { calls, ops } = recorder()
    await applyOverlayTransition(BLANK, ops)
    expect(calls[0]).toBe('standDown')
  })

  it('does not blank — the whole point of hiding is to get the mirror back', async () => {
    // And it needs no explicit "unblank" either: resetBaseline → repaintTiles re-sends the
    // newest bytes for all four quadrants, which paints the real content over the black.
    const { calls, ops } = recorder()
    await applyOverlayTransition(BLANK, ops)
    expect(calls).not.toContain('blankTiles')
    expect(calls).toEqual(['standDown', 'writeOverlay:blank', 'resetBaseline', 'repaintTiles'])
  })
})

describe('applyOverlayTransition — show/hide is decided by the content alone', () => {
  it('any non-blank content is a show', async () => {
    for (const c of ['X unavailable\nXephyr not found', 'No windows', 'a']) {
      const { calls, ops } = recorder()
      await applyOverlayTransition(c, ops)
      expect(calls).toEqual(['standDown', 'blankTiles', `writeOverlay:menu`])
    }
  })

  it('exactly the established blank content is a hide', async () => {
    const { calls, ops } = recorder()
    await applyOverlayTransition(BLANK, ops)
    expect(calls).toContain('repaintTiles')
  })
})

// ── blanking the tiles under the overlay (docs/decisions/blank-tiles-under-overlay.md) ────
//
// The G2 keeps the last written frame lit, so overlay text over a frozen frame is unreadable
// on an emissive see-through panel. The show transition pushes an all-black constant to the
// four tiles first.

describe('blankTilePlan', () => {
  const BLACK = new Uint8Array([137, 80, 78, 71, 0, 0, 0, 0]) // stands in for the encoded PNG
  const FRAME = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4])
  const none: (Uint8Array | null)[] = [null, null, null, null]

  it('blanks every tile when the glass holds frames (or nothing known)', () => {
    expect(blankTilePlan(none, BLACK, true)).toEqual([0, 1, 2, 3])
    expect(blankTilePlan([FRAME, FRAME, FRAME, FRAME], BLACK, true)).toEqual([0, 1, 2, 3])
  })

  it('pushes nothing when the tiles already hold black — re-opening costs no BLE at all', () => {
    // Every selection move re-runs the show transition (moveMenu → syncOverlay), so without
    // this diff a swipe through a 10-item menu would cost 40 pushes.
    expect(blankTilePlan([BLACK, BLACK, BLACK, BLACK], BLACK, true)).toEqual([])
  })

  it('blanks only the tiles that are not already black', () => {
    expect(blankTilePlan([BLACK, FRAME, BLACK, null], BLACK, true)).toEqual([1, 3])
  })

  it('compares bytes, not identity — a copy of the black tile is still blank', () => {
    expect(blankTilePlan([new Uint8Array(BLACK), BLACK, BLACK, BLACK], BLACK, true)).toEqual([])
  })

  it('is a no-op when the overlay is not in front (the `zOrder` argument is false)', () => {
    // Without a z plan the overlay is invisible under the tiles, so blanking would only produce
    // a black lens with nothing on it. The app always passes `true`; the parameter keeps the
    // dependency explicit.
    expect(blankTilePlan(none, BLACK, false)).toEqual([])
    expect(blankTilePlan([FRAME, FRAME, FRAME, FRAME], BLACK, false)).toEqual([])
  })

  it('covers the full screen — all four quadrants, never a subset of them', () => {
    // Full-screen over partial: the menu spans every quadrant, and a partial blank could not be
    // a pre-encoded constant.
    expect(blankTilePlan(none, BLACK, true)).toHaveLength(TILES)
  })
})

describe('the blanking implementation', () => {
  const src = clientSource()
  const impl = src.fn('blankTilesForOverlay')

  it('is a differential image push, never a page rebuild', () => {
    expect(impl.has('pushImage(')).toBe(true)
    expect(impl.has('rebuildPage')).toBe(false)
    expect(impl.has('createStartUpPageContainer')).toBe(false)
    expect(impl.has('shutDownPageContainer')).toBe(false)
  })

  it('goes through the extracted transition, not an ad-hoc push from the gesture path', () => {
    expect(src.has('blankTiles: () => blankTilesForOverlay()')).toBe(true)
    expect(src.has('await ops.blankTiles()')).toBe(true)
    // One call site for the op, and it is the transition's.
    expect(src.count('blankTilesForOverlay()')).toBe(2) // definition + wiring
    expect(src.count('ops.blankTiles()')).toBe(1)
  })

  it('encodes the black tile once and reuses it', () => {
    expect(src.has('let blackTile: Promise<Uint8Array> | null = null')).toBe(true)
    expect(src.has('if (blackTile) return blackTile')).toBe(true)
    // ...through the same encoder as every other push, so it compares equal to the baseline.
    expect(src.fn('blackTileBytes').has('encodeTilePng(new Uint8Array(TILE_W * TILE_H))')).toBe(
      true,
    )
  })

  it('records a successful blank in the pump baseline, so the diff cannot be fooled', () => {
    expect(impl.has('if (r.ok) lastTiles[i] = black')).toBe(true)
  })

  it('reports its cost in the forwarded log, per push and in total', () => {
    expect(
      impl.has('log(`blank ${TILE_NAMES[i] ?? i}=${r.status}/${black.length}B/${r.ms}ms`)'),
    ).toBe(true)
    expect(impl.has(/tilesblanked:.*push\(es\)/)).toBe(true)
  })
})

// ── the zOrderIndex plan ──────────────────────────────────────────────────────────────────

describe('zOrderIndex plan', () => {
  it('is unique across every container on the page (SDK: DUPLICATE_Z_ORDER_INDEX)', () => {
    const all = [
      ...Array.from({ length: TILES }, (_v, i) => tileZOrder(i)),
      Z_EVENT_LAYER,
      Z_OVERLAY,
    ]
    expect(all).toHaveLength(CONTAINER_TOTAL)
    expect(new Set(all).size).toBe(CONTAINER_TOTAL)
  })

  it('puts the overlay in front of every tile — larger renders closer to the front', () => {
    // The whole point: the four tiles cover all 576x288, so anything readable over them has to
    // be in front of all of them.
    for (let i = 0; i < TILES; i++) expect(Z_OVERLAY).toBeGreaterThan(tileZOrder(i))
    expect(Z_OVERLAY).toBeGreaterThan(Z_EVENT_LAYER)
  })

  it('uses positive integers (SDK: INVALID_Z_ORDER_INDEX)', () => {
    for (const v of [
      ...Array.from({ length: TILES }, (_v, i) => tileZOrder(i)),
      Z_EVENT_LAYER,
      Z_OVERLAY,
    ]) {
      expect(Number.isInteger(v)).toBe(true)
      expect(v).toBeGreaterThan(0)
    }
  })
})

// ── tileIndexAt — the inverse of tileOrigin ────────────────────────────────────────────────
// A pointer move re-derives only the quadrant the cursor is in and the one it just left. That
// is only correct if this really is tileOrigin's inverse: an off-by-one at a quadrant edge
// would draw the arrow twice or erase it from the wrong tile.

describe('tileIndexAt', () => {
  it('round-trips with tileOrigin for every tile', () => {
    for (let i = 0; i < TILES; i++) {
      const [x, y] = tileOrigin(i)
      expect(tileIndexAt(x, y)).toBe(i) // top-left corner
      expect(tileIndexAt(x + TILE_W - 1, y + TILE_H - 1)).toBe(i) // bottom-right corner
      expect(tileIndexAt(x + TILE_W / 2, y + TILE_H / 2)).toBe(i) // centre
    }
  })

  it('puts the quadrant boundary in the next tile, matching the origins', () => {
    expect(tileIndexAt(TILE_W - 1, 0)).toBe(0)
    expect(tileIndexAt(TILE_W, 0)).toBe(1)
    expect(tileIndexAt(0, TILE_H - 1)).toBe(0)
    expect(tileIndexAt(0, TILE_H)).toBe(2)
  })

  it('answers -1 off the panel, so a clamped-to-edge cursor never indexes a tile that is not there', () => {
    expect(tileIndexAt(-1, 0)).toBe(-1)
    expect(tileIndexAt(0, -1)).toBe(-1)
    expect(tileIndexAt(SCREEN_W, 0)).toBe(-1)
    expect(tileIndexAt(0, SCREEN_H)).toBe(-1)
  })
})

// ── cursorTilePixel — where the synthetic arrow lands in the index plane ───────────────────
// `cursor` is fractional from the first vPad drag onwards (PAD_GAIN-scaled deltas), and a store
// to a typed array at a fractional index is silently discarded: no throw, nothing written. The
// lens and the preview both ask this pure helper for the pixel, so it is pinned here.

describe('cursorTilePixel', () => {
  /** The hazard itself, demonstrated rather than described. */
  it('(the hazard) a store at a fractional index into a Uint8Array writes nothing', () => {
    const a = new Uint8Array(4)
    a[1.5] = 9
    expect(Array.from(a)).toEqual([0, 0, 0, 0])
  })

  it('returns integer coordinates for the fractional cursor a pad drag produces', () => {
    const drifted: ReadonlyArray<readonly [number, number]> = [
      [0.5, 0.5],
      [287.9, 143.1],
      [288.25, 144.75],
      [575.99, 287.99],
    ]
    for (const [x, y] of drifted) {
      const at = cursorTilePixel(x, y, tileIndexAt(x, y))
      expect(at).not.toBeNull()
      expect(Number.isInteger(at![0])).toBe(true)
      expect(Number.isInteger(at![1])).toBe(true)
    }
  })

  it('lands inside the tile tileIndexAt named, for fractional points across the whole panel', () => {
    for (let x = 0.5; x < SCREEN_W; x += 7.3) {
      for (let y = 0.5; y < SCREEN_H; y += 5.7) {
        const i = tileIndexAt(x, y)
        expect(i).toBeGreaterThanOrEqual(0)
        const at = cursorTilePixel(x, y, i)
        expect(at).not.toBeNull()
        // Inside the plane it indexes: a stamp outside these bounds is a wrong-tile write or a
        // silent no-op, and both read as "the pointer is gone".
        expect(at![0]).toBeGreaterThanOrEqual(0)
        expect(at![0]).toBeLessThan(TILE_W)
        expect(at![1]).toBeGreaterThanOrEqual(0)
        expect(at![1]).toBeLessThan(TILE_H)
      }
    }
  })

  it('is claimed by exactly one tile — the arrow is never drawn twice or dropped between two', () => {
    const pts: ReadonlyArray<readonly [number, number]> = [
      [0, 0],
      [287.6, 143.6],
      [288, 144],
      [1.2, 287.4],
      [575, 0.9],
    ]
    for (const [x, y] of pts) {
      const claims = Array.from({ length: TILES }, (_v, i) => cursorTilePixel(x, y, i)).filter(
        Boolean,
      )
      expect(claims).toHaveLength(1)
    }
  })

  it('round-trips every tile origin to its own (0, 0)', () => {
    for (let i = 0; i < TILES; i++) {
      const [ox, oy] = tileOrigin(i)
      expect(cursorTilePixel(ox, oy, i)).toEqual([0, 0])
    }
  })

  it('is null for a tile the cursor is not in, and for every tile when it is off the panel', () => {
    expect(cursorTilePixel(0, 0, 1)).toBeNull()
    for (let i = 0; i < TILES; i++) {
      expect(cursorTilePixel(SCREEN_W, SCREEN_H, i)).toBeNull()
      expect(cursorTilePixel(-1, 0, i)).toBeNull()
    }
  })
})
